import { FormEvent, Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig, motion } from "framer-motion";
import { GraduationCap, Lightbulb, LogOut, MessageCircle, Plug, Sparkles, X } from "lucide-react";
import { ToastPortal, toast } from "./components/ui";
import {
  devSignInTenant,
  signInWithPassword,
  signUpWithPassword,
  signOutUser,
  watchAuth,
  friendlyAuthError,
} from "./firebase";
import { Sidebar } from "./components/Sidebar";
import { UploadBar } from "./components/UploadBar";
import { ChatWindow, ChatMessage } from "./components/ChatWindow";
import { DocumentList, DocumentMeta } from "./components/DocumentList";
import { MembersPanel, Member } from "./components/MembersPanel";
import { InsightsPanel, Insights } from "./components/InsightsPanel";
import { IntegrationsPanel } from "./components/IntegrationsPanel";
import { AcademyPanel } from "./components/AcademyPanel";
import type { ConvSummary, HistoryProps } from "./components/chatExtras";
import { AuthForm } from "./components/AuthForm";
import { SignUpForm, SignUpProfile } from "./components/SignUpForm";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Privacy } from "./pages/Privacy";
import { SharePage } from "./pages/SharePage";
import { SolvePage } from "./pages/SolvePage";
import { DEMO, demoFetch } from "./demoBackend";
import { AUTH_ROUTES, matchMarketing } from "./marketing/routes";
import "./styles.css";

// Public site, loaded only when a signed-out visitor (or a public page) needs it.
const Marketing = lazy(() => import("./marketing/Marketing"));

// Set while a Firebase session exists, so a returning user on "/" waits for the
// session to restore instead of seeing the public home page flash first.
const SESSION_HINT = "ragaas:session";
function hasSessionHint(): boolean {
  try { return localStorage.getItem(SESSION_HINT) === "1"; } catch { return false; }
}
function setSessionHint(on: boolean) {
  try { if (on) localStorage.setItem(SESSION_HINT, "1"); else localStorage.removeItem(SESSION_HINT); } catch { /* */ }
}

const API          = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";
const USE_EMULATOR = import.meta.env.VITE_FIREBASE_USE_EMULATOR === "true";

// In demo mode all API calls are served by an in-browser mock (no server).
const apiFetch: typeof fetch = DEMO
  ? ((input, init) => demoFetch(input as string, init as RequestInit)) as typeof fetch
  : fetch;

// Invite links look like /?invite=<uid>&tenant=<tenant_id>. Parsed once on
// load; consumed after the user is authenticated (see watchAuth below).
function parseInviteParams(): { uid: string; tenant: string } | null {
  const p = new URLSearchParams(window.location.search);
  const uid = p.get("invite");
  const tenant = p.get("tenant");
  return uid && tenant ? { uid, tenant } : null;
}

function clearInviteFromUrl() {
  window.history.replaceState({}, "", window.location.pathname);
}

const DEV_TENANTS = [
  { label: "Demo",     email: "demo@ragaas.local" },
  { label: "Tenant A", email: "tenant-a@ragaas.local" },
  { label: "Tenant B", email: "tenant-b@ragaas.local" },
];

type Status = {
  tenant_id: string;
  tenant_name: string;
  queries_used: number;
  query_limit: number;
  documents: number;
};

// Error bodies used to be saved as message text (a list from a 422); coerce on load
// so an old bad entry can't crash the chat.
function sanitizeMessages(parsed: unknown): ChatMessage[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ ...m, streaming: false, text: typeof m.text === "string" ? m.text : "Something went wrong with this message." }));
}

