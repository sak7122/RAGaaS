// Helpers shared by the Academy admin panel and the learner view.
import { ReactNode } from "react";

export async function readError(r: Response): Promise<string> {
  try {
    const body = await r.json();
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) return body.detail.map((d: { msg?: string }) => d.msg).join("; ");
  } catch { /* not JSON */ }
  return `Request failed (${r.status}).`;
}

export function Notice({ kind, children, onClose }: {
  kind: "ok" | "error" | "info"; children: ReactNode; onClose?: () => void;
}) {
  return (
    <div className={`acad-notice is-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {onClose && <button type="button" className="authx-link authx-link-sm" onClick={onClose}>Dismiss</button>}
    </div>
  );
}

// Minimal, safe Markdown → React: headings, bullet and numbered lists, paragraphs,
// **bold**, *italic*, `code`, and http(s) links. Text only ever becomes React text
// nodes, so lesson content can't inject HTML.
const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = LINK.exec(part);
    if (link) {
      return /^https?:\/\//i.test(link[2])
        ? <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>
        : link[1];
    }
    return part;
  });
}

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "p"; text: string };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flush(); blocks.push({ kind: "h", level: heading[1].length, text: heading[2] }); continue; }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? "ul" : "ol";
      const item = (bullet ?? numbered)![1];
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="acad-md">
      {parseBlocks(text).map((b, i) => {
        if (b.kind === "h") {
          return b.level <= 2
            ? <h4 key={i} className="acad-md-h">{inline(b.text)}</h4>
            : <h5 key={i} className="acad-md-h acad-md-h-sm">{inline(b.text)}</h5>;
        }
        if (b.kind === "ul") return <ul key={i}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>;
        if (b.kind === "ol") return <ol key={i}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>;
        return <p key={i}>{inline(b.text)}</p>;
      })}
    </div>
  );
}
