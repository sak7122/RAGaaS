// "Try it on your own document": read a file in the browser and show what it can answer.
// Nothing leaves the page. Mirrors the model-free profile in backend/doc_profile.py:
// self-describing prose for the summary, section labels and repeated phrases for questions.

export type TryResult = {
  name: string;
  summary: string;
  items: { q: string; excerpt: string }[];
  gap: string;
};

const STOP = new Set(("the a an and or of to in on for with is are be by as at from that this it its your you we our will can may must " +
  "not no if then than into per each any all have has should when what who how which there their they them these those such about " +
  "after before during over under only also more most other some very").split(" "));
const SELF = /\b(this|the)\s+(document|guide|handbook|policy|manual|playbook|procedure|plan|agreement)\b.{0,40}\b(covers|outlines|describes|explains|sets out|defines|provides|is)\b/i;
const META = /^(note|page|date|version|owner|effective|author|status)$/i;
const COMMON_GAPS: [string, string[]][] = [
  ["Can I work from another country for a month?", ["abroad", "another country", "overseas", "work remotely"]],
  ["Who approves overtime at weekends?", ["overtime"]],
  ["What is the parking policy?", ["parking"]],
  ["How do I expense a client dinner?", ["expense", "reimburse"]],
  ["What happens if I'm sick on a public holiday?", ["public holiday", "bank holiday"]],
];

export const MAX_TRY_BYTES = 15 * 1024 * 1024;

export function analyzeText(name: string, raw: string): TryResult {
  const text = raw.replace(/\s+/g, " ").trim().slice(0, 80000);
  const sentences = text.split(/(?<=[.!?])\s+/).filter((x) => x.split(" ").length >= 6 && !x.includes("|"));
  const ordered = sentences.filter((x) => SELF.test(x)).concat(sentences.filter((x) => !SELF.test(x)));
  let summary = "";
  for (const x of ordered.slice(0, 3)) {
    if (summary && summary.length + x.length > 320) break;
    summary = `${summary} ${x}`.trim();
  }

  const topics: string[] = [];
  const add = (t: string) => { const k = t.toLowerCase().trim(); if (k && !topics.includes(k)) topics.push(k); };
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?: [A-Za-z][a-z]+)?):\s/g)) if (!META.test(m[1])) add(m[1]);
  const words = (text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOP.has(w));
  const pairs = new Map<string, number>();
  for (let i = 0; i + 1 < words.length; i++) {
    const k = `${words[i]} ${words[i + 1]}`;
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  [...pairs].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k]) => add(k));
  const counts = new Map<string, number>();
  words.forEach((w) => { if (w.length > 4) counts.set(w, (counts.get(w) ?? 0) + 1); });
  [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k]) => add(k));

  const items: TryResult["items"] = [];
  for (const t of topics) {
    const hit = sentences.find((x) => x.toLowerCase().includes(t));
    if (hit && !items.some((i) => i.excerpt === hit)) {
      items.push({ q: `What does it say about ${t}?`, excerpt: hit.length > 240 ? `${hit.slice(0, 240).replace(/\s\S*$/, "")}…` : hit });
    }
    if (items.length === 3) break;
  }
  const low = text.toLowerCase();
  const gap = (COMMON_GAPS.find(([, keys]) => !keys.some((k) => low.includes(k))) ?? COMMON_GAPS[0])[0];
  return { name, summary: summary || text.slice(0, 280), items, gap };
}

/** Plain text of a PDF, read in the browser. pdf.js is loaded only when this runs. */
export async function readPdfText(file: File, maxPages = 30): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const parts: string[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  await doc.destroy();
  return parts.join("\n");
}
