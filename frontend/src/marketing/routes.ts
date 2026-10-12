// Public-site routes. Kept apart from Marketing.tsx so App can check a path
// without loading the (lazy) marketing bundle.
export type MarketingPage = "home" | "ask" | "gaps" | "academy" | "access" | "industry";

export const MARKETING_ROUTES: Record<string, MarketingPage> = {
  "/": "home", "/ask": "ask", "/gaps": "gaps", "/academy": "academy", "/access": "access",
  // "/" is the app once signed in; /home always shows the public homepage.
  "/home": "home",
};

// /for/<industry> pages; slugs match design/examples/companies.json.
export const INDUSTRY_SLUGS = ["dental", "logistics", "skincare", "saas", "architecture", "restaurants", "accounting", "solar"];

export function matchMarketing(path: string): { page: MarketingPage; slug?: string } | undefined {
  const page = MARKETING_ROUTES[path];
  if (page) return { page };
  const m = /^\/for\/([a-z-]+)\/?$/.exec(path);
  if (m && INDUSTRY_SLUGS.includes(m[1])) return { page: "industry", slug: m[1] };
  return undefined;
}

export const AUTH_ROUTES = { signin: "/signin", signup: "/signup" } as const;
