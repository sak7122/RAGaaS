import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { BookOpen, ExternalLink } from "lucide-react";

const API = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";

type CitationData = {
  file_name: string;
  page: number;
  excerpt?: string;
  score?: number;
};

type ShareData = {
  question: string;
  answer: string;
  citations: CitationData[];
  created_at: string;
};

export function SharePage() {
  const shareId = window.location.pathname.replace("/share/", "").split("/")[0];
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API}/api/share/${shareId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setData)
      .catch((e) => setError(e === 404 ? "This share link has expired or doesn't exist." : "Failed to load."));
  }, [shareId]);

  return (
    <div className="share-page">
      <nav className="share-nav">
        <span className="nav-brand">RAGaaS</span>
        <a href="/" className="share-back">
          <ExternalLink size={13} /> Open app
        </a>
      </nav>

      <div className="share-body">
        {!data && !error && (
          <p className="insights-empty">Loading…</p>
        )}
        {error && (
          <div className="share-error">
            <p>{error}</p>
            <a href="/">← Go to RAGaaS</a>
          </div>
        )}
        {data && (
          <motion.div
            className="share-card"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            <div className="share-question">
              <span className="share-q-label">Question</span>
              <p>{data.question}</p>
            </div>

            <div className="share-answer">
              <span className="share-a-label">Answer</span>
              <p>{data.answer}</p>
            </div>

            {data.citations && data.citations.length > 0 && (
              <div className="share-citations">
                <span className="share-cite-label">
                  <BookOpen size={12} /> Sources
                </span>
                {data.citations.map((c, i) => (
                  <div key={i} className="share-cite-row">
                    <span className="share-cite-file">{c.file_name.replace(/_/g, " ").replace(".pdf", "")}</span>
                    <span className="share-cite-page">p.{c.page}</span>
                    {typeof c.score === "number" && (
                      <span className="share-cite-score">{Math.round(c.score * 100)}%</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="share-footer">
              <span>Answered by RAGaaS</span>
              <a href="/" className="btn-ghost">Try it yourself →</a>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
