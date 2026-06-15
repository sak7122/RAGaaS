// RAGaaS embeddable chat widget — vanilla TS, shadow DOM, no framework deps.
// Usage:
//   <script src="https://your-app/widget.js"
//     data-widget-key="wk_..."
//     data-api-url="https://your-cloud-run-url"
//     data-title="Ask anything"
//     data-placeholder="Ask a question about our docs..."
//     data-primary-color="#0A84FF"
//   ></script>

(function () {
  // ── Config from script tag data attributes ────────────────────────────────
  const scripts = document.querySelectorAll<HTMLScriptElement>("script[data-widget-key]");
  const scriptEl = scripts[scripts.length - 1];
  if (!scriptEl) return;

  const cfg = {
    key: scriptEl.dataset.widgetKey ?? "",
    apiUrl: (scriptEl.dataset.apiUrl ?? "").replace(/\/$/, ""),
    title: scriptEl.dataset.title ?? "Ask our knowledge base",
    placeholder: scriptEl.dataset.placeholder ?? "Ask a question…",
    primary: scriptEl.dataset.primaryColor ?? "#0A84FF",
  };

  if (!cfg.key || !cfg.apiUrl) {
    console.warn("[RAGaaS widget] data-widget-key and data-api-url are required.");
    return;
  }

  // ── Shadow DOM container ──────────────────────────────────────────────────
  const host = document.createElement("div");
  host.id = "ragaas-widget-host";
  host.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  // ── Styles ────────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    *{box-sizing:border-box;margin:0;padding:0;}
    .btn{all:unset;cursor:pointer;}
    .fab{
      width:52px;height:52px;border-radius:50%;
      background:var(--p);color:#fff;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 4px 16px rgba(0,0,0,.20);
      transition:transform .15s,box-shadow .15s;
    }
    .fab:hover{transform:scale(1.06);box-shadow:0 6px 20px rgba(0,0,0,.25);}
    .fab:active{transform:scale(.95);}
    .panel{
      position:absolute;bottom:64px;right:0;
      width:360px;max-height:520px;
      background:#fff;border-radius:16px;
      box-shadow:0 8px 40px rgba(0,0,0,.18);
      display:flex;flex-direction:column;overflow:hidden;
      opacity:0;transform:scale(.92) translateY(12px);
      pointer-events:none;transition:opacity .2s,transform .2s;
    }
    .panel.open{opacity:1;transform:scale(1) translateY(0);pointer-events:all;}
    .panel-head{
      background:var(--p);color:#fff;
      padding:14px 16px;display:flex;align-items:center;gap:10px;
      font-weight:600;font-size:14px;
    }
    .panel-head-title{flex:1;}
    .close-btn{all:unset;cursor:pointer;opacity:.8;line-height:1;font-size:18px;}
    .close-btn:hover{opacity:1;}
    .messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;}
    .msg{max-width:85%;padding:9px 12px;border-radius:12px;font-size:13px;line-height:1.5;}
    .msg.user{align-self:flex-end;background:var(--p);color:#fff;border-bottom-right-radius:4px;}
    .msg.bot{align-self:flex-start;background:#f2f2f7;color:#1c1c1e;border-bottom-left-radius:4px;}
    .msg.error{background:#fff0f0;color:#c00;}
    .typing{display:flex;gap:5px;align-items:center;padding:9px 12px;}
    .dot{width:6px;height:6px;border-radius:50%;background:#999;animation:bounce .8s infinite;}
    .dot:nth-child(2){animation-delay:.12s;}
    .dot:nth-child(3){animation-delay:.24s;}
    @keyframes bounce{0%,80%,100%{transform:translateY(0);}40%{transform:translateY(-6px);}}
    .input-row{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #e5e5ea;}
    .inp{
      flex:1;border:1px solid #d1d1d6;border-radius:10px;padding:8px 12px;
      font-size:13px;outline:none;resize:none;max-height:80px;line-height:1.4;
      font-family:inherit;
    }
    .inp:focus{border-color:var(--p);}
    .send{
      all:unset;cursor:pointer;width:34px;height:34px;border-radius:50%;
      background:var(--p);color:#fff;display:flex;align-items:center;justify-content:center;
      flex-shrink:0;align-self:flex-end;transition:opacity .15s;
    }
    .send:disabled{opacity:.4;cursor:default;}
    .cite{font-size:11px;color:#888;margin-top:5px;display:flex;flex-wrap:wrap;gap:4px;}
    .cite-tag{background:#e5e5ea;border-radius:6px;padding:2px 6px;}
    .branding{text-align:center;font-size:10px;color:#aaa;padding:6px 0;}
    .branding a{color:#aaa;text-decoration:none;}
    .branding a:hover{text-decoration:underline;}
  `;
  shadow.appendChild(style);

  // ── CSS custom property for primary color ─────────────────────────────────
  const varStyle = document.createElement("style");
  varStyle.textContent = `:host { --p: ${cfg.primary}; }`;
  shadow.appendChild(varStyle);

  // ── HTML structure ─────────────────────────────────────────────────────────
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", cfg.title);
  panel.innerHTML = `
    <div class="panel-head">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
      <span class="panel-head-title">${escHtml(cfg.title)}</span>
      <button class="close-btn" aria-label="Close">✕</button>
    </div>
    <div class="messages" id="wg-msgs"></div>
    <div class="input-row">
      <textarea class="inp" id="wg-inp" placeholder="${escHtml(cfg.placeholder)}" rows="1" aria-label="Your question"></textarea>
      <button class="send" id="wg-send" disabled aria-label="Send">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
    <div class="branding">Powered by <a href="https://ragaas.app" target="_blank" rel="noopener">RAGaaS</a></div>
  `;
  shadow.appendChild(panel);

  const fab = document.createElement("button");
  fab.className = "fab btn";
  fab.setAttribute("aria-label", "Open knowledge base chat");
  fab.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  shadow.appendChild(fab);

  // ── State ─────────────────────────────────────────────────────────────────
  let isOpen = false;
  let isLoading = false;

  const msgsEl = shadow.getElementById("wg-msgs")!;
  const inpEl  = shadow.getElementById("wg-inp") as HTMLTextAreaElement;
  const sendEl = shadow.getElementById("wg-send") as HTMLButtonElement;

  // ── Toggle ────────────────────────────────────────────────────────────────
  function toggle() {
    isOpen = !isOpen;
    panel.classList.toggle("open", isOpen);
    fab.innerHTML = isOpen
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
      : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    if (isOpen) setTimeout(() => inpEl.focus(), 200);
  }

  fab.addEventListener("click", toggle);
  panel.querySelector(".close-btn")!.addEventListener("click", toggle);

  // ── Input auto-resize & send button ──────────────────────────────────────
  inpEl.addEventListener("input", () => {
    inpEl.style.height = "auto";
    inpEl.style.height = Math.min(inpEl.scrollHeight, 80) + "px";
    sendEl.disabled = !inpEl.value.trim() || isLoading;
  });

  inpEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sendEl.disabled) send();
    }
  });

  sendEl.addEventListener("click", send);

  // ── Message rendering ─────────────────────────────────────────────────────
  function appendMsg(role: "user" | "bot" | "error", text: string, citations?: Array<{ file_name: string; page: number }>) {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    div.textContent = text;
    if (citations && citations.length > 0) {
      const citeRow = document.createElement("div");
      citeRow.className = "cite";
      citations.forEach((c) => {
        const tag = document.createElement("span");
        tag.className = "cite-tag";
        tag.textContent = `${c.file_name.replace(".pdf", "")} p.${c.page}`;
        citeRow.appendChild(tag);
      });
      div.appendChild(citeRow);
    }
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return div;
  }

  function showTyping(): HTMLElement {
    const div = document.createElement("div");
    div.className = "typing";
    div.innerHTML = `<span class="dot"></span><span class="dot"></span><span class="dot"></span>`;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return div;
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  async function send() {
    const text = inpEl.value.trim();
    if (!text || isLoading) return;
    inpEl.value = "";
    inpEl.style.height = "auto";
    sendEl.disabled = true;
    isLoading = true;

    appendMsg("user", text);
    const typingEl = showTyping();

    try {
      const res = await fetch(`${cfg.apiUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Widget-Key": cfg.key },
        body: JSON.stringify({ message: text, history: [] }),
      });
      typingEl.remove();
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: `Error ${res.status}` }));
        appendMsg("error", err.detail ?? "Something went wrong. Please try again.");
      } else {
        const body = await res.json();
        appendMsg("bot", body.answer ?? "No answer returned.", body.citations ?? []);
      }
    } catch {
      typingEl.remove();
      appendMsg("error", "Network error — please check your connection.");
    } finally {
      isLoading = false;
      sendEl.disabled = !inpEl.value.trim();
    }
  }

  function escHtml(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
})();
