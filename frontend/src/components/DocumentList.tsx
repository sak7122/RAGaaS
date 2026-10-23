import { FileText, Globe, RefreshCw, Trash2 } from "lucide-react";

export type DocumentMeta = {
  file_name: string;
  chunks: number;
  uploaded_at: string;
  // Profile for the document picker (backend/doc_profile.py); absent on old backends.
  title?: string;
  pages?: number;
  summary?: string;
  questions?: string[];
  profile_source?: "generated" | "extractive" | "";
  // Websites imported as one document: page N of the document is page_urls[N-1].
  kind?: "website";
  source_url?: string;
  page_urls?: string[];
};

/** The web page a citation points at, for website documents. */
export const pageUrl = (d: DocumentMeta | undefined, page: number) =>
  d?.kind === "website" ? d.page_urls?.[page - 1] : undefined;

export const docTitle = (d: DocumentMeta) => d.title || d.file_name;

interface DocumentListProps {
  docs: DocumentMeta[];
  onDelete: (fileName: string) => void;
  deleting: string | null;
  canManage?: boolean;
  onRefreshProfile?: (fileName: string) => void;
  onRefreshSite?: (fileName: string) => void;
  refreshing?: string | null;
}

export function DocumentList({ docs, onDelete, deleting, canManage = true, onRefreshProfile, onRefreshSite, refreshing }: DocumentListProps) {
  if (docs.length === 0) return null;

  return (
    <div className="sidebar-group">
      <span className="sidebar-label">Documents</span>
      <div className="doc-list">
        {docs.map((doc) => (
          <div key={doc.file_name} className="doc-item" title={doc.summary || doc.file_name}>
            {doc.kind === "website"
              ? <Globe size={13} color="var(--primary)" style={{ flexShrink: 0 }} aria-label="Website" />
              : <FileText size={13} color="var(--ink-48)" style={{ flexShrink: 0 }} />}
            <div className="doc-info">
              <span className="doc-name">{docTitle(doc)}</span>
              <span className="doc-meta">
                {doc.kind === "website"
                  ? `${doc.page_urls?.length ?? doc.pages ?? 0} web pages · ${new URL(doc.source_url ?? "https://x").hostname}`
                  : <>{doc.pages ? `${doc.pages} pages · ` : ""}{doc.chunks} chunks</>}
              </span>
            </div>
            {canManage && (doc.kind === "website" ? onRefreshSite : onRefreshProfile) && (
              <button
                type="button"
                className={`doc-delete doc-refresh${refreshing === doc.file_name ? " is-busy" : ""}`}
                onClick={() => (doc.kind === "website" ? onRefreshSite : onRefreshProfile)?.(doc.file_name)}
                disabled={refreshing === doc.file_name}
                aria-label={doc.kind === "website" ? `Re-read the website ${docTitle(doc)}` : `Refresh the summary and questions for ${docTitle(doc)}`}
                title={doc.kind === "website" ? "Re-read the site for changes" : "Refresh summary and questions"}
              >
                <RefreshCw size={12} />
              </button>
            )}
            <button
              type="button"
              className="doc-delete"
              onClick={() => onDelete(doc.file_name)}
              disabled={deleting === doc.file_name}
              aria-label={`Delete ${docTitle(doc)}`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
