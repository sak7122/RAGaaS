// Renders an answer as rich Markdown: headings, lists, tables, code with copy,
// LaTeX math (KaTeX), and inline citations like "(Handbook.pdf p.22)" turned into
// chips that open the source passage. While an answer streams in, text is revealed
// at a steady pace so it reads like typing instead of jumping in chunks.
import { ReactNode, memo, useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Check, Copy, FileText } from "lucide-react";
import "./answer.css";

const EXT = "pdf|docx|xlsx|csv|pptx|md|txt|html?|png|jpe?g|webp|m4a|mp3|wav|webm|ogg";
// "(file.pdf p.22)", "(file.pdf, p. 22)", "(file.pdf p.22; other.docx p.3)"
// Pages may be ranges ("p.22-23"); the chip opens the first page.
const PAGE = "p\\.?\\s*\\d+(?:\\s*[-–]\\s*\\d+)?";
const CITE_GROUP = new RegExp(`\\(((?:[^()]*?\\.(?:${EXT})[,\\s]*${PAGE}[;,\\s]*)+)\\)`, "gi");
const CITE_ONE = new RegExp(`([^();,]*?\\.(?:${EXT}))[,\\s]*p\\.?\\s*(\\d+)(?:\\s*[-–]\\s*(\\d+))?`, "gi");

/** Turn plain-text citations into links with a private cite: scheme. */
export function linkCitations(md: string): string {
  return md.replace(CITE_GROUP, (_all, inner: string) => {
    const parts: string[] = [];
    let m: RegExpExecArray | null;
    CITE_ONE.lastIndex = 0;
    while ((m = CITE_ONE.exec(inner))) {
      const file = m[1].trim();
      const pages = m[3] ? `${m[2]}-${m[3]}` : m[2];
      parts.push(`[${file}|${pages}](cite:${encodeURIComponent(file)}/${pages})`);
    }
    return parts.length ? ` ${parts.join(" ")}` : _all;
  });
}

/** Model output often uses \( \) and \[ \] for math; remark-math wants $ and $$. */
function normalizeMath(md: string): string {
  return md
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, x) => `\n$$${x}$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, x) => `$${x}$`);
}

function CodeBlock({ lang, children }: { lang: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLElement>(null);
  return (
    <div className="am-code">
      <div className="am-code-bar">
        <span>{lang || "text"}</span>
        <button type="button" onClick={() => {
          navigator.clipboard.writeText(ref.current?.innerText ?? "").then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }} aria-label="Copy code">
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code ref={ref}>{children}</code></pre>
    </div>
  );
}

const shortName = (file: string) => file.replace(/\.(pdf|docx|xlsx|csv|pptx|md|txt|html?)$/i, "").replace(/[_-]+/g, " ");

export const AnswerMarkdown = memo(function AnswerMarkdown({ text, onCite, titleFor }: {
  text: string;
  onCite?: (file: string, page: number) => void;
  titleFor?: (file: string) => string;
}) {
  return (
    <div className="am">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        urlTransform={(url) => (url.startsWith("cite:") ? url : defaultUrlTransform(url))}
        components={{
          a({ href, children }) {
            if (href?.startsWith("cite:")) {
              const [file, pages] = href.slice(5).split("/");
              const name = decodeURIComponent(file);
              const label = titleFor ? titleFor(name) : shortName(name);
              const first = Number(pages.split("-")[0]);
              const shown = pages.replace("-", "–");
              return (
                <button type="button" className="am-cite" onClick={() => onCite?.(name, first)}
                  title={`${name}, page ${shown}`} aria-label={`Source: ${label}, page ${shown}`}>
                  <FileText size={11} aria-hidden="true" /><span className="am-cite-t">{label}</span><span className="am-cite-p">p.{shown}</span>
                </button>
              );
            }
            return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
          },
          table({ children }) {
            return <div className="am-table"><table>{children}</table></div>;
          },
          code({ className, children }) {
            const lang = /language-(\w+)/.exec(className || "")?.[1];
            const block = !!lang || String(children).includes("\n");
            return block ? <CodeBlock lang={lang ?? ""}>{children}</CodeBlock> : <code className="am-ic">{children}</code>;
          },
          pre({ children }) { return <>{children}</>; },
        }}
      >
        {linkCitations(normalizeMath(text))}
      </ReactMarkdown>
    </div>
  );
});

/** Reveal streamed text at a steady, readable pace; catches up when far behind. */
export function useTypedText(target: string, streaming: boolean): { text: string; typing: boolean } {
  // Only answers that arrive while you watch are typed; saved ones show in full.
  const animated = useRef(streaming);
  const targetRef = useRef(target);
  const streamingRef = useRef(streaming);
  targetRef.current = target;
  streamingRef.current = streaming;
  const [n, setN] = useState(streaming ? 0 : target.length);

  useEffect(() => {
    if (!animated.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { animated.current = false; setN(Infinity); return; }
    let raf = 0;
    let last = performance.now();
    let cur = 0;
    const tick = (now: number) => {
      const t = targetRef.current;
      const behind = t.length - cur;
      if (behind > 0) {
        const dt = Math.min(64, now - last);
        // ~90 characters a second, faster the further behind it is.
        cur = Math.min(t.length, cur + Math.max(1, Math.round((90 + behind * 2.5) * dt / 1000)));
        const space = t.indexOf(" ", cur);            // don't stop mid-word
        if (space > 0 && space - cur < 12) cur = space;
        setN(cur);
      } else if (!streamingRef.current) {
        animated.current = false;                      // caught up and the stream is over
        setN(Infinity);
        return;
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!animated.current) return { text: target, typing: false };
  return { text: target.slice(0, n), typing: true };
}
