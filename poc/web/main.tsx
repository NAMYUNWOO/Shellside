import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiProvider, type BoardSummary } from "./api.ts";
import { BoardPanel } from "./BoardPanel.tsx";
import { BoardsPanel } from "./BoardsPanel.tsx";
import { TerminalButton } from "./TerminalButton.tsx";
import { TerminalPane } from "./TerminalPane.tsx";
import { useAgentStatus } from "./useAgentStatus.ts";
import { LangProvider, useT } from "./i18n.tsx";
import "./styles.css";

function stored<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s === null ? fallback : (JSON.parse(s) as T);
  } catch {
    return fallback;
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

interface Notice {
  text: string;
  key: number;
  action?: { label: string; run: () => void };
}

function App() {
  const t = useT();
  const [notice, setNotice] = useState<Notice | null>(null);
  const show = useCallback((text: string, action?: Notice["action"]) => setNotice({ text, key: Date.now(), action }), []);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [activeId, setActiveId] = useState<string>(() => decodeURIComponent(location.hash.slice(1)) || stored("wb.board", ""));
  const [panelOpen, setPanelOpen] = useState(() => stored("wb.boardsOpen", true));
  const [termOpen, setTermOpen] = useState(false);
  const [termMax, setTermMax] = useState(() => stored("wb.termMax", false));
  // Boards opened in this window keep running in the background (canvas, apps, terminal); only the active one shows.
  const [visited, setVisited] = useState<string[]>([]);
  const [activity, setActivity] = useState<Record<string, boolean>>({});
  const { status, refresh } = useAgentStatus(activeId);

  const reloadBoards = useCallback(() => api.listBoards().then((r) => setBoards(r.boards), () => {}), []);
  useEffect(() => {
    reloadBoards();
    const id = window.setInterval(reloadBoards, 2000);
    return () => clearInterval(id);
  }, [reloadBoards]);

  useEffect(() => {
    if (boards.length && !boards.some((b) => b.id === activeId)) setActiveId(boards[0].id);
  }, [boards, activeId]);

  useEffect(() => {
    if (!activeId) return;
    history.replaceState(null, "", `#${encodeURIComponent(activeId)}`);
    store("wb.board", activeId);
    setVisited((m) => (m.includes(activeId) ? m : [...m, activeId]));
    setActivity((a) => (a[activeId] ? { ...a, [activeId]: false } : a));
  }, [activeId]);
  useEffect(() => {
    const onHash = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (id) setActiveId(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => store("wb.boardsOpen", panelOpen), [panelOpen]);
  useEffect(() => store("wb.termMax", termMax), [termMax]);
  useEffect(() => {
    if (termOpen) setActivity((a) => (a[activeId] ? { ...a, [activeId]: false } : a));
  }, [termOpen, activeId]);

  // Other boards keep working in parallel: tell the person when one needs them or finishes.
  const prev = useRef(new Map<string, BoardSummary>());
  useEffect(() => {
    const before = prev.current;
    for (const b of boards) {
      const p = before.get(b.id);
      if (!p || b.id === activeId) continue;
      const open = { label: t("Open", "열기"), run: () => setActiveId(b.id) };
      if (b.pendingAsks > p.pendingAsks) show(t(`"${b.name}": Claude is waiting for your approval or input.`, `"${b.name}" 보드: Claude가 승인·입력을 기다립니다.`), open);
      else if (b.agentState === "permission" && p.agentState !== "permission")
        show(t(`"${b.name}": Claude is waiting for a permission answer in the terminal.`, `"${b.name}" 보드: Claude가 터미널에서 권한 확인을 기다립니다.`), open);
      else if (b.loginRequired && !p.loginRequired) show(t(`"${b.name}": Claude needs you to sign in.`, `"${b.name}" 보드: Claude 로그인이 필요합니다.`), open);
      else if (p.agentState === "busy" && b.agentState === "idle") show(t(`"${b.name}": Claude finished its work.`, `"${b.name}" 보드: Claude가 작업을 마쳤습니다.`), open);
    }
    prev.current = new Map(boards.map((b) => [b.id, b]));
  }, [boards, activeId, show, t]);

  // Ctrl+` toggles the terminal, like an editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === "Backquote") {
        e.preventDefault();
        setTermOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), notice.action ? 8000 : 4000);
    return () => clearTimeout(id);
  }, [notice]);

  const live = useRef({ activeId, termOpen });
  live.current = { activeId, termOpen };
  const onActivity = useCallback((id: string) => {
    const { activeId: a, termOpen: o } = live.current;
    if (id === a && o) return;
    setActivity((s) => (s[id] ? s : { ...s, [id]: true }));
  }, []);

  const createBoard = async () => {
    try {
      const nb = await api.createBoard(t(`New board ${boards.length + 1}`, `새 보드 ${boards.length + 1}`));
      await reloadBoards();
      setActiveId(nb.id);
      return nb.id;
    } catch (err) {
      show((err as Error).message);
    }
  };

  const deleteBoard = async (b: BoardSummary) => {
    if (
      !confirm(
        t(
          `Delete the board "${b.name}"?\nIts terminal (Claude session) will stop. Files in its work folder are kept.\n${b.workspace}`,
          `"${b.name}" 보드를 삭제할까요?\n이 보드의 터미널(Claude 세션)이 종료됩니다. 작업 폴더의 파일은 남습니다.\n${b.workspace}`,
        ),
      )
    )
      return;
    try {
      await api.deleteBoard(b.id);
      setVisited((m) => m.filter((id) => id !== b.id));
      await reloadBoards();
    } catch (err) {
      show((err as Error).message);
    }
  };

  const openInNewWindow = (id: string) => window.open(`${location.pathname}#${encodeURIComponent(id)}`, `workboard-${id}`);

  return (
    <div className="app" style={{ gridTemplateColumns: `${panelOpen ? 248 : 52}px minmax(0, 1fr)` }}>
      <BoardsPanel
        boards={boards}
        activeId={activeId}
        open={panelOpen}
        activity={activity}
        onToggle={() => setPanelOpen(!panelOpen)}
        onSelect={setActiveId}
        onCreate={createBoard}
        onRename={(id, name) => api.renameBoard(id, name).then(reloadBoards, (e) => show(e.message))}
        onDelete={deleteBoard}
        onOpenWindow={openInNewWindow}
        onNotice={show}
      />

      <div className="boards-stage">
        {!boards.some((b) => b.id === activeId) && <div className="loading muted">{t("Loading boards…", "보드를 불러오는 중…")}</div>}
        {visited.map((id) => {
          const b = boards.find((x) => x.id === id);
          if (!b) return null;
          const isActive = id === activeId;
          return (
            // inert: no clicks or Tab focus can reach a board running in the background.
            <div key={id} className={`board-slot${isActive ? "" : " background"}`} aria-hidden={!isActive} inert={!isActive}>
              <ApiProvider boardId={id}>
                <BoardPanel
                  boardId={id}
                  boardName={b.name}
                  active={isActive}
                  agentStatus={isActive ? status : null}
                  onNotice={isActive ? show : (m) => show(t(`"${b.name}": ${m}`, `"${b.name}" 보드: ${m}`), { label: t("Open", "열기"), run: () => setActiveId(id) })}
                  onSentToClaude={(mode) => {
                    // A fresh Claude may stop at the folder-trust prompt: show the terminal so the person sees it.
                    if (mode === "started") setTermOpen(true);
                    window.setTimeout(() => refresh(), 1500);
                  }}
                  onOpenTerminal={() => setTermOpen(true)}
                  onRefreshStatus={() => refresh(true)}
                  terminalButton={<TerminalButton open={termOpen} status={isActive ? status : null} activity={!!activity[id]} onClick={() => setTermOpen((o) => !o)} />}
                />
              </ApiProvider>
            </div>
          );
        })}
      </div>

      {/* One terminal per board, kept running once visited; only the active one shows (and sets the shell's size). */}
      {visited.map((id) => {
        const b = boards.find((x) => x.id === id);
        if (!b) return null;
        const shown = id === activeId && termOpen;
        return (
          <div key={id} className={`term-window${shown ? " open" : ""}${termMax ? " max" : ""}`} role="dialog" aria-label={t(`Terminal · ${b.name}`, `터미널 · ${b.name}`)} aria-hidden={!shown}>
            <ApiProvider boardId={id}>
              <TerminalPane
                boardId={id}
                boardName={b.name}
                visible={shown}
                maximized={termMax}
                claudeRunning={id === activeId ? !!status?.terminal.claudeRunning : b.claudeRunning}
                onClose={() => setTermOpen(false)}
                onToggleMax={() => setTermMax(!termMax)}
                onActivity={() => onActivity(id)}
                onNotice={show}
              />
            </ApiProvider>
          </div>
        );
      })}

      {notice && (
        <div className="toast" role="status" key={notice.key}>
          <span>{notice.text}</span>
          {notice.action && (
            <button
              className="toast-action"
              onClick={() => {
                notice.action!.run();
                setNotice(null);
              }}
            >
              {notice.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <LangProvider>
    <App />
  </LangProvider>,
);
