// Approval / input requests from the agent, floating over the canvas until answered.
import { useState } from "react";
import type { Ask, Tool } from "../shared/catalog.ts";
import { useApi } from "./api.ts";
import { FieldInput } from "./tools.tsx";
import { ago, useT } from "./i18n.tsx";

export function AskCard({ ask, tool, now, onNotice, onLocate }: { ask: Ask; tool?: Tool; now: number; onNotice: (m: string) => void; onLocate?: () => void }) {
  const api = useApi();
  const t = useT();
  const [comment, setComment] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const item = tool?.kind === "checklist" && ask.itemId ? tool.state.items.find((i: any) => i.id === ask.itemId) : undefined;

  const answer = async (body: { approved?: boolean; values?: Record<string, unknown> }) => {
    setBusy(true);
    try {
      await api.answerAsk(ask.id, { ...body, comment: comment.trim() || undefined });
    } catch (err) {
      onNotice((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <article className={`card ask-card ask-${ask.kind}`} aria-label={ask.title}>
      <header className="ask-head">
        <span className="pulse" aria-hidden />
        <span className="muted">
          {t("agent is waiting", "agent가 기다리는 중")} · {ago(ask.createdAt, now, t)}
        </span>
        <span className="spacer" />
        {onLocate && (
          <button className="ghost" onClick={onLocate}>
            {t("Show on board", "위치 보기")}
          </button>
        )}
      </header>
      <h3>{ask.title}</h3>
      {(tool || item) && (
        <p className="ask-context">
          {tool?.title}
          {item && <> › {item.label}</>}
        </p>
      )}
      {ask.message && <p className="ask-message">{ask.message}</p>}

      {ask.kind === "input" && (
        <form
          className="form-tool"
          onSubmit={(e) => {
            e.preventDefault();
            answer({ values });
          }}
        >
          {ask.fields?.map((f) => (
            <FieldInput key={f.name} field={f} value={values[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
          ))}
          <input className="comment" value={comment} placeholder={t("Note (optional)", "메모 (선택)")} onChange={(e) => setComment(e.target.value)} />
          <div className="form-foot">
            <button type="submit" className="primary" disabled={busy}>
              {t("Send", "보내기")}
            </button>
          </div>
        </form>
      )}

      {ask.kind === "approval" && (
        <>
          <input className="comment" value={comment} placeholder={t("Note (optional)", "메모 (선택)")} onChange={(e) => setComment(e.target.value)} />
          <div className="form-foot">
            <button className="ghost" disabled={busy} onClick={() => answer({ approved: false })}>
              {t("Reject", "거절")}
            </button>
            <button className="primary" disabled={busy} onClick={() => answer({ approved: true })}>
              {t("Approve", "승인")}
            </button>
          </div>
        </>
      )}
    </article>
  );
}
