import { App } from 'obsidian'

import { QueryProgressState } from '../../components/chat-view/QueryProgress'
import { DBManager } from '../../database/database-manager'
import { VectorManager } from '../../database/modules/vector/vector-manager'
import { SelectVector } from '../../database/schema'
import { EmbeddingModel } from '../../types/embedding'
import { InfioSettings } from '../../types/settings'

import { getEmbeddingModel } from './embedding'

export class RAGEngine {
  private app: App
  private settings: InfioSettings
  private vectorManager: VectorManager
  private embeddingModel: EmbeddingModel | null = null

  constructor(
    app: App,
    settings: InfioSettings,
    dbManager: DBManager,
  ) {
    this.app = app
    this.settings = settings
    this.vectorManager = dbManager.getVectorManager()
    this.embeddingModel = getEmbeddingModel(settings)
  }

  setSettings(settings: InfioSettings) {
    this.settings = settings
    this.embeddingModel = getEmbeddingModel(settings)
  }

  // TODO: Implement automatic vault re-indexing when settings are changed.
  // Currently, users must manually re-index the vault.
  async updateVaultIndex(
    options: { reindexAll: boolean } = {
      reindexAll: false,
    },
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void,
  ): Promise<void> {
    if (!this.embeddingModel) {
      throw new Error('Embedding model is not set')
    }
    await this.vectorManager.updateVaultIndex(
      this.embeddingModel,
      {
        chunkSize: this.settings.ragOptions.chunkSize,
        excludePatterns: this.settings.ragOptions.excludePatterns,
        includePatterns: this.settings.ragOptions.includePatterns,
        reindexAll: options.reindexAll,
      },
      (indexProgress) => {
        onQueryProgressChange?.({
          type: 'indexing',
          indexProgress,
        })
      },
    )
  }

  async processQuery({
    query,
    scope,
    onQueryProgressChange,
  }: {
    query: string
    scope?: {
      files: string[]
      folders: string[]
    }
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void
  }): Promise<
    (Omit<SelectVector, 'embedding'> & {
      similarity: number
    })[]
  > {
    if (!this.embeddingModel) {
      throw new Error('Embedding model is not set')
    }
    // TODO: Decide the vault index update strategy.
    // Current approach: Update on every query.
    await this.updateVaultIndex({ reindexAll: false }, onQueryProgressChange)
    const queryEmbedding = await this.getQueryEmbedding(query)
    onQueryProgressChange?.({
      type: 'querying',
    })
    const queryResult = await this.vectorManager.performSimilaritySearch(
      queryEmbedding,
      this.embeddingModel,
      {
        minSimilarity: this.settings.ragOptions.minSimilarity,
        limit: this.settings.ragOptions.limit,
        scope,
      },
    )
    onQueryProgressChange?.({
      type: 'querying-done',
      queryResult,
    })
    return queryResult
  }

  private async getQueryEmbedding(query: string): Promise<number[]> {
    if (!this.embeddingModel) {
      throw new Error('Embedding model is not set')
    }
    return this.embeddingModel.getEmbedding(query)
  }
}
