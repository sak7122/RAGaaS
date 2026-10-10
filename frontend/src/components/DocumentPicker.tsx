import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Check, Search, X } from "lucide-react";
import { DocumentMeta, docTitle } from "./DocumentList";
import "./documentPicker.css";

// Choose which indexed documents a question searches. Each card shows the document's
// summary and the questions it can answer (backend/doc_profile.py); asking one of
// those questions picks the document and sends it straight away.

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

export const fileType = (fileName: string) => (/\.docx$/i.test(fileName) ? "docx" : "pdf");

function relDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((Date.now() - d.getTime()) / 864e5);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

interface DocumentPickerProps {
  open: boolean;
  docs: DocumentMeta[];
  selected: string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
  onAsk: (question: string, fileName: string) => void;
}

export function DocumentPicker({ open, docs, selected, onChange, onClose, onAsk }: DocumentPickerProps) {
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const picked = useMemo(() => new Set(selected), [selected]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    if (window.matchMedia("(pointer: fine)").matches) filterRef.current?.focus({ preventScroll: true });
  }, [open]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) =>
      [docTitle(d), d.file_name, d.summary ?? "", ...(d.questions ?? [])].join(" ").toLowerCase().includes(q));
  }, [docs, filter]);

  const toggle = (f: string) => onChange(picked.has(f) ? selected.filter((x) => x !== f) : [...selected, f]);
  const n = selected.length;

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          key="picker"
          className="dpick"
          role="dialog"
          aria-modal="false"
          aria-labelledby="dpick-title"
          onKeyDown={onKeyDown}
          initial={{ opacity: 0, transform: "translateY(-8px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)", transition: { duration: 0.24, ease: EASE_OUT } }}
          exit={{ opacity: 0, transform: "translateY(-6px)", transition: { duration: 0.15, ease: EASE_OUT } }}
        >
          <div className="dpick-head">
            <div className="dpick-titlerow">
              <h3 id="dpick-title" className="dpick-title">Choose documents to search</h3>
              <span className="dpick-count" aria-live="polite">
                {n ? `${n} of ${docs.length} selected` : `${docs.length} documents`}
              </span>
              <button type="button" className="dpick-close" onClick={onClose} aria-label="Close document picker">
                <X size={15} />
              </button>
            </div>
            <div className="dpick-tools">
              <label className="dpick-filter">
                <Search size={14} aria-hidden="true" />
                <span className="sr-only">Filter documents</span>
                <input
                  ref={filterRef}
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter by name, summary or question"
                  autoComplete="off"
                />
              </label>
              <button type="button" className="dpick-link"
                onClick={() => onChange([...new Set([...selected, ...shown.map((d) => d.file_name)])])}>
                Select all
              </button>
              <button type="button" className="dpick-link" onClick={() => onChange([])}>Clear</button>
            </div>
          </div>

          <div className="dpick-grid">
            {shown.map((d, i) => {
              const on = picked.has(d.file_name);
              const qs = d.questions ?? [];
              const t = fileType(d.file_name);
              const meta = [d.pages ? `${d.pages} page${d.pages === 1 ? "" : "s"}` : "", relDate(d.uploaded_at) && `updated ${relDate(d.uploaded_at)}`]
                .filter(Boolean).join(" · ");
              return (
                <motion.article
                  key={d.file_name}
                  className={`dcard${on ? " is-on" : ""}`}
                  initial={{ opacity: 0, transform: "translateY(8px)" }}
                  animate={{ opacity: 1, transform: "translateY(0px)" }}
                  transition={{ duration: 0.32, ease: EASE_OUT, delay: Math.min(i, 12) * 0.025 }}
                >
                  <button
                    type="button"
                    className="dcard-hit"
                    aria-pressed={on}
                    aria-label={`${docTitle(d)}${d.summary ? `: ${d.summary}` : ""}`}
                    onClick={() => toggle(d.file_name)}
                  />
                  <div className="dcard-top">
                    <span className={`ftype ft-${t}`} aria-hidden="true">{t.toUpperCase()}</span>
                    <div className="dcard-name">
                      <p className="dname">{docTitle(d)}</p>
                      {meta && <p className="dmeta">{meta}</p>}
                    </div>
                  </div>
                  {d.summary && <p className="dsum">{d.summary}</p>}
                  {qs.length > 0 && (
                    <div className="dqs">
                      <span className="dqs-label">It can answer</span>
                      {qs.slice(0, 2).map((q) => (
                        <button key={q} type="button" className="dq" aria-label={`Ask ${docTitle(d)}: ${q}`}
                          onClick={() => onAsk(q, d.file_name)}>
                          <span>{q}</span>
                          <ArrowRight size={12} aria-hidden="true" />
                        </button>
                      ))}
                      {qs.length > 2 && (
                        <span className="dmore">+{qs.length - 2} more question{qs.length - 2 === 1 ? "" : "s"}</span>
                      )}
                    </div>
                  )}
                  <span className="dcheck" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>
                </motion.article>
              );
            })}
            {shown.length === 0 && <p className="dpick-empty">No documents match that filter.</p>}
          </div>

          <div className="dpick-foot">
            <p className="dpick-note">
              {n
                ? `Questions will only search ${n === 1 ? "this document" : `these ${n} documents`}.`
                : "Nothing selected searches every document you can read."}
            </p>
            <button type="button" className="dpick-done" onClick={onClose}>
              {n ? `Search ${n} document${n === 1 ? "" : "s"}` : "Search all documents"}
            </button>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