function loadChatHistory(tenantEmail: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(`ragaas:chat:${tenantEmail}`);
    return sanitizeMessages(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

// The conversation the chat is showing, so a reload reopens it from the server.
const convKey = (email: string) => `ragaas:conv:${email}`;
function loadConversationId(email: string): string | null {
  try { return localStorage.getItem(convKey(email)); } catch { return null; }
}

// FastAPI errors carry `detail` as a string, or as a list of validation issues.
function errorText(body: { detail?: unknown } | null, status: number): string {
  const d = body?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d.length && typeof d[0]?.msg === "string") return `Request rejected: ${d[0].msg}`;
  return `Something went wrong (HTTP ${status}).`;
}

function saveChatHistory(tenantEmail: string, messages: ChatMessage[]) {
  try {
    localStorage.setItem(`ragaas:chat:${tenantEmail}`, JSON.stringify(messages.slice(-100)));
  } catch { /* storage full */ }
}

// Simple path-based routing — no router library needed
const path = window.location.pathname;
if (path === "/privacy") {
  createRoot(document.getElementById("root")!).render(<Privacy />);
} else if (path.startsWith("/share/")) {
  createRoot(document.getElementById("root")!).render(<SharePage />);
} else if (path === "/solve") {
  createRoot(document.getElementById("root")!).render(<SolvePage />);
} else {
  createRoot(document.getElementById("root")!).render(
    <MotionConfig reducedMotion="user"><App /></MotionConfig>,
  );
}

function App() {
  const [tenantEmail, setTenantEmail] = useState(USE_EMULATOR ? DEV_TENANTS[0].email : "");
  const [idToken, setIdToken]         = useState("");
  const [authState, setAuthState]     = useState(USE_EMULATOR ? "Signing in…" : "idle");
  const [online, setOnline]           = useState(false);
  const [status, setStatus]           = useState<Status | null>(null);
  const [messages, setMessages]       = useState<ChatMessage[]>([]);
  const [question, setQuestion]       = useState("");
  const [isLoading, setIsLoading]     = useState(false);
  const [docs, setDocs]               = useState<DocumentMeta[]>([]);
  const [deleting, setDeleting]       = useState<string | null>(null);
  const [refreshing, setRefreshing]   = useState<string | null>(null);
  // Documents the next question searches (file names); empty = every document.
  const [scope, setScope]             = useState<string[]>([]);
  const [members, setMembers]         = useState<Member[]>([]);
  const [view, setView]               = useState<"chat" | "insights" | "academy" | "integrations">("chat");
  // Phones: the sidebar (workspace, usage, documents, team) lives in a bottom sheet.
  const [sheetOpen, setSheetOpen]     = useState(false);
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSheetOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);
  const [conversationId, setConversationIdState] = useState<string | null>(null);
  // In prod we don't know auth state until the listener fires once.
  const [authReady, setAuthReady]     = useState(USE_EMULATOR || DEMO);
  const [authMode, setAuthMode]       = useState<"signin" | "signup">(
    parseInviteParams() || window.location.pathname === AUTH_ROUTES.signup ? "signup" : "signin");
  const [route, setRoute]             = useState(window.location.pathname);
  const [displayName, setDisplayName] = useState("");
  const tokenRef                      = useRef("");
  const currentUidRef                 = useRef("");
  const inviteRef                     = useRef(parseInviteParams());
  const [inviteInfo]                  = useState(inviteRef.current);
  const [inviteJoined, setInviteJoined] = useState<string | null>(null);

  // Client-side navigation between the public pages, the auth forms and the app.
  const navigate = useCallback((to: string) => {
    const url = new URL(to, window.location.origin);
    const next = url.pathname + url.search + url.hash;
    if (next !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.pushState({}, "", next);
    }
    if (url.pathname === AUTH_ROUTES.signup) setAuthMode("signup");
    if (url.pathname === AUTH_ROUTES.signin) setAuthMode("signin");
    setRoute(url.pathname);
  }, []);

  useEffect(() => {
    const onPop = () => {
      setRoute(window.location.pathname);
      if (window.location.pathname === AUTH_ROUTES.signup) setAuthMode("signup");
      if (window.location.pathname === AUTH_ROUTES.signin) setAuthMode("signin");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${tokenRef.current}` };
  }

  function api(path: string, init: RequestInit = {}) {
    return apiFetch(`${API}${path}`, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  }

  function setConversationId(id: string | null) {
    setConversationIdState(id);
    try {
      if (id) localStorage.setItem(convKey(tenantEmail), id);
      else localStorage.removeItem(convKey(tenantEmail));
    } catch { /* private mode */ }
  }

  // Reopen the last conversation from the server (history follows the person
  // across devices); localStorage only covers the moment before it loads.
  useEffect(() => {
    if (!online || !tenantEmail) return;
    const id = loadConversationId(tenantEmail);
    setConversationIdState(id);
    if (!id) return;
    let live = true;
    api(`/api/conversations/${id}`).then(async (r) => {
      if (!live) return;
      if (r.ok) setMessages(sanitizeMessages((await r.json()).messages));
      else if (r.status === 404) setConversationId(null);
    }).catch(() => { /* offline: keep local copy */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, tenantEmail]);

  function newChat() {
    setMessages([]);
    setConversationId(null);
    saveChatHistory(tenantEmail, []);
  }

  const history: HistoryProps = {
    current: conversationId,
    load: async (): Promise<ConvSummary[]> => {
      const r = await api("/api/conversations");
      return r.ok ? r.json() : [];
    },
    open: async (id: string) => {
      const r = await api(`/api/conversations/${id}`);
      if (!r.ok) { toast("Couldn't open that conversation", "error"); return; }
      const msgs = sanitizeMessages((await r.json()).messages);
      setMessages(msgs);
      saveChatHistory(tenantEmail, msgs);
      setConversationId(id);
      setView("chat");
    },
    remove: async (id: string) => {
      await api(`/api/conversations/${id}`, { method: "DELETE" });
      if (id === conversationId) newChat();
    },
    newChat,
  };

  async function handleFeedback(index: number, helpful: boolean) {
    const m = messages[index];
    if (!m?.answer_id) return;
    setMessages((cur) => cur.map((x, i) => (i === index ? { ...x, helpful } : x)));
    try {
      await api("/api/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer_id: m.answer_id, helpful, conversation_id: conversationId }),
      });
    } catch { /* rating is best effort */ }
  }

  async function handleImportUrl(url: string, wholeSite = false): Promise<string | null> {
    try {
      const r = await api(wholeSite ? "/api/import-site" : "/api/import-url", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
      });
      if (r.ok) return null;
      return errorText(await r.json().catch(() => null), r.status);
    } catch {
      return "Network error. Try again.";
    }
  }

  const refreshStatus = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const [statusRes, docsRes, membersRes] = await Promise.all([
        apiFetch(`${API}/api/tenant/status`,  { headers: authHeaders() }),
        apiFetch(`${API}/api/documents`,      { headers: authHeaders() }),
        apiFetch(`${API}/api/tenant/members`, { headers: authHeaders() }),
      ]);
      if (statusRes.ok)  setStatus(await statusRes.json());
      if (docsRes.ok)    setDocs(await docsRes.json());
      if (membersRes.ok) setMembers(await membersRes.json());
    } catch { /* backend may be starting */ }
  }, []);

  useEffect(() => {
    setScope((prev) => {
      const next = prev.filter((f) => docs.some((d) => d.file_name === f));
      return next.length === prev.length ? prev : next;
    });
  }, [docs]);

  // Rebuild one document's summary and starter questions (Gemini in production).
  async function handleRefreshProfile(fileName: string) {
    setRefreshing(fileName);
    try {
      const res = await apiFetch(`${API}/api/documents/${encodeURIComponent(fileName)}/profile`, {
        method: "POST",
        headers: authHeaders(),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail ?? "Could not refresh the summary");
      setDocs((prev) => prev.map((d) => (d.file_name === fileName ? { ...d, ...body } : d)));
      toast("Summary and questions refreshed");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not refresh the summary", "error");
    } finally {
      setRefreshing(null);
    }
  }

  // Re-read an imported website so answers follow its live pages.
  async function handleRefreshSite(fileName: string) {
    setRefreshing(fileName);
    try {
      const res = await api(`/api/documents/${encodeURIComponent(fileName)}/refresh`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorText(body, res.status));
      toast(`Site re-read: ${body.pages} pages`);
      refreshStatus();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not re-read the site", "error");
    } finally {
      setRefreshing(null);
    }
  }

  async function handleDelete(fileName: string) {
    setDeleting(fileName);
    try {
      const res = await apiFetch(`${API}/api/documents/${encodeURIComponent(fileName)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        setDocs((prev) => prev.filter((d) => d.file_name !== fileName));
        refreshStatus();
      }
    } catch { /* ignore */ } finally {
      setDeleting(null);
    }
  }

  async function handleInvite(email: string, role: string) {
    const res = await apiFetch(`${API}/api/tenant/invite`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ email, role }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail ?? "Invite failed");
    await refreshStatus();
    return body as { email_sent?: boolean; invite_link?: string };
  }

  async function handleRemove(uid: string) {
    const res = await apiFetch(`${API}/api/tenant/members/${uid}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.detail ?? "Remove failed");
    }
    setMembers((prev) => prev.filter((m) => m.uid !== uid));
  }

  async function handleChangeRole(uid: string, role: string) {
    const res = await apiFetch(`${API}/api/tenant/members/${uid}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (res.ok) {
      setMembers((prev) => prev.map((m) => m.uid === uid ? { ...m, role: role as Member["role"] } : m));
    }
  }

  async function fetchInsights(): Promise<Insights | null> {
    try {
      const res = await apiFetch(`${API}/api/insights`, { headers: authHeaders() });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function handleShare(msg: ChatMessage): Promise<string | null> {
    const userMsg = messages.slice(0, messages.indexOf(msg)).reverse().find((m) => m.role === "user");
    try {
      const res = await apiFetch(`${API}/api/share`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          question: userMsg?.text ?? "",
          answer: msg.text,
          citations: msg.citations ?? [],
        }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      return body.url as string;
    } catch {
      return null;
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    await sendMessage(question);
  }

  async function sendMessage(raw: string, scopeOverride?: string[]) {
    const text = raw.trim();
    if (!text || isLoading) return;
    const files = scopeOverride ?? scope;
    setQuestion("");
    const next: ChatMessage[] = [...messages, { role: "user", text, timestamp: Date.now(), scope: files }];
    setMessages(next);
    setIsLoading(true);
    // The answer arrives as newline-delimited JSON: sources first, then the text as
    // it is written, then a final event with the ids for feedback and history.
    const st: { msg: ChatMessage | null } = { msg: null };
    const show = (m: ChatMessage) => { st.msg = m; setMessages([...next, m]); };
    try {
      const history = messages.slice(-4).map((m) => ({ role: m.role, text: String(m.text ?? "").slice(0, 2000) }));
      const res = await apiFetch(`${API}/api/chat/stream`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history, file_names: files.length ? files : null,
                               conversation_id: conversationId }),
      });
      if (!res.ok || !res.body) {
        show({ role: "assistant", text: errorText(await res.json().catch(() => null), res.status), timestamp: Date.now() });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let written = "";
      let citations: ChatMessage["citations"] = [];
      let retrieval: ChatMessage["retrieval"];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === "meta") {
            citations = ev.citations ?? [];
            retrieval = ev.retrieval;
          } else if (ev.type === "delta") {
            written += ev.text;
            show({ role: "assistant", text: written, citations, retrieval, timestamp: Date.now(), streaming: true });
          } else if (ev.type === "done") {
            // Nothing cited inside the picked documents: offer to ask the whole workspace.
            const scopedMiss = files.length > 0 && (citations ?? []).length === 0 ? text : undefined;
            show({ role: "assistant", text: ev.answer, citations, retrieval: ev.retrieval ?? retrieval,
                   timestamp: Date.now(), answer_id: ev.answer_id, scopedMiss, related: ev.related ?? [] });
            if (ev.conversation_id) setConversationId(ev.conversation_id);
          }
        }
      }
      if (st.msg?.streaming) show({ ...st.msg, streaming: false });   // stream cut short
      refreshStatus();
    } catch {
      show(st.msg ? { ...st.msg, streaming: false } : { role: "assistant", text: "Network error — is the backend running?" });
    } finally {
      setIsLoading(false);
      if (st.msg) saveChatHistory(tenantEmail, [...next, { ...st.msg, streaming: false }]);
    }
  }

  // ── Demo mode: skip Firebase, go straight online with a fake token ───────
  useEffect(() => {
    if (!DEMO) return;
    tokenRef.current = "demo-token";
    currentUidRef.current = "demo-admin";
    setTenantEmail("you@acme.com");
    setIdToken("demo-token");
    setOnline(true);
    setAuthState("Authenticated");
  }, []);

  // ── Auth: dev emulator (auto sign-in) ───────────────────────────────────
  useEffect(() => {
    if (!USE_EMULATOR || !tenantEmail) return;
    let live = true;
    setAuthState("Signing in…");
    setOnline(false);
    setIdToken("");
    setStatus(null);
    setDocs([]);
    setMembers([]);
    tokenRef.current = "";
    const history = loadChatHistory(tenantEmail);
    setMessages(history);

    devSignInTenant(tenantEmail)
      .then((token) => {
        if (!live) return;
        // Dev mock tokens map tenant → uid
        const mockUid = `dev-${tenantEmail.replace("@ragaas.local", "").replace("@", "-")}`;
        currentUidRef.current = mockUid;
        tokenRef.current = token;
        setIdToken(token);
        setOnline(true);
        setAuthState("Authenticated");
      })
      .catch(() => {
        if (!live) return;
        setAuthState("Start Firebase Auth emulator on :9099");
        setOnline(false);
      });

    return () => { live = false; };
  }, [tenantEmail]);

  // ── Auth: prod session listener ─────────────────────────────────────────
  // Restores the session on page reload AND keeps the token fresh on the
  // SDK's automatic ~hourly refresh, so API calls never 401 on expiry.
  useEffect(() => {
    if (USE_EMULATOR || DEMO) return;
    const unsub = watchAuth(async (user) => {
      setAuthReady(true);
      setSessionHint(!!user);
      if (user) {
        const token = await user.getIdToken();
        currentUidRef.current = user.uid;
        tokenRef.current = token;
        setIdToken(token);
        setOnline(true);
        setAuthState("Authenticated");
        setDisplayName(user.displayName ?? "");
        if (user.email) {
          setTenantEmail(user.email);
          setMessages(loadChatHistory(user.email));
        }

        // Consume a pending invite: join the shared tenant, then refresh the
        // token so the new tenant_id custom claim takes effect immediately.
        const invite = inviteRef.current;
        if (invite) {
          inviteRef.current = null; // consume once
          try {
            const res = await apiFetch(`${API}/api/tenant/accept-invite`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ tenant_id: invite.tenant, invite_uid: invite.uid }),
            });
            if (res.ok) {
              const fresh = await user.getIdToken(true); // pick up tenant_id claim
              tokenRef.current = fresh;
              setIdToken(fresh);
              setInviteJoined(invite.tenant);
            }
          } catch { /* invalid/expired invite — fall through to own workspace */ }
          clearInviteFromUrl();
        } else {
          // Self-heal: push the workspace name typed at signup to the backend so
          // the UI shows it instead of the raw ws-<uid> tenant id. Skipped when
          // accepting an invite (the caller is joining someone else's workspace).
          const ws = (() => { try { return localStorage.getItem("ragaas:workspace") || ""; } catch { return ""; } })();
          if (ws) {
            // Sign-up step-2 answers travel with the name (see SignUpForm).
            const onboarding = (() => {
              try { return JSON.parse(localStorage.getItem("ragaas:onboarding") || "null"); } catch { return null; }
            })();
            apiFetch(`${API}/api/tenant/profile`, {
              method: "PUT",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify(onboarding ? { name: ws, onboarding } : { name: ws }),
            }).then((r) => {
              if (!r.ok) return;  // keep for retry on next login
              try {
                localStorage.removeItem("ragaas:workspace");
                localStorage.removeItem("ragaas:onboarding");
              } catch { /* */ }
            }).catch(() => { /* retry next login */ });
          }
        }
      } else {
        currentUidRef.current = "";
        tokenRef.current = "";
        setIdToken("");
        setOnline(false);
        setAuthState("idle");
        setStatus(null);
        setDocs([]);
        setMembers([]);
      }
    });
    return unsub;
  }, []);

  // ── Auth: prod sign-in/up (listener above sets state on success) ────────
  const handleSignIn = useCallback(async (email: string, password: string) => {
    setAuthState("Signing in…");
    try {
      await signInWithPassword(email, password);
      // watchAuth fires and populates session state.
    } catch (err: unknown) {
      setAuthState(friendlyAuthError(err));
    }
  }, []);

  const handleSignUp = useCallback(async (email: string, password: string, profile: SignUpProfile) => {
    setAuthState("Signing in…");
    try {
      await signUpWithPassword(email, password, profile.name);
      // Workspace name is the user's label for their new tenant; the backend
      // keys the tenant by uid (private workspace). Persist for display.
      try {
        localStorage.setItem("ragaas:workspace", profile.workspace);
        localStorage.setItem("ragaas:onboarding", JSON.stringify(profile.onboarding));
      } catch { /* ignore */ }
      // watchAuth fires and populates session state.
    } catch (err: unknown) {
      setAuthState(friendlyAuthError(err));
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    try { await signOutUser(); } catch { /* ignore */ }
    setView("chat");
    setMessages([]);
    setConversationIdState(null);
    navigate("/");
  }, [navigate]);

  useEffect(() => {
    refreshStatus();
  }, [idToken, refreshStatus]);

  useEffect(() => {
    if (online && (route === AUTH_ROUTES.signin || route === AUTH_ROUTES.signup)) {
      window.history.replaceState({}, "", "/");
      setRoute("/");
    }
  }, [online, route]);

  // ── Public site ──────────────────────────────────────────────────────────
  // "/" is the home page when signed out and the app when signed in; the other
  // public pages stay reachable either way. Invite links skip straight to sign-up.
  const marketingPage = inviteInfo ? undefined : matchMarketing(route);
  const appAtRoot = USE_EMULATOR || DEMO || online || (!authReady && hasSessionHint());
  if (marketingPage && (route !== "/" || !appAtRoot)) {
    return (
      <Suspense fallback={<div className="mk-loading" aria-busy="true" />}>
        <Marketing page={marketingPage.page} slug={marketingPage.slug} signedIn={online} onNavigate={navigate} />
      </Suspense>
    );
  }

  // ── Prod: restoring session (avoid login flash on reload) ───────────────
  if (!USE_EMULATOR && !DEMO && !authReady) {
    return (
      <div className="shell">
        <div className="auth-splash">
          <span className="auth-splash-mark">R</span>
          <span className="auth-splash-text">Restoring your session…</span>
        </div>
      </div>
    );
  }

  // ── Prod: show auth form ─────────────────────────────────────────────────
  const STATUS_WORDS = new Set(["idle", "Signing in…", "Authenticated"]);
  if (!USE_EMULATOR && !online) {
    return (
      <div className="shell">
        <ToastPortal />
        <nav className="global-nav">
          <a className="nav-brand" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>RAGaaS</a>
          <span className="nav-spacer" />
          <div className="nav-status">
            <span className="nav-dot offline" />
            Sign in to continue
          </div>
        </nav>
        {inviteInfo && (
          <div className="invite-banner">
            🎟️ You've been invited to a workspace. Sign in or create an account
            with the invited email to join.
          </div>
        )}
        <ErrorBoundary>
          {authMode === "signup" ? (
            <SignUpForm
              onSignUp={handleSignUp}
              onBackToSignIn={() => { navigate(AUTH_ROUTES.signin); setAuthState("idle"); }}
              error={STATUS_WORDS.has(authState) ? "" : authState}
            />
          ) : (
            <AuthForm
              onSignIn={handleSignIn}
              onSwitchToSignUp={() => { navigate(AUTH_ROUTES.signup); setAuthState("idle"); }}
              error={STATUS_WORDS.has(authState) ? "" : authState}
            />
          )}
        </ErrorBoundary>
      </div>
    );
  }

  // Dev uid for the current mock token
  const currentUid = USE_EMULATOR
    ? `dev-${tenantEmail.replace("@ragaas.local", "").replace("@", "-")}`
    : currentUidRef.current;
  // Admins and uploaders can rebuild document summaries (the backend checks too).
  const myRole = USE_EMULATOR || DEMO ? "admin" : members.find((m) => m.uid === currentUid)?.role;
  const canManageDocs = myRole === "admin" || myRole === "uploader";

  const me = (displayName || tenantEmail || "?").trim();
  return (
    <div className={`shell app-shell${sheetOpen ? " sheet-open" : ""}`}>
      <ToastPortal />
      {inviteJoined && (
        <div className="invite-banner success" onClick={() => setInviteJoined(null)}>
          ✅ You've joined the workspace. You can now ask questions about its
          documents. (click to dismiss)
        </div>
      )}
      <nav className="global-nav">
        <motion.span
          className="nav-brand"
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          RAGaaS
        </motion.span>
        {USE_EMULATOR && (
          <motion.span
            className="nav-badge"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
          >
            Local Dev
          </motion.span>
        )}
        <div className="nav-tabs">
          {(["chat", "insights", "academy", "integrations"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`nav-tab${view === v ? " active" : ""}`}
              onClick={() => setView(v)}
            >
              {view === v && (
                <motion.span
                  className="nav-tab-indicator"
                  layoutId="nav-tab-indicator"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <span className="nav-tab-label">
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </span>
            </button>
          ))}
        </div>
        <motion.a
          className="nav-solve"
          href="/solve"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.25 }}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          title="Open the Workflow Engine"
        >
          <Sparkles size={13} /> Solve
        </motion.a>
        <span className="nav-spacer" />
        <motion.div
          className="nav-status"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          <span className={`nav-dot${!online ? (authState === "Signing in…" ? " pending" : " offline") : ""}`} />
          {online ? (status?.tenant_name ?? tenantEmail) : authState}
        </motion.div>
        {!USE_EMULATOR && !DEMO && online && (
          <button type="button" className="nav-signout" onClick={handleSignOut} title="Sign out">
            <LogOut size={14} />
          </button>
        )}
        <button type="button" className="nav-me" onClick={() => setSheetOpen(true)}
                aria-label="Workspace, documents and account" aria-expanded={sheetOpen} aria-controls="side-sheet">
          <span className={`nav-me-dot${online ? " is-on" : ""}`} aria-hidden="true" />
          {me.charAt(0).toUpperCase()}
        </button>
      </nav>

      <button type="button" className="sheet-scrim" aria-hidden={!sheetOpen} tabIndex={-1}
              onClick={() => setSheetOpen(false)} />
      <div className="side-host" id="side-sheet" role={sheetOpen ? "dialog" : undefined}
           aria-modal={sheetOpen || undefined} aria-label="Workspace">
        <div className="side-sheet-head">
          <span className="side-sheet-grab" aria-hidden="true" />
          <span className="side-sheet-title">{status?.tenant_name ?? "Workspace"}</span>
          <button type="button" className="side-sheet-close" onClick={() => setSheetOpen(false)} aria-label="Close">
            <X size={18} />
          </button>
        </div>
      <ErrorBoundary>
        <Sidebar
          tenants={USE_EMULATOR ? DEV_TENANTS : []}
          tenantEmail={tenantEmail}
          onTenantChange={(email) => {
            setTenantEmail(email);
            setMessages(loadChatHistory(email));
          }}
          status={status}
          authState={authState}
          online={online}
          userLabel={displayName || tenantEmail}
          onRefresh={refreshStatus}
          extraSlot={
            <>
              <DocumentList
                docs={docs}
                onDelete={handleDelete}
                deleting={deleting}
                canManage={canManageDocs}
                onRefreshProfile={handleRefreshProfile}
                onRefreshSite={handleRefreshSite}
                refreshing={refreshing}
              />
              <MembersPanel
                members={members}
                currentUid={currentUid}
                onInvite={handleInvite}
                onRemove={handleRemove}
                onChangeRole={handleChangeRole}
              />
            </>
          }
        />
      </ErrorBoundary>
      </div>

      <main className="workspace">
        {view === "insights" ? (
          <ErrorBoundary>
            <InsightsPanel
              fetchInsights={fetchInsights}
              onQuickAsk={(q) => { setView("chat"); setQuestion(q); }}
              api={api}
            />
          </ErrorBoundary>
        ) : view === "academy" ? (
          <ErrorBoundary>
            <AcademyPanel apiUrl={API} authHeaders={authHeaders} />
          </ErrorBoundary>
        ) : view === "integrations" ? (
          <ErrorBoundary>
            <IntegrationsPanel apiUrl={API} authHeaders={authHeaders} appBaseUrl={status?.tenant_id ? `${API}` : API} />
          </ErrorBoundary>
        ) : (
          <>
            <UploadBar
              apiUrl={API}
              authToken={idToken}
              disabled={!online}
              onComplete={refreshStatus}
              onImportUrl={canManageDocs ? handleImportUrl : undefined}
            />
            <ErrorBoundary>
              <ChatWindow
                messages={messages}
                question={question}
                isLoading={isLoading}
                onQuestionChange={setQuestion}
                onSend={handleSend}
                onAsk={sendMessage}
                onShare={handleShare}
                disabled={!online}
                docs={docs}
                scope={scope}
                onScopeChange={setScope}
                workspaceName={status?.tenant_name}
                onFeedback={handleFeedback}
                history={history}
                onSearch={async (query, files, pageToken) => {
                  try {
                    const r = await api("/api/search", {
                      method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ query, file_names: files.length ? files : null, page_token: pageToken ?? null }),
                    });
                    return r.ok ? r.json() : null;
                  } catch { return null; }
                }}
              />
            </ErrorBoundary>
          </>
        )}
      </main>

      <nav className="tabbar" aria-label="Sections">
        {([
          ["chat", "Ask", MessageCircle], ["insights", "Insights", Lightbulb],
          ["academy", "Academy", GraduationCap], ["integrations", "Connect", Plug],
        ] as const).map(([v, label, Icon]) => (
          <button key={v} type="button" className="tab" aria-current={view === v ? "page" : undefined}
                  onClick={() => { setView(v); setSheetOpen(false); }}>
            <Icon size={22} strokeWidth={view === v ? 2.2 : 1.8} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
