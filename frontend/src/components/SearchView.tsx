// Search mode: find the pages that mention something, instead of getting an answer.
// Ranked pages with highlighted snippets, a per-document filter, and a way to jump
// back to Ask with that document picked.
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ChevronDown, FileText, Search, Sparkles } from "lucide-react";
import { DocumentMeta, docTitle } from "./DocumentList";
import "./search.css";

export type SearchHit = { file_name: string; title: string; page: number; snippet: string; passage: string };
export type SearchResponse = {
  results: SearchHit[];
  documents: { file_name: string; title: string; count: number }[];
  total: number;
  next_page_token: string | null;
  corrected_query: string | null;
  engine: string;
  latency_ms: number;
};

const EASE = [0.23, 1, 0.32, 1] as const;
const ENTITIES: Record<string, string> = { "&quot;": '"', "&#39;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
const decode = (s: string) => s.replace(/&(quot|#39|amp|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m);

/** Snippets mark matches with <b>; render only that, as <mark>, and nothing else as HTML. */
export function Snippet({ html }: { html: string }) {
  const clean = html.replace(/<(?!\/?b>)[^>]*>/gi, "");
  const parts = clean.split(/(<b>|<\/b>)/i);
  const out: ReactNode[] = [];
  let bold = false;
  parts.forEach((p, i) => {
    if (/^<b>$/i.test(p)) { bold = true; return; }
    if (/^<\/b>$/i.test(p)) { bold = false; return; }
    if (p) out.push(bold ? <mark key={i}>{decode(p)}</mark> : <span key={i}>{decode(p)}</span>);
  });
  return <>{out}</>;
}

export function SearchView({ search, docs, onAskAbout }: {
  search: (query: string, files: string[], pageToken?: string | null) => Promise<SearchResponse | null>;
  docs: DocumentMeta[];
  onAskAbout: (query: string, file: string) => void;
}) {
  const [q, setQ] = useState("");
  const [ran, setRan] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  async function run(query: string, pick: string[], more = false) {
    if (!query.trim()) return;
    setBusy(true); setError("");
    try {
      const r = await search(query.trim(), pick, more ? data?.next_page_token : null);
      if (!r) { setError("Search isn't available right now. Try again in a moment."); return; }
      setRan(query.trim());
      setData(more && data ? { ...r, results: [...data.results, ...r.results], documents: data.documents } : r);
      if (!more) setOpen(null);
    } finally { setBusy(false); }
  }
  function submit(e: FormEvent) { e.preventDefault(); setFiles([]); run(q, []); }
  function toggleFile(f: string) {
    const next = files.includes(f) ? files.filter((x) => x !== f) : [f];
    setFiles(next);
    run(ran || q, next);
  }

  const examples = docs.slice(0, 3).map((d) => docTitle(d));
  return (
    <div className="sv">
      <form className="sv-bar" onSubmit={submit} role="search">
        <Search size={17} aria-hidden="true" />
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search every page of your documents"
          aria-label="Search your documents" maxLength={500} />
        <button type="submit" disabled={busy || !q.trim()}>{busy ? "Searching…" : "Search"}</button>
      </form>

      <div className="sv-body">
        {!data && !busy && (
          <motion.div className="sv-empty" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { ease: EASE } }}>
            <p className="sv-eyebrow">Search</p>
            <h2>Find the exact page, not just an answer.</h2>
            <p>Results are ranked pages from {docs.length ? `your ${docs.length} document${docs.length === 1 ? "" : "s"}` : "your documents"}, with the matching words highlighted.{examples.length ? ` Try a term from ${examples.join(", ")}.` : ""}</p>
          </motion.div>
        )}

        {error && <p className="sv-error" role="status">{error}</p>}

        {data && (
          <>
            <div className="sv-meta" aria-live="polite">
              <span>{data.total.toLocaleString()} page{data.total === 1 ? "" : "s"} for “{ran}”</span>
              {data.corrected_query && <span> · showing results for <b>{data.corrected_query}</b></span>}
              <span className="sv-engine">{data.latency_ms} ms · {data.engine}</span>
            </div>
            {data.documents.length > 1 && (
              <div className="sv-docs" role="group" aria-label="Filter by document">
                <button type="button" aria-pressed={files.length === 0} onClick={() => { setFiles([]); run(ran, []); }}>All documents</button>
                {data.documents.map((d) => (
                  <button key={d.file_name} type="button" aria-pressed={files.includes(d.file_name)} onClick={() => toggleFile(d.file_name)}>
                    <FileText size={12} aria-hidden="true" />{d.title}<span>{d.count}</span>
                  </button>
                ))}
              </div>
            )}
            {data.results.length === 0 ? (
              <p className="sv-none">Nothing matched. Try fewer or different words, or ask it as a question in Ask.</p>
            ) : (
              <ol className="sv-results">
                <AnimatePresence initial={false}>
                  {data.results.map((r, i) => {
                    const key = `${r.file_name}#${r.page}#${i}`;
                    const isOpen = open === key;
                    return (
                      <motion.li key={key} className={isOpen ? "is-open" : ""}
                        initial={{ opacity: 0, transform: "translateY(8px)" }}
                        animate={{ opacity: 1, transform: "translateY(0px)", transition: { duration: 0.3, ease: EASE, delay: Math.min(i, 8) * 0.04 } }}>
                        <button type="button" className="sv-hit" onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}>
                          <span className="sv-where"><FileText size={13} aria-hidden="true" />{r.title}<span className="sv-page">p. {r.page}</span></span>
                          <span className="sv-snip"><Snippet html={r.snippet || r.passage} /></span>
                          <ChevronDown size={15} className="sv-chev" aria-hidden="true" />
                        </button>
                        <AnimatePresence>
                          {isOpen && (
                            <motion.div className="sv-more" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                              {r.passage && <blockquote>{r.passage}</blockquote>}
                              <button type="button" className="sv-ask" onClick={() => onAskAbout(ran, r.file_name)}>
                                <Sparkles size={13} aria-hidden="true" /> Ask about this in {r.title} <ArrowRight size={13} aria-hidden="true" />
                              </button>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ol>
            )}
            {data.next_page_token && (
              <button type="button" className="sv-more-btn" disabled={busy} onClick={() => run(ran, files, true)}>
                {busy ? "Loading…" : "More results"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
