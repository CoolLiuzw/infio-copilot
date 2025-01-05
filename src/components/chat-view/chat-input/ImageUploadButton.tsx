import { ImageIcon } from 'lucide-react'

export function ImageUploadButton({
  onUpload,
}: {
  onUpload: (files: File[]) => void
}) {
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length > 0) {
      onUpload(files)
    }
  }

  return (
    <label className="infio-chat-user-input-submit-button">
      <input
        type="file"
        accept="image/*"
        multiple
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
      <div className="infio-chat-user-input-submit-button-icons">
        <ImageIcon size={12} />
      </div>
      <div>Image</div>
    </label>
  )
}
