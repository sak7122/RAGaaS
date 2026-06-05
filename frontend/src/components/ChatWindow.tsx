import { FormEvent, useEffect, useRef } from "react";
import { Send, MessageSquare } from "lucide-react";

export type Citation = { file_name: string; page: number; excerpt: string };
export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
};

interface ChatWindowProps {
  messages: ChatMessage[];
  question: string;
  isLoading: boolean;
  onQuestionChange: (q: string) => void;
  onSend: (e: FormEvent) => void;
  disabled: boolean;
}

function CitationItem({ c }: { c: Citation }) {
  return (
    <div className="citation">
      <span className="citation-meta">{c.file_name} p.{c.page}</span>
      <span className="citation-excerpt">{c.excerpt}</span>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  return (
    <div className={`message ${msg.role}`}>
      <div className="bubble">{msg.text}</div>
      {msg.citations && msg.citations.length > 0 && (
        <div className="citations">
          {msg.citations.map((c) => (
            <CitationItem key={`${c.file_name}-${c.page}`} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({
  messages,
  question,
  isLoading,
  onQuestionChange,
  onSend,
  disabled,
}: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  return (
    <div className="chat">
      <div className="messages">
        {messages.length === 0 && !isLoading && (
          <div className="empty-state">
            <div className="empty-state-icon">
              <MessageSquare size={22} />
            </div>
            <p className="empty-state-text">
              Upload a PDF, then ask about its contents.
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}
        {isLoading && (
          <div className="loading-dots">
            <span className="loading-dot" />
            <span className="loading-dot" />
            <span className="loading-dot" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form className="chat-form" onSubmit={onSend}>
        <input
          className="chat-input"
          value={question}
          onChange={(e) => onQuestionChange(e.target.value)}
          placeholder="Ask a question about your documents…"
          disabled={disabled || isLoading}
          autoComplete="off"
        />
        <button
          className="btn-primary"
          type="submit"
          disabled={disabled || isLoading || !question.trim()}
          style={{ padding: "11px 18px", fontSize: 14 }}
        >
          <Send size={14} />
          Send
        </button>
      </form>
    </div>
  );
}
