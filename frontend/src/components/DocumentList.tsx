import { FileText, Trash2 } from "lucide-react";

export type DocumentMeta = {
  file_name: string;
  chunks: number;
  uploaded_at: string;
};

interface DocumentListProps {
  docs: DocumentMeta[];
  onDelete: (fileName: string) => void;
  deleting: string | null;
}

export function DocumentList({ docs, onDelete, deleting }: DocumentListProps) {
  if (docs.length === 0) return null;

  return (
    <div className="sidebar-group">
      <span className="sidebar-label">Documents</span>
      <div className="doc-list">
        {docs.map((doc) => (
          <div key={doc.file_name} className="doc-item">
            <FileText size={13} color="var(--ink-48)" style={{ flexShrink: 0 }} />
            <div className="doc-info">
              <span className="doc-name">{doc.file_name}</span>
              <span className="doc-meta">{doc.chunks} chunks</span>
            </div>
            <button
              type="button"
              className="doc-delete"
              onClick={() => onDelete(doc.file_name)}
              disabled={deleting === doc.file_name}
              aria-label={`Delete ${doc.file_name}`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
