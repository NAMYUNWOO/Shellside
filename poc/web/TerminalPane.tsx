// The only file that knows about wterm. Swap or fork the terminal here.
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@wterm/react";
import type { WTerm } from "@wterm/dom";
import "@wterm/react/css";
import { useApi, wsUrl } from "./api.ts";
import { useT, type T } from "./i18n.tsx";

type Status = "connecting" | "open" | "closed" | "exited";
const statusLabel = (s: Status, t: T) =>
  ({ connecting: t("connecting", "연결 중"), open: t("connected", "연결됨"), closed: t("reconnecting", "재연결 중"), exited: t("shell exited", "셸 종료됨") })[s];

interface TerminalPaneProps {
  boardId: string;
  boardName: string;
  onNotice: (msg: string) => void;
  /** The window is shown: focus the terminal. */
  visible: boolean;
  maximized: boolean;
  claudeRunning: boolean;
  onClose: () => void;
  onToggleMax: () => void;
  /** Output arrived (lets the closed window's button show that something is happening). */
  onActivity: () => void;
}

export function TerminalPane({ boardId, boardName, onNotice, visible, maximized, claudeRunning, onClose, onToggleMax, onActivity }: TerminalPaneProps) {
  const api = useApi();
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [wt, setWt] = useState<WTerm | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // True while replayed output is written: the terminal's answers to old queries in it must not reach the shell.
  const muted = useRef(false);


  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // Shown again: take over the shell's size (another window or a hidden pane may have set it) and focus.
  useEffect(() => {
    if (!visible || !wt) return;
    send({ t: "resize", cols: wt.cols, rows: wt.rows });
    wt.focus();
  }, [visible, wt, send]);

  useEffect(() => {
    if (!wt) return;
    let closed = false;
    let retry = 0;
    let first = true;
    let replayNext = false;
    let timer: number | undefined;
    const connect = () => {
      const ws = new WebSocket(wsUrl(`/ws/pty?board=${encodeURIComponent(boardId)}`));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      setStatus("connecting");
      ws.onopen = () => {
        retry = 0;
        setStatus("open");
        // On reconnect the server replays recent output, so start from a clean screen.
        if (!first) wt.write("\x1bc");
        first = false;
        // A hidden pane attaches without resizing the shell; the visible one owns its size.
        ws.send(JSON.stringify({ t: "init", cols: wt.cols, rows: wt.rows, resize: visibleRef.current }));
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          const msg = JSON.parse(e.data);
          if (msg.t === "exit") {
            setStatus("exited");
            const note = tRef.current(
              `The shell exited (code ${msg.code}). Press "Restart shell" above`,
              `셸이 종료되었습니다 (code ${msg.code}). 위의 "셸 다시 시작"을 누르세요`,
            );
            wt.write(`\r\n\x1b[2m[${note}]\x1b[0m\r\n`);
          }
          if (msg.t === "replay") replayNext = true;
          return;
        }
        const bytes = new Uint8Array(e.data as ArrayBuffer);
        if (replayNext) {
          // wterm answers queries while it writes, so muting around the write drops exactly those answers.
          replayNext = false;
          muted.current = true;
          try {
            wt.write(bytes);
          } finally {
            muted.current = false;
          }
        } else wt.write(bytes);
        activityRef.current();
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (closed) return;
        setStatus("closed");
        timer = window.setTimeout(connect, Math.min(500 * 2 ** retry++, 8000));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [wt, boardId]);

  const restart = () => {
    if (!wt) return;
    wt.write("\x1bc");
    send({ t: "restart", cols: wt.cols, rows: wt.rows });
    setStatus("open");
    wt.focus();
  };

  const startClaude = () => {
    send({ t: "in", d: "claude\r" });
    wt?.focus();
  };

  // Scenario B: lines selected in the terminal become a table the person can triage.
  const selectionToTable = async () => {
    const text = wt?.getSelectionText();
    const lines = (text ?? "")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim())
      .slice(0, 500);
    if (!lines.length) return onNotice(t("First drag to select the lines you want in the terminal.", "터미널에서 가져올 줄을 먼저 드래그해 선택하세요."));
    try {
      await api.createTool({
        kind: "table",
        title: t("Lines from the terminal", "터미널에서 가져온 줄"),
        description: t(`${lines.length} lines from the terminal selection. Triage them, then send them to the agent.`, `터미널 선택 영역 ${lines.length}줄. 분류 후 agent에게 보내세요.`),
        props: {
          columns: [
            { key: "line", label: t("Line", "내용"), type: "text" },
            { key: "triage", label: t("Triage", "분류"), type: "select", options: [t("Fix", "고침"), t("Ignore", "무시"), t("Later", "나중")] },
          ],
        },
        state: { rows: lines.map((line, i) => ({ id: `r${i + 1}`, line, triage: "" })) },
      });
      onNotice(t(`Made a table from ${lines.length} lines.`, `${lines.length}줄로 표를 만들었습니다.`));
    } catch (err) {
      onNotice((err as Error).message);
    }
  };

  const keepSelection = (e: React.MouseEvent) => e.preventDefault();

  return (
    <section className="pane terminal-pane" aria-label={t("Terminal", "터미널")}>
      <header className="pane-head">
        <h2>
          {t("Terminal", "터미널")} <span className="muted">· {boardName}</span>
        </h2>
        <span className={`status status-${status}`}>{statusLabel(status, t)}</span>
        <div className="spacer" />
        {status === "exited" ? (
          <button onClick={restart}>{t("Restart shell", "셸 다시 시작")}</button>
        ) : (
          !claudeRunning && (
            <button
              onMouseDown={keepSelection}
              onClick={startClaude}
              disabled={status !== "open"}
              title={t("Types claude into the terminal to start Claude Code", "터미널에 claude를 입력해 Claude Code를 시작합니다")}
            >
              {t("Start Claude Code", "Claude Code 시작")}
            </button>
          )
        )}
        <button onMouseDown={keepSelection} onClick={selectionToTable} disabled={!wt} title={t("Turns the lines you dragged in the terminal into a table", "터미널에서 드래그한 줄을 표 도구로 만듭니다")}>
          {t("Selection → table", "선택 영역 → 표")}
        </button>
        <button className="icon" onClick={onToggleMax} aria-label={maximized ? t("Restore", "작게") : t("Maximize", "크게")} title={maximized ? t("Restore", "작게") : t("Maximize", "크게")}>
          {maximized ? "▭" : "□"}
        </button>
        <button className="icon" onClick={onClose} aria-label={t("Close terminal", "터미널 닫기")} title={t("Close (the shell keeps running) · Ctrl+`", "닫기 (셸은 계속 실행됩니다) · Ctrl+`")}>
          ×
        </button>
      </header>
      <div className="term-wrap">
        <Terminal
          className="term"
          autoResize
          aria-label={t("Work shell", "작업 셸")}
          onReady={setWt}
          onData={(d) => !muted.current && send({ t: "in", d })}
          onResize={(cols, rows) => visibleRef.current && send({ t: "resize", cols, rows })}
        />
      </div>
    </section>
  );
}
