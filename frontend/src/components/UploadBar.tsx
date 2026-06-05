import { FileUp } from "lucide-react";

interface UploadBarProps {
  onUpload: (file: File) => void;
  status: string;
  statusType: "idle" | "uploading" | "success" | "error";
  progress: number; // 0-100
}

export function UploadBar({ onUpload, status, statusType, progress }: UploadBarProps) {
  const uploading = statusType === "uploading";

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      onUpload(file);
      e.target.value = "";
    }
  }

  const statusClass =
    statusType === "success" ? "success" :
    statusType === "error"   ? "error"   : "";

  return (
    <div className="upload-bar">
      <FileUp size={16} color="var(--ink-48)" />

      <label
        htmlFor="pdf-upload"
        className={`btn-upload${uploading ? " uploading" : ""}`}
        aria-disabled={uploading}
      >
        {uploading ? `Uploading… ${progress}%` : "Upload PDF"}
      </label>
      <input
        id="pdf-upload"
        type="file"
        accept="application/pdf"
        disabled={uploading}
        onChange={handleChange}
        style={{ display: "none" }}
      />

      {uploading && (
        <div className="upload-progress-track">
          <div className="upload-progress-fill" style={{ width: `${progress}%` }} />
        </div>
      )}

      {status && !uploading && (
        <span className={`upload-status ${statusClass}`}>{status}</span>
      )}
    </div>
  );
}
