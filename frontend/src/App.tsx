import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { motion } from "framer-motion";
import { devSignInTenant, signInWithPassword, signUpWithPassword } from "./firebase";
import { Sidebar } from "./components/Sidebar";
import { UploadBar } from "./components/UploadBar";
import { ChatWindow, ChatMessage } from "./components/ChatWindow";
import { DocumentList, DocumentMeta } from "./components/DocumentList";
import { MembersPanel, Member } from "./components/MembersPanel";
import { AuthForm } from "./components/AuthForm";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Privacy } from "./pages/Privacy";
import { DEMO, demoFetch } from "./demoBackend";
import "./styles.css";

const API          = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";
const USE_EMULATOR = import.meta.env.VITE_FIREBASE_USE_EMULATOR === "true";

// In demo mode all API calls are served by an in-browser mock (no server).
const apiFetch: typeof fetch = DEMO
  ? ((input, init) => demoFetch(input as string, init as RequestInit)) as typeof fetch
  : fetch;

const DEV_TENANTS = [
  { label: "Demo",     email: "demo@ragaas.local" },
  { label: "Tenant A", email: "tenant-a@ragaas.local" },
  { label: "Tenant B", email: "tenant-b@ragaas.local" },
];

type Status = {
  tenant_id: string;
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

// Privacy page — simple path check, no router needed
if (window.location.pathname === "/privacy") {
  createRoot(document.getElementById("root")!).render(<Privacy />);
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
  const tokenRef                      = useRef("");
  const currentUidRef                 = useRef("");

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
      const res  = await apiFetch(`${API}/api/chat`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
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

  // ── Auth: prod mode (form sign-in) ──────────────────────────────────────
  const handleProdAuth = useCallback(async (email: string, password: string, isNew: boolean) => {
    try {
      const cred = isNew
        ? await signUpWithPassword(email, password)
        : await signInWithPassword(email, password);
      const token = await cred.user.getIdToken();
      currentUidRef.current = cred.user.uid;
      tokenRef.current = token;
      setIdToken(token);
      setOnline(true);
      setAuthState("Authenticated");
      setTenantEmail(email);
      setMessages(loadChatHistory(email));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Auth failed";
      setAuthState(msg);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [idToken, refreshStatus]);

  // ── Prod: show auth form ─────────────────────────────────────────────────
  if (!USE_EMULATOR && !online) {
    return (
      <div className="shell">
        <nav className="global-nav">
          <span className="nav-brand">RAGaaS</span>
          <span className="nav-spacer" />
          <div className="nav-status">
            <span className="nav-dot offline" />
            Sign in to continue
          </div>
        </nav>
        <ErrorBoundary>
          <AuthForm onAuth={handleProdAuth} error={authState === "idle" ? "" : authState} />
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
        <span className="nav-spacer" />
        <motion.div
          className="nav-status"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          <span className={`nav-dot${!online ? (authState === "Signing in…" ? " pending" : " offline") : ""}`} />
          {online ? (status?.tenant_id ?? tenantEmail) : authState}
        </motion.div>
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
            disabled={!online}
          />
        </ErrorBoundary>
      </main>
    </div>
  );
}
