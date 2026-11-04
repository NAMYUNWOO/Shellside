// Modal dialogs: send a request to Claude about selected tools, save a tool to the library, open a code editor.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Section, Tool } from "../shared/catalog.ts";
import { api as globalApi, desktop, useApi, ApiError, type AgentStatus } from "./api.ts";
import { IS_MAC } from "./keys.ts";
import { kindLabel, useT, type T } from "./i18n.tsx";
import { ShellsideMark } from "./ShellsideMark.tsx";

export function Modal({ title, onClose, children, wide }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const t = useT();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true">
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="ghost icon" onClick={onClose} aria-label={t("Close", "닫기")}>
            ×
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

const suggestions = (t: T) => [t("Fix this tool: ", "이 도구를 고쳐줘: "), t("Based on this data, ", "이 데이터를 바탕으로 "), t("Make another one like this: ", "비슷한 것을 하나 더 만들어줘: ")];

export function SendToClaudeDialog({
  tools,
  sections = [],
  status,
  onClose,
  onNotice,
  onSent,
  onOpenTerminal,
}: {
  tools: Tool[];
  /** Sections the request is about (their tools come along). */
  sections?: Section[];
  status: AgentStatus | null;
  onClose: () => void;
  onNotice: (m: string) => void;
  onSent: (mode: "claude" | "started") => void;
  onOpenTerminal: () => void;
}) {
  const api = useApi();
  const t = useT();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const running = !!status?.terminal.claudeRunning;
  const loggedIn = status?.claude.loggedIn !== false && !status?.terminal.loginRequired;
  const state = status?.terminal.agentState ?? "none";
  const blocked = state === "permission" || state === "starting";

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.sendToAgent(
        prompt,
        tools.map((tool) => tool.id),
        sections.map((sec) => sec.id),
      );
      onNotice(r.mode === "claude" ? t("Sent to Claude.", "Claude에게 보냈습니다.") : t("Started Claude in the terminal with your request.", "터미널에서 Claude를 시작해 요청을 보냈습니다."));
      onSent(r.mode);
      onClose();
    } catch (err) {
      onNotice((err as Error).message);
      if (err instanceof ApiError && err.data?.reason) onOpenTerminal();
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={
        <>
          <ShellsideMark size={20} /> {t("Send to Claude", "Claude에게 보내기")}
        </>
      }
    >
      {tools.length + sections.length > 0 && (
        <div className="chips" aria-label={t("Target tools", "대상 도구")}>
          {sections.map((sec) => (
            <span key={sec.id} className="chip">
              <b>{sec.title}</b> <span className="muted">{t("section", "섹션")}</span>
            </span>
          ))}
          {tools.map((tool) => (
            <span key={tool.id} className="chip">
              <b>{tool.title}</b> <span className="muted">{kindLabel(tool.kind, t)}</span>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="prompt-input"
        rows={5}
        value={prompt}
        placeholder={
          tools.length
            ? t("What should Claude do with these tools? e.g. Summarize the progress as a table in a new note", "이 도구로 무엇을 할지 적어 주세요. 예: 진행 상황을 표로 요약해서 새 메모로 만들어줘")
            : t("Message to Claude", "Claude에게 할 말")
        }
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="suggestions">
        {suggestions(t).map((s) => (
          <button key={s} className="ghost" onClick={() => (setPrompt((p) => (p ? p : s)), ref.current?.focus())}>
            {s.trim()}…
          </button>
        ))}
      </div>
      <p className={`send-mode${!loggedIn || blocked ? " warn" : ""}`}>
        {!loggedIn
          ? t("Claude needs you to sign in. Run claude in the terminal, then /login.", "Claude 로그인이 필요합니다. 터미널에서 claude 실행 후 /login 하세요.")
          : state === "permission"
            ? t(
                "Claude is waiting for a permission answer in the terminal. Answer it there first, then send.",
                "Claude가 터미널에서 권한 확인을 기다리고 있습니다. 먼저 터미널에서 답해야 보낼 수 있습니다.",
              )
            : state === "starting"
              ? t("Claude isn't ready yet (folder trust prompt, etc.). Check the terminal, then send.", "Claude가 아직 준비되지 않았습니다(폴더 신뢰 확인 등). 터미널에서 확인한 뒤 보내세요.")
              : state === "busy"
                ? t("Claude is working. If you send now, your request is queued next.", "Claude가 작업 중입니다. 지금 보내면 다음 차례로 대기열에 들어갑니다.")
                : running
                  ? t("Types your request into the running Claude in the terminal and presses Enter.", "터미널에서 실행 중인 Claude의 입력창에 넣고 Enter를 누릅니다.")
                  : t(
                      "Claude isn't running in the terminal, so this starts Claude with your request. The terminal will open.",
                      "터미널에서 Claude가 실행 중이 아니라, 이 요청으로 Claude를 새로 시작합니다. 터미널이 열립니다.",
                    )}
        {blocked && (
          <button className="ghost" onClick={onOpenTerminal}>
            {t("Open terminal", "터미널 열기")}
          </button>
        )}
      </p>
      <footer className="modal-foot">
        <span className="muted">⌘/Ctrl+Enter</span>
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>
          {t("Cancel", "취소")}
        </button>
        <button className="primary" disabled={!prompt.trim() || busy || blocked} onClick={submit}>
          {t("Send", "보내기")}
        </button>
      </footer>
    </Modal>
  );
}

export function SaveToLibraryDialog({ tool, onClose, onNotice }: { tool: Tool; onClose: () => void; onNotice: (m: string) => void }) {
  const api = useApi();
  const t = useT();
  const [name, setName] = useState(tool.title);
  const [description, setDescription] = useState(tool.description);
  const [includeState, setIncludeState] = useState(false);
  const [busy, setBusy] = useState(false);
  const keepHint: Record<string, string> = {
    checklist: t("Keeps the items, clears checks and notes.", "항목 구성은 남기고 체크·메모는 비웁니다."),
    form: t("Keeps the fields, clears the entered values.", "입력칸 구성은 남기고 입력값은 비웁니다."),
    table: t("Keeps the columns, clears the rows.", "열 구성은 남기고 행은 비웁니다."),
    note: t("Saves the text as it is.", "글 내용은 그대로 저장합니다."),
    app: t("Keeps the app code, clears the app state.", "앱 코드는 남기고 앱 상태는 비웁니다."),
    browser: t("Keeps the address; tabs and sign-ins are not saved with it.", "주소만 남깁니다. 탭과 로그인 상태는 저장되지 않습니다."),
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.saveToLibrary(tool.id, { name, description, includeState });
      onNotice(t(`Saved "${name}" to the library.`, `"${name}"을(를) 라이브러리에 저장했습니다.`));
      onClose();
    } catch (err) {
      onNotice((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={t("Save to library", "라이브러리에 저장")} onClose={onClose}>
      <label className="field">
        <span>{t("Name", "이름")}</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && save()} />
      </label>
      <label className="field">
        <span>{t("Description (Claude reads it when searching)", "설명 (Claude가 찾을 때 읽습니다)")}</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={includeState} onChange={(e) => setIncludeState(e.target.checked)} />
        {t("Also save the current data", "현재 데이터도 함께 저장")}
      </label>
      <p className="muted small">{includeState ? t("Saves the data you see now, as it is.", "지금 보이는 데이터까지 그대로 저장합니다.") : keepHint[tool.kind]}</p>
      <footer className="modal-foot">
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>
          {t("Cancel", "취소")}
        </button>
        <button className="primary" disabled={!name.trim() || busy} onClick={save}>
          {t("Save", "저장")}
        </button>
      </footer>
    </Modal>
  );
}

/** Open a code editor on a folder (a project) or one file on this machine. The board's work folder is the default. */
export function CodeOpenDialog({ boardId, at, onClose, onOpened, onNotice }: { boardId: string; at: { x: number; y: number }; onClose: () => void; onOpened: (tool: Tool) => void; onNotice: (m: string) => void }) {
  const api = useApi();
  const t = useT();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    globalApi.listBoards().then(
      (r) => setPath((p) => p || (r.boards.find((b) => b.id === boardId)?.workspace ?? "")),
      () => {},
    );
  }, [boardId]);
  const pick = async (files: boolean) => {
    const chosen = await desktop?.pickPath({ files }).catch(() => "");
    if (chosen) setPath(chosen);
    input.current?.focus();
  };
  const open = async () => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      onOpened(await api.openCode(path.trim(), at));
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={t("Open in a code editor", "코드 편집기로 열기")} onClose={onClose}>
      <label className="field">
        <span>{t("A folder (project) or a file on this computer", "이 컴퓨터의 폴더(프로젝트) 또는 파일")}</span>
        <div className="path-row">
          <input
            ref={input}
            autoFocus
            spellCheck={false}
            value={path}
            placeholder={IS_MAC ? "/Users/me/project" : "C:\\Users\\me\\project"}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && open()}
          />
          {desktop?.pickPath &&
            (IS_MAC ? (
              <button className="ghost" onClick={() => pick(true)}>
                {t("Choose…", "선택…")}
              </button>
            ) : (
              <>
                <button className="ghost" onClick={() => pick(false)}>
                  {t("Folder…", "폴더…")}
                </button>
                <button className="ghost" onClick={() => pick(true)}>
                  {t("File…", "파일…")}
                </button>
              </>
            ))}
        </div>
      </label>
      <p className="muted small">
        {t(
          "The editor shows that folder and nothing outside it. You and Claude edit the same files: when Claude changes a file you have open, the editor shows the new version.",
          "편집기는 그 폴더만 보여 주고 바깥은 열지 않습니다. 사용자와 Claude가 같은 파일을 고칩니다. 열어 둔 파일을 Claude가 바꾸면 편집기에 새 내용이 보입니다.",
        )}
      </p>
      {error && <p className="error small">{error}</p>}
      <footer className="modal-foot">
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>
          {t("Cancel", "취소")}
        </button>
        <button className="primary" disabled={!path.trim() || busy} onClick={open}>
          {t("Open", "열기")}
        </button>
      </footer>
    </Modal>
  );
}
