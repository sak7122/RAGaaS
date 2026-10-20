// Public site (Direction B), shown before sign-in. The homepage and the /for/<industry>
// pages are React (marketing/home). Ask, Gaps, Academy and Access are static markup ported
// from design/proto plus a small DOM module that runs on mount and is fully undone on
// unmount (see life.ts). Loaded lazily, so the signed-in app never downloads it, and
// three.js loads only on the Ask page.
import { MouseEvent, useLayoutEffect, useRef } from "react";
import HomePage from "./home/HomePage";
import IndustryPage from "./home/IndustryPage";
import PricingPage from "./home/PricingPage";
import "./marketing.css";
import { createLife, reducedMotion } from "./life";
import { initMotion } from "./motion";
import askHtml from "./pages/ask.html?raw";
import gapsHtml from "./pages/gaps.html?raw";
import academyHtml from "./pages/academy.html?raw";
import accessHtml from "./pages/access.html?raw";
import * as ask from "./pages/ask";
import * as gaps from "./pages/gaps";
import * as academy from "./pages/academy";
import * as access from "./pages/access";

import type { MarketingPage } from "./routes";

type PageModule = {
  pre?: (root: HTMLElement) => void;
  init: (root: HTMLElement, life: ReturnType<typeof createLife>, m: ReturnType<typeof initMotion>) => void;
};

type StaticPage = Exclude<MarketingPage, "home" | "industry" | "pricing">;

const PAGES: Record<StaticPage, { html: string; mod: PageModule; title: string }> = {
  ask:     { html: askHtml,     mod: ask,     title: "Ask · RAGaaS" },
  gaps:    { html: gapsHtml,    mod: gaps,    title: "Knowledge gaps · RAGaaS" },
  academy: { html: academyHtml, mod: academy, title: "Academy · RAGaaS" },
  access:  { html: accessHtml,  mod: access,  title: "Access · RAGaaS" },
};

interface MarketingProps {
  page: MarketingPage;
  slug?: string;
  signedIn: boolean;
  onNavigate: (path: string) => void;
}

export default function Marketing({ page, slug, signedIn, onNavigate }: MarketingProps) {
  if (page === "home") return <HomePage signedIn={signedIn} onNavigate={onNavigate} />;
  if (page === "industry") return <IndustryPage key={slug} slug={slug ?? ""} onNavigate={onNavigate} />;
  if (page === "pricing") return <PricingPage onNavigate={onNavigate} />;
  return <MarketingPageView key={`${page}:${signedIn}`} page={page} signedIn={signedIn} onNavigate={onNavigate} />;
}

function MarketingPageView({ page, signedIn, onNavigate }: { page: StaticPage; signedIn: boolean; onNavigate: (path: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { html, mod, title } = PAGES[page];

  useLayoutEffect(() => {
    const root = ref.current!;
    const life = createLife();
    const prevTitle = document.title;
    const docEl = document.documentElement;
    const prevScroll = docEl.style.scrollBehavior;
    document.title = title;
    if (!reducedMotion()) docEl.style.scrollBehavior = "smooth";

    // Signed-in visitors get a way back into the app instead of "Sign in".
    if (signedIn) {
      root.querySelectorAll<HTMLAnchorElement>('a[href="/signin"]').forEach((a) => {
        a.textContent = "Open app";
        a.setAttribute("href", "/");
      });
    }

    mod.pre?.(root);
    const m = initMotion(root, life);
    try {
      mod.init(root, life, m);
    } catch (err) {
      console.error(`marketing page "${page}" failed to start`, err);  // static content still shows
    }

    const hash = window.location.hash;
    const target = hash ? root.querySelector(hash) : null;
    if (target) target.scrollIntoView({ behavior: "auto" });
    else window.scrollTo({ top: 0, behavior: "auto" });

    return () => {
      life.dispose();
      document.title = prevTitle;
      docEl.style.scrollBehavior = prevScroll;
    };
  }, [page, signedIn, mod, title]);

  // Same-origin links move between pages without a reload; anchors and new-tab clicks behave normally.
  function onClick(e: MouseEvent<HTMLDivElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    const href = a?.getAttribute("href");
    if (!a || !href || !href.startsWith("/") || a.target === "_blank") return;
    e.preventDefault();
    onNavigate(href);
  }

  return (
    <div
      ref={ref}
      className={`mk mk-${page}`}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
