// Typed view of the FICTIONAL example workspaces in design/examples/companies.json.
// Used by the homepage journey, the "try a sample" box and the /for/<industry> pages.
import data from "../../../../design/examples/companies.json";

export type ExampleDoc = {
  file: string; title: string; pages: number; audience: string; restricted: boolean;
  summary: string; questions: string[];
};

export type ExampleCompany = {
  id: string; name: string; industry: string; short: string; slug: string; plural: string; size: string;
  owner: { name: string; role: string };
  persona: { name: string; role: string };
  documents: ExampleDoc[];
  qa: {
    question: string; answer: string; doc: string; page: number;
    excerpt: { before: string; highlight: string; after: string };
    also_cites: { doc: string; page: number };
  };
  gaps: { question: string; asks: number }[];
  new_doc: { title: string; closes: number };
  academy: {
    path: string; role: string; due_days: number;
    lessons: { title: string; source: string }[];
    quiz: { question: string; options: string[]; answer: number; source: string };
  };
  example_usage: { questions_month: number; answered_with_source: number; gaps_closed: number; certified: number };
};

export const COMPANIES = data.companies as ExampleCompany[];

export const docTitle = (co: ExampleCompany, file: string) =>
  co.documents.find((d) => d.file === file)?.title ?? file;

/** "Dr. Anika Rao" -> "Dr. Rao"; "Tom Okoye" -> "Tom". */
export const shortName = (name: string) =>
  name.startsWith("Dr.") ? `Dr. ${name.split(" ").slice(-1)[0]}` : name.split(" ")[0];

export const lowerFirst = (s: string) => (s.charAt(0).toLowerCase() + s.slice(1)).replace(/^saaS/, "SaaS");

export const companyBySlug = (slug: string) => COMPANIES.find((c) => c.slug === slug);
