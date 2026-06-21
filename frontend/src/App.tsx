import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { motion } from "framer-motion";
import { LogOut } from "lucide-react";
import { ToastPortal } from "./components/ui";
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
import { WorkflowView, WorkflowSolution, ExecResult } from "./components/WorkflowView";
import { AuthForm } from "./components/AuthForm";
import { SignUpForm, SignUpProfile } from "./components/SignUpForm";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Privacy } from "./pages/Privacy";
import { SharePage } from "./pages/SharePage";
import { DEMO, demoFetch } from "./demoBackend";
import "./styles.css";

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

function loadChatHistory(tenantEmail: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(`ragaas:chat:${tenantEmail}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
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
} else {
  createRoot(document.getElementById("root")!).render(<App />);
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
  const [members, setMembers]         = useState<Member[]>([]);
  const [view, setView]               = useState<"chat" | "solve" | "insights" | "integrations">("chat");
  // In prod we don't know auth state until the listener fires once.
  const [authReady, setAuthReady]     = useState(USE_EMULATOR || DEMO);
  const [authMode, setAuthMode]       = useState<"signin" | "signup">(parseInviteParams() ? "signup" : "signin");
  const [displayName, setDisplayName] = useState("");
  const tokenRef                      = useRef("");
  const currentUidRef                 = useRef("");
  const inviteRef                     = useRef(parseInviteParams());
  const [inviteInfo]                  = useState(inviteRef.current);
  const [inviteJoined, setInviteJoined] = useState<string | null>(null);

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${tokenRef.current}` };
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

  async function solveWorkflow(problem: string): Promise<WorkflowSolution | null> {
    try {
      const res = await apiFetch(`${API}/api/solve`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ problem }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      refreshStatus();
      return body as WorkflowSolution;
    } catch {
      return null;
    }
  }

  async function executeAction(tool: string, args: Record<string, unknown>): Promise<ExecResult | null> {
    try {
      const res = await apiFetch(`${API}/api/actions/execute`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ tool, args, approved: true }),
      });
      const body = await res.json();
      return { ok: !!body.ok, status: body.status, detail: body.detail ?? {} };
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

  async function sendMessage(raw: string) {
    const text = raw.trim();
    if (!text || isLoading) return;
    setQuestion("");
    const next: ChatMessage[] = [...messages, { role: "user", text, timestamp: Date.now() }];
    setMessages(next);
    setIsLoading(true);
    try {
      const history = messages.slice(-4).map((m) => ({ role: m.role, text: m.text }));
      const res  = await apiFetch(`${API}/api/chat`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
      });
      const body = await res.json();
      const answer = res.ok ? body.answer : (body.detail ?? "Something went wrong.");
      const updated: ChatMessage[] = [
        ...next,
        {
          role: "assistant",
          text: answer,
          citations: body.citations ?? [],
          retrieval: body.retrieval,
          timestamp: Date.now(),
        },
      ];
      setMessages(updated);
      saveChatHistory(tenantEmail, updated);
      refreshStatus();
    } catch {
      const updated: ChatMessage[] = [
        ...next,
        { role: "assistant", text: "Network error — is the backend running?" },
      ];
      setMessages(updated);
      saveChatHistory(tenantEmail, updated);
    } finally {
      setIsLoading(false);
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
            apiFetch(`${API}/api/tenant/profile`, {
              method: "PUT",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ name: ws }),
            }).then(() => { try { localStorage.removeItem("ragaas:workspace"); } catch { /* */ } })
              .catch(() => { /* retry next login */ });
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
      try { localStorage.setItem("ragaas:workspace", profile.workspace); } catch { /* ignore */ }
      // watchAuth fires and populates session state.
    } catch (err: unknown) {
      setAuthState(friendlyAuthError(err));
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    try { await signOutUser(); } catch { /* ignore */ }
    setView("chat");
    setMessages([]);
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [idToken, refreshStatus]);

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
          <span className="nav-brand">RAGaaS</span>
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
              onBackToSignIn={() => { setAuthMode("signin"); setAuthState("idle"); }}
              error={STATUS_WORDS.has(authState) ? "" : authState}
            />
          ) : (
            <AuthForm
              onSignIn={handleSignIn}
              onSwitchToSignUp={() => { setAuthMode("signup"); setAuthState("idle"); }}
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

  return (
    <div className="shell">
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
          {(["chat", "solve", "insights", "integrations"] as const).map((v) => (
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
      </nav>

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
              <DocumentList docs={docs} onDelete={handleDelete} deleting={deleting} />
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

      <main className="workspace">
        {view === "solve" ? (
          <ErrorBoundary>
            <WorkflowView
              onSolve={solveWorkflow}
              onExecute={executeAction}
              disabled={!online}
            />
          </ErrorBoundary>
        ) : view === "insights" ? (
          <ErrorBoundary>
            <InsightsPanel
              fetchInsights={fetchInsights}
              onQuickAsk={(q) => { setView("chat"); setQuestion(q); }}
            />
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
              />
            </ErrorBoundary>
          </>
        )}
      </main>
    </div>
  );
}
