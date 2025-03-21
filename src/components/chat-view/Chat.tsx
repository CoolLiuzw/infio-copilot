import { useMutation } from '@tanstack/react-query'
import { CircleStop, History, Plus } from 'lucide-react'
import { App, Notice } from 'obsidian'
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react'
import { v4 as uuidv4 } from 'uuid'

import { ApplyViewState } from '../../ApplyView'
import { APPLY_VIEW_TYPE } from '../../constants'
import { useApp } from '../../contexts/AppContext'
import { useLLM } from '../../contexts/LLMContext'
import { useRAG } from '../../contexts/RAGContext'
import { useSettings } from '../../contexts/SettingsContext'
import {
	LLMAPIKeyInvalidException,
	LLMAPIKeyNotSetException,
	LLMBaseUrlNotSetException,
	LLMModelNotSetException,
} from '../../core/llm/exception'
import { useChatHistory } from '../../hooks/use-chat-history'
import { ChatMessage, ChatUserMessage } from '../../types/chat'
import {
	MentionableBlock,
	MentionableBlockData,
	MentionableCurrentFile,
} from '../../types/mentionable'
import { manualApplyChangesToFile } from '../../utils/apply'
import {
	getMentionableKey,
	serializeMentionable,
} from '../../utils/mentionable'
import { readTFileContent } from '../../utils/obsidian'
import { openSettingsModalWithError } from '../../utils/open-settings-modal'
import { PromptGenerator } from '../../utils/prompt-generator'

import AssistantMessageActions from './AssistantMessageActions'
import PromptInputWithActions, { ChatUserInputRef } from './chat-input/PromptInputWithActions'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { ChatHistory } from './ChatHistory'
import MarkdownReasoningBlock from './MarkdownReasoningBlock'
import QueryProgress, { QueryProgressState } from './QueryProgress'
import ReactMarkdown from './ReactMarkdown'
import ShortcutInfo from './ShortcutInfo'
import SimilaritySearchResults from './SimilaritySearchResults'

// Add an empty line here
const getNewInputMessage = (app: App): ChatUserMessage => {
	return {
		role: 'user',
		content: null,
		promptContent: null,
		id: uuidv4(),
		mentionables: [
			{
				type: 'current-file',
				file: app.workspace.getActiveFile(),
			},
		],
	}
}

export type ChatRef = {
	openNewChat: (selectedBlock?: MentionableBlockData) => void
	addSelectionToChat: (selectedBlock: MentionableBlockData) => void
	focusMessage: () => void
}

export type ChatProps = {
	selectedBlock?: MentionableBlockData
}

