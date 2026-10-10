// Public-site routes. Kept apart from Marketing.tsx so App can check a path
// without loading the (lazy) marketing bundle.
export type MarketingPage = "home" | "ask" | "gaps" | "academy" | "access";

export const MARKETING_ROUTES: Record<string, MarketingPage> = {
  "/": "home", "/ask": "ask", "/gaps": "gaps", "/academy": "academy", "/access": "access",
};

export const AUTH_ROUTES = { signin: "/signin", signup: "/signup" } as const;
