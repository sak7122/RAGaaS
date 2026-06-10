import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { devSignInTenant, signInWithPassword, signUpWithPassword } from "./firebase";
import { Sidebar } from "./components/Sidebar";
import { UploadBar } from "./components/UploadBar";
import { ChatWindow, ChatMessage } from "./components/ChatWindow";
import { DocumentList, DocumentMeta } from "./components/DocumentList";
import { AuthForm } from "./components/AuthForm";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

const API          = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";
const USE_EMULATOR = import.meta.env.VITE_FIREBASE_USE_EMULATOR === "true";

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

type UploadState = {
  msg: string;
  type: "idle" | "uploading" | "success" | "error";
  progress: number; // 0-100
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
  } catch { /* storage full — ignore */ }
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
  const [upload, setUpload]           = useState<UploadState>({ msg: "", type: "idle", progress: 0 });
  const [docs, setDocs]               = useState<DocumentMeta[]>([]);
  const [deleting, setDeleting]       = useState<string | null>(null);
  const [refreshing, setRefreshing]   = useState(false);
  const [authEpoch, setAuthEpoch]     = useState(0);
  const tokenRef                      = useRef("");

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${tokenRef.current}` };
  }

  function handleSessionExpired() {
    tokenRef.current = "";
    setIdToken("");
    setOnline(false);
    setAuthState("Session expired — please sign in again");
    setStatus(null);
    setDocs([]);
    setMessages([]);
    setQuestion("");
    // In emulator mode, bump the epoch so the auth useEffect re-fires and re-signs-in.
    if (USE_EMULATOR) setAuthEpoch((e) => e + 1);
  }

  const refreshStatus = useCallback(async () => {
    if (!tokenRef.current) return;
    setRefreshing(true);
    try {
      const [statusRes, docsRes] = await Promise.all([
        fetch(`${API}/api/tenant/status`, { headers: authHeaders() }),
        fetch(`${API}/api/documents`,     { headers: authHeaders() }),
      ]);
      if (statusRes.status === 401 || statusRes.status === 403 ||
          docsRes.status  === 401 || docsRes.status  === 403) {
        handleSessionExpired();
        return;
      }
      if (statusRes.ok) setStatus(await statusRes.json());
      if (docsRes.ok)   setDocs(await docsRes.json());
    } catch { /* backend may be starting */ } finally {
      setRefreshing(false);
    }
  }, []);

  async function handleUpload(file: File) {
    setUpload({ msg: "Uploading…", type: "uploading", progress: 0 });
    try {
      const data = new FormData();
      data.append("file", file);

      const result = await new Promise<{ ok: boolean; body: Record<string, unknown> }>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API}/api/upload`);
        const hdrs = authHeaders();
        Object.entries(hdrs).forEach(([k, v]) => xhr.setRequestHeader(k, v));

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUpload((prev) => ({ ...prev, progress: Math.round((e.loaded / e.total) * 100) }));
          }
        };

        xhr.onload = () => {
          if (xhr.status === 401 || xhr.status === 403) {
            handleSessionExpired();
            resolve({ ok: false, body: { detail: "Session expired — please sign in again" } });
            return;
          }
          try {
            resolve({ ok: xhr.status < 300, body: JSON.parse(xhr.responseText) });
          } catch {
            resolve({ ok: false, body: { detail: "Invalid server response" } });
          }
        };

        xhr.onerror = () => resolve({ ok: false, body: { detail: "Network error" } });
        xhr.send(data);
      });

      if (result.ok) {
        const chunks = result.body.chunks as number;
        setUpload({ msg: `${result.body.file_name} · ${chunks} chunks indexed`, type: "success", progress: 100 });
        refreshStatus();
      } else {
        setUpload({ msg: String(result.body.detail ?? "Upload failed"), type: "error", progress: 0 });
      }
    } catch {
      setUpload({ msg: "Network error", type: "error", progress: 0 });
    }
  }

  async function handleDelete(fileName: string) {
    setDeleting(fileName);
    try {
      const res = await fetch(`${API}/api/documents/${encodeURIComponent(fileName)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.status === 401 || res.status === 403) {
        handleSessionExpired();
        return;
      }
      if (res.ok) {
        setDocs((prev) => prev.filter((d) => d.file_name !== fileName));
      }
      // Always refresh so the list reflects true backend state on success or error.
      refreshStatus();
    } catch { /* network error — next refresh will sync */ } finally {
      setDeleting(null);
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const text = question.trim();
    if (!text) return;
    setQuestion("");
    const next: ChatMessage[] = [...messages, { role: "user", text }];
    setMessages(next);
    setIsLoading(true);
    try {
      const res  = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (res.status === 401 || res.status === 403) {
        handleSessionExpired();
        return;
      }
      const body = await res.json();
      const answer = res.ok ? body.answer : (body.detail ?? "Something went wrong.");
      const updated: ChatMessage[] = [
        ...next,
        { role: "assistant", text: answer, citations: body.citations ?? [] },
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

  // ── Auth: dev emulator mode (auto sign-in) ──────────────────────────────
  useEffect(() => {
    if (!USE_EMULATOR || !tenantEmail) return;
    let live = true;
    setAuthState("Signing in…");
    setOnline(false);
    setIdToken("");
    setStatus(null);
    setDocs([]);
    tokenRef.current = "";
    const history = loadChatHistory(tenantEmail);
    setMessages(history);

    devSignInTenant(tenantEmail)
      .then((token) => {
        if (!live) return;
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
  }, [tenantEmail, authEpoch]);

  // ── Auth: prod mode (form sign-in, handled by AuthForm) ────────────────
  const handleProdAuth = useCallback(async (email: string, password: string, isNew: boolean) => {
    try {
      const cred = isNew
        ? await signUpWithPassword(email, password)
        : await signInWithPassword(email, password);
      const token = await cred.user.getIdToken();
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

  // ── Prod: show auth form when not signed in ─────────────────────────────
  if (!USE_EMULATOR && !online) {
    return (
      <div className="shell">
        <nav className="global-nav">
          <span className="nav-brand">RAGaaS</span>
        </nav>
        <ErrorBoundary>
          <AuthForm onAuth={handleProdAuth} error={authState === "idle" ? "" : authState} />
        </ErrorBoundary>
      </div>
    );
  }

  return (
    <div className="shell">
      <nav className="global-nav">
        <span className="nav-brand">RAGaaS</span>
        <span className="nav-subtitle">{USE_EMULATOR ? "Local sandbox" : tenantEmail}</span>
      </nav>

      <ErrorBoundary>
        <Sidebar
          tenants={USE_EMULATOR ? DEV_TENANTS : []}
          tenantEmail={tenantEmail}
          onTenantChange={(email) => {
            if (upload.type === "uploading") return;
            setTenantEmail(email);
            setMessages(loadChatHistory(email));
            setUpload({ msg: "", type: "idle", progress: 0 });
          }}
          status={status}
          authState={authState}
          online={online}
          onRefresh={refreshStatus}
          refreshing={refreshing}
          extraSlot={
            <DocumentList docs={docs} onDelete={handleDelete} deleting={deleting} />
          }
        />
      </ErrorBoundary>

      <main className="workspace">
        <UploadBar
          onUpload={handleUpload}
          status={upload.msg}
          statusType={upload.type}
          progress={upload.progress}
        />
        <ErrorBoundary>
          <ChatWindow
            messages={messages}
            question={question}
            isLoading={isLoading}
            onQuestionChange={setQuestion}
            onSend={handleSend}
            disabled={!online}
          />
        </ErrorBoundary>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