const Chat = forwardRef<ChatRef, ChatProps>((props, ref) => {
	const app = useApp()
	const { settings } = useSettings()
	const { getRAGEngine } = useRAG()

	const {
		createOrUpdateConversation,
		deleteConversation,
		getChatMessagesById,
		updateConversationTitle,
		chatList,
	} = useChatHistory()
	const { streamResponse, chatModel } = useLLM()

	const promptGenerator = useMemo(() => {
		return new PromptGenerator(getRAGEngine, app, settings)
	}, [getRAGEngine, app, settings])

	const [inputMessage, setInputMessage] = useState<ChatUserMessage>(() => {
		const newMessage = getNewInputMessage(app)
		if (props.selectedBlock) {
			newMessage.mentionables = [
				...newMessage.mentionables,
				{
					type: 'block',
					...props.selectedBlock,
				},
			]
		}
		return newMessage
	})
	const [addedBlockKey, setAddedBlockKey] = useState<string | null>(
		props.selectedBlock
			? getMentionableKey(
				serializeMentionable({
					type: 'block',
					...props.selectedBlock,
				}),
			)
			: null,
	)
	const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
	const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null)
	const [currentConversationId, setCurrentConversationId] =
		useState<string>(uuidv4())
	const [queryProgress, setQueryProgress] = useState<QueryProgressState>({
		type: 'idle',
	})

	const preventAutoScrollRef = useRef(false)
	const lastProgrammaticScrollRef = useRef<number>(0)
	const activeStreamAbortControllersRef = useRef<AbortController[]>([])
	const chatUserInputRefs = useRef<Map<string, ChatUserInputRef>>(new Map())
	const chatMessagesRef = useRef<HTMLDivElement>(null)
	const registerChatUserInputRef = (
		id: string,
		ref: ChatUserInputRef | null,
	) => {
		if (ref) {
			chatUserInputRefs.current.set(id, ref)
		} else {
			chatUserInputRefs.current.delete(id)
		}
	}

	useEffect(() => {
		const scrollContainer = chatMessagesRef.current
		if (!scrollContainer) return

		const handleScroll = () => {
			// If the scroll event happened very close to our programmatic scroll, ignore it
			if (Date.now() - lastProgrammaticScrollRef.current < 50) {
				return
			}

			preventAutoScrollRef.current =
				scrollContainer.scrollHeight -
				scrollContainer.scrollTop -
				scrollContainer.clientHeight >
				20
		}

		scrollContainer.addEventListener('scroll', handleScroll)
		return () => scrollContainer.removeEventListener('scroll', handleScroll)
	}, [chatMessages])

	const handleScrollToBottom = () => {
		if (chatMessagesRef.current) {
			const scrollContainer = chatMessagesRef.current
			if (scrollContainer.scrollTop !== scrollContainer.scrollHeight) {
				lastProgrammaticScrollRef.current = Date.now()
				scrollContainer.scrollTop = scrollContainer.scrollHeight
			}
		}
	}

	const abortActiveStreams = () => {
		for (const abortController of activeStreamAbortControllersRef.current) {
			abortController.abort()
		}
		activeStreamAbortControllersRef.current = []
	}

	const handleLoadConversation = async (conversationId: string) => {
		try {
			abortActiveStreams()
			const conversation = await getChatMessagesById(conversationId)
			if (!conversation) {
				throw new Error('Conversation not found')
			}
			setCurrentConversationId(conversationId)
			setChatMessages(conversation)
			const newInputMessage = getNewInputMessage(app)
			setInputMessage(newInputMessage)
			setFocusedMessageId(newInputMessage.id)
			setQueryProgress({
				type: 'idle',
			})
		} catch (error) {
			new Notice('Failed to load conversation')
			console.error('Failed to load conversation', error)
		}
	}

	const handleNewChat = (selectedBlock?: MentionableBlockData) => {
		setCurrentConversationId(uuidv4())
		setChatMessages([])
		const newInputMessage = getNewInputMessage(app)
		if (selectedBlock) {
			const mentionableBlock: MentionableBlock = {
				type: 'block',
				...selectedBlock,
			}
			newInputMessage.mentionables = [
				...newInputMessage.mentionables,
				mentionableBlock,
			]
			setAddedBlockKey(
				getMentionableKey(serializeMentionable(mentionableBlock)),
			)
		}
		setInputMessage(newInputMessage)
		setFocusedMessageId(newInputMessage.id)
		setQueryProgress({
			type: 'idle',
		})
		abortActiveStreams()
	}

	const submitMutation = useMutation({
		mutationFn: async ({
			newChatHistory,
			useVaultSearch,
		}: {
			newChatHistory: ChatMessage[]
			useVaultSearch?: boolean
		}) => {
			abortActiveStreams()
			setQueryProgress({
				type: 'idle',
			})

			const responseMessageId = uuidv4()
			setChatMessages([
				...newChatHistory,
				{
					role: 'assistant',
					content: '',
					reasoningContent: '',
					id: responseMessageId,
					metadata: {
						usage: undefined,
						model: undefined,
					},
				},
			])

			try {
				const abortController = new AbortController()
				activeStreamAbortControllersRef.current.push(abortController)

				const { requestMessages, compiledMessages } =
					await promptGenerator.generateRequestMessages({
						messages: newChatHistory,
						useVaultSearch,
						onQueryProgressChange: setQueryProgress,
					})
				setQueryProgress({
					type: 'idle',
				})

				setChatMessages([
					...compiledMessages,
					{
						role: 'assistant',
						content: '',
						reasoningContent: '',
						id: responseMessageId,
						metadata: {
							usage: undefined,
							model: undefined,
						},
					},
				])
				const stream = await streamResponse(
					chatModel,
					{
						model: chatModel.modelId,
						messages: requestMessages,
						stream: true,
					},
					{
						signal: abortController.signal,
					},
				)

				for await (const chunk of stream) {
					const content = chunk.choices[0]?.delta?.content ?? ''
					const reasoning_content = chunk.choices[0]?.delta?.reasoning_content ?? ''
					setChatMessages((prevChatHistory) =>
						prevChatHistory.map((message) =>
							message.role === 'assistant' && message.id === responseMessageId
								? {
									...message,
									content: message.content + content,
									reasoningContent: message.reasoningContent + reasoning_content,
									metadata: {
										...message.metadata,
										usage: chunk.usage ?? message.metadata?.usage, // Keep existing usage if chunk has no usage data
										model: chatModel,
									},
								}
								: message,
						),
					)
					if (!preventAutoScrollRef.current) {
						handleScrollToBottom()
					}
				}
			} catch (error) {
				if (error.name === 'AbortError') {
					return
				} else {
					throw error
				}
			}
		},
		onError: (error) => {
			setQueryProgress({
				type: 'idle',
			})
			if (
				error instanceof LLMAPIKeyNotSetException ||
				error instanceof LLMAPIKeyInvalidException ||
				error instanceof LLMBaseUrlNotSetException ||
				error instanceof LLMModelNotSetException
			) {
				openSettingsModalWithError(app, error.message)
			} else {
				new Notice(error.message)
				console.error('Failed to generate response', error)
			}
		},
	})

	const handleSubmit = (
		newChatHistory: ChatMessage[],
		useVaultSearch?: boolean,
	) => {
		submitMutation.mutate({ newChatHistory, useVaultSearch })
	}

	const applyMutation = useMutation({
		mutationFn: async ({
			blockInfo,
		}: {
			blockInfo: {
				content: string
				filename?: string
				startLine?: number
				endLine?: number
			}
		}) => {
			const activeFile = app.workspace.getActiveFile()
			if (!activeFile) {
				throw new Error(
					'No file is currently open to apply changes. Please open a file and try again.',
				)
			}
			const activeFileContent = await readTFileContent(activeFile, app.vault)

			const updatedFileContent = await manualApplyChangesToFile(
				blockInfo.content,
				activeFile,
				activeFileContent,
				blockInfo.startLine,
				blockInfo.endLine
			)
			if (!updatedFileContent) {
				throw new Error('Failed to apply changes')
			}

			await app.workspace.getLeaf(true).setViewState({
				type: APPLY_VIEW_TYPE,
				active: true,
				state: {
					file: activeFile,
					originalContent: activeFileContent,
					newContent: updatedFileContent,
				} satisfies ApplyViewState,
			})
		},
		onError: (error) => {
			if (
				error instanceof LLMAPIKeyNotSetException ||
				error instanceof LLMAPIKeyInvalidException ||
				error instanceof LLMBaseUrlNotSetException ||
				error instanceof LLMModelNotSetException
			) {
				openSettingsModalWithError(app, error.message)
			} else {
				new Notice(error.message)
				console.error('Failed to apply changes', error)
			}
		},
	})

	const handleApply = useCallback(
		(blockInfo: {
			content: string
			filename?: string
			startLine?: number
			endLine?: number
		}) => {
			applyMutation.mutate({ blockInfo })
		},
		[applyMutation],
	)

	useEffect(() => {
		setFocusedMessageId(inputMessage.id)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// 
	useEffect(() => {
		const updateConversationAsync = async () => {
			try {
				if (chatMessages.length > 0) {
					createOrUpdateConversation(currentConversationId, chatMessages)
				}
			} catch (error) {
				new Notice('Failed to save chat history')
				console.error('Failed to save chat history', error)
			}
		}
		updateConversationAsync()
	}, [currentConversationId, chatMessages, createOrUpdateConversation])

	// Updates the currentFile of the focused message (input or chat history)
	// This happens when active file changes or focused message changes
	const handleActiveLeafChange = useCallback(() => {
		const activeFile = app.workspace.getActiveFile()
		if (!activeFile) return

		const mentionable: Omit<MentionableCurrentFile, 'id'> = {
			type: 'current-file',
			file: activeFile,
		}

		if (!focusedMessageId) return
		if (inputMessage.id === focusedMessageId) {
			setInputMessage((prevInputMessage) => ({
				...prevInputMessage,
				mentionables: [
					mentionable,
					...prevInputMessage.mentionables.filter(
						(mentionable) => mentionable.type !== 'current-file',
					),
				],
			}))
		} else {
			setChatMessages((prevChatHistory) =>
				prevChatHistory.map((message) =>
					message.id === focusedMessageId && message.role === 'user'
						? {
							...message,
							mentionables: [
								mentionable,
								...message.mentionables.filter(
									(mentionable) => mentionable.type !== 'current-file',
								),
							],
						}
						: message,
				),
			)
		}
	}, [app.workspace, focusedMessageId, inputMessage.id])

	useEffect(() => {
		app.workspace.on('active-leaf-change', handleActiveLeafChange)
		return () => {
			app.workspace.off('active-leaf-change', handleActiveLeafChange)
		}
	}, [app.workspace, handleActiveLeafChange])

	useImperativeHandle(ref, () => ({
		openNewChat: (selectedBlock?: MentionableBlockData) =>
			handleNewChat(selectedBlock),
		addSelectionToChat: (selectedBlock: MentionableBlockData) => {
			const mentionable: Omit<MentionableBlock, 'id'> = {
				type: 'block',
				...selectedBlock,
			}

			setAddedBlockKey(getMentionableKey(serializeMentionable(mentionable)))

			if (focusedMessageId === inputMessage.id) {
				setInputMessage((prevInputMessage) => {
					const mentionableKey = getMentionableKey(
						serializeMentionable(mentionable),
					)
					// Check if mentionable already exists
					if (
						prevInputMessage.mentionables.some(
							(m) =>
								getMentionableKey(serializeMentionable(m)) === mentionableKey,
						)
					) {
						return prevInputMessage
					}
					return {
						...prevInputMessage,
						mentionables: [...prevInputMessage.mentionables, mentionable],
					}
				})
			} else {
				setChatMessages((prevChatHistory) =>
					prevChatHistory.map((message) => {
						if (message.id === focusedMessageId && message.role === 'user') {
							const mentionableKey = getMentionableKey(
								serializeMentionable(mentionable),
							)
							// Check if mentionable already exists
							if (
								message.mentionables.some(
									(m) =>
										getMentionableKey(serializeMentionable(m)) ===
										mentionableKey,
								)
							) {
								return message
							}
							return {
								...message,
								mentionables: [...message.mentionables, mentionable],
							}
						}
						return message
					}),
				)
			}
		},
		focusMessage: () => {
			if (!focusedMessageId) return
			chatUserInputRefs.current.get(focusedMessageId)?.focus()
		},
	}))

	return (
		<div className="infio-chat-container">
			<div className="infio-chat-header">
				<h1 className="infio-chat-header-title"> CHAT </h1>
				<div className="infio-chat-header-buttons">
					<button
						onClick={() => handleNewChat()}
						className="infio-chat-list-dropdown"
					>
						<Plus size={18} />
					</button>
					<ChatHistory
						chatList={chatList}
						currentConversationId={currentConversationId}
						onSelect={async (conversationId) => {
							if (conversationId === currentConversationId) return
							await handleLoadConversation(conversationId)
						}}
						onDelete={async (conversationId) => {
							await deleteConversation(conversationId)
							if (conversationId === currentConversationId) {
								const nextConversation = chatList.find(
									(chat) => chat.id !== conversationId,
								)
								if (nextConversation) {
									void handleLoadConversation(nextConversation.id)
								} else {
									handleNewChat()
								}
							}
						}}
						onUpdateTitle={async (conversationId, newTitle) => {
							await updateConversationTitle(conversationId, newTitle)
						}}
						className="infio-chat-list-dropdown"
					>
						<History size={18} />
					</ChatHistory>
				</div>
			</div>
			<div className="infio-chat-messages" ref={chatMessagesRef}>
				{
					// If the chat is empty, show a message to start a new chat
					chatMessages.length === 0 && (
						<div className="infio-chat-empty-state">
							<ShortcutInfo />
						</div>
					)
				}
				{chatMessages.map((message, index) =>
					message.role === 'user' ? (
						<div key={message.id} className="infio-chat-messages-user">
							<PromptInputWithActions
								ref={(ref) => registerChatUserInputRef(message.id, ref)}
								initialSerializedEditorState={message.content}
								onSubmit={(content, useVaultSearch) => {
									if (editorStateToPlainText(content).trim() === '') return
									handleSubmit(
										[
											...chatMessages.slice(0, index),
											{
												role: 'user',
												content: content,
												promptContent: null,
												id: message.id,
												mentionables: message.mentionables,
											},
										],
										useVaultSearch,
									)
									chatUserInputRefs.current.get(inputMessage.id)?.focus()
								}}
								onFocus={() => {
									setFocusedMessageId(message.id)
								}}
								mentionables={message.mentionables}
								setMentionables={(mentionables) => {
									setChatMessages((prevChatHistory) =>
										prevChatHistory.map((msg) =>
											msg.id === message.id ? { ...msg, mentionables } : msg,
										),
									)
								}}
							/>
							{message.similaritySearchResults && (
								<SimilaritySearchResults
									similaritySearchResults={message.similaritySearchResults}
								/>
							)}
						</div>
					) : (
						<div key={message.id} className="infio-chat-messages-assistant">
							<MarkdownReasoningBlock reasoningContent={message.reasoningContent} />
							<ReactMarkdownItem
								handleApply={handleApply}
								isApplying={applyMutation.isPending}
							>
								{message.content}
							</ReactMarkdownItem>
							{message.content && <AssistantMessageActions message={message} />}
						</div>
					),
				)}
				<QueryProgress state={queryProgress} />
				{submitMutation.isPending && (
					<button onClick={abortActiveStreams} className="infio-stop-gen-btn">
						<CircleStop size={16} />
						<div>Stop generation</div>
					</button>
				)}
			</div>
			<PromptInputWithActions
				key={inputMessage.id}
				ref={(ref) => registerChatUserInputRef(inputMessage.id, ref)}
				initialSerializedEditorState={inputMessage.content}
				onSubmit={(content, useVaultSearch) => {
					if (editorStateToPlainText(content).trim() === '') return
					handleSubmit(
						[...chatMessages, { ...inputMessage, content }],
						useVaultSearch,
					)
					setInputMessage(getNewInputMessage(app))
					preventAutoScrollRef.current = false
					handleScrollToBottom()
				}}
				onFocus={() => {
					setFocusedMessageId(inputMessage.id)
				}}
				mentionables={inputMessage.mentionables}
				setMentionables={(mentionables) => {
					setInputMessage((prevInputMessage) => ({
						...prevInputMessage,
						mentionables,
					}))
				}}
				autoFocus
				addedBlockKey={addedBlockKey}
			/>
		</div>
	)
})

function ReactMarkdownItem({
	handleApply,
	isApplying,
	children,
}: {
	handleApply: (blockInfo: {
		content: string
		filename?: string
		startLine?: number
		endLine?: number
	}) => void
	isApplying: boolean
	children: string
}) {
	return (
		<ReactMarkdown onApply={handleApply} isApplying={isApplying}>
			{children}
		</ReactMarkdown>
	)
}

Chat.displayName = 'Chat'

export default Chat
