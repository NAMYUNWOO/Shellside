// One work board: a Figma-like canvas of tool frames, an inspector on the right, the agent's asks floating on top.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import type { Tool } from "../shared/catalog.ts";
import { useApi, ApiError, loginProblem, type AgentStatus } from "./api.ts";
import { ClaudeMark } from "./TerminalButton.tsx";
import { AskCard } from "./Asks.tsx";
import { BoardCanvas, useCanvasActions } from "./Canvas.tsx";
import { ContextMenu, type MenuItem } from "./ContextMenu.tsx";
import { SaveToLibraryDialog, SendToClaudeDialog } from "./Dialogs.tsx";
import { Inspector } from "./Inspector.tsx";
import { LibraryPanel } from "./Library.tsx";
import { LiveProvider } from "./live.ts";
import { useBoard, useNow } from "./useBoard.ts";
import { useT, type T } from "./i18n.tsx";

const isEditable = (el: Element | null) =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

interface BoardPanelProps {
  boardId: string;
  boardName: string;
  /** On screen. Background boards keep running (apps, sync) but take no keys and move no camera. */
  active: boolean;
  agentStatus: AgentStatus | null;
  /** The terminal button (lives in this header's top-right corner). */
  terminalButton: React.ReactNode;
  onNotice: (m: string) => void;
  onSentToClaude: (mode: "claude" | "started") => void;
  onOpenTerminal: () => void;
  onRefreshStatus: () => void;
}

export function BoardPanel(props: BoardPanelProps) {
  return (
    <ReactFlowProvider>
      <BoardView {...props} />
    </ReactFlowProvider>
  );
}

function usePersistent<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : (JSON.parse(s) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, [key, v]);
  return [v, setV] as const;
}

type Menu = { x: number; y: number; ids: string[]; at: { x: number; y: number } };

function BoardView({ boardId, boardName, active, agentStatus, terminalButton, onNotice, onSentToClaude, onOpenTerminal, onRefreshStatus }: BoardPanelProps) {
  const api = useApi();
  const t = useT();
  const { tools, toolsById, asks, events, library, channels, live, connected, ready } = useBoard(boardId);
  const now = useNow();
  const cam = useCanvasActions();
  const rf = useReactFlow();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [follow, setFollow] = usePersistent("wb.follow", true);
  const [libraryOpen, setLibraryOpen] = usePersistent("wb.libraryOpen", false);
  const [inspectorOpen, setInspectorOpen] = usePersistent("wb.inspectorOpen", true);
  const [minimap, setMinimap] = usePersistent("wb.minimap", false);
  const [tool, setTool] = usePersistent<"select" | "hand">("wb.tool", "select");
  const [menu, setMenu] = useState<Menu | null>(null);
  const [sendIds, setSendIds] = useState<string[] | null>(null);
  const [saveTool, setSaveTool] = useState<Tool | null>(null);
  const [appErrors, setAppErrors] = useState<Record<string, number>>({});
  const [activeUntil, setActiveUntil] = useState<Record<string, number>>({});
  const [tick, setTick] = useState(0);
  const lastInteract = useRef(0);
  const lastSeq = useRef<number | null>(null);

  const onInteract = useCallback(() => {
    lastInteract.current = Date.now();
  }, []);
  const onAppErrors = useCallback((id: string, n: number) => setAppErrors((e) => (e[id] === n ? e : { ...e, [id]: n })), []);
  const onSelect = useCallback((ids: string[]) => setSelectedIds((prev) => (prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids)), []);

  // Drop selections whose frames are gone.
  useEffect(() => {
    if (selectedIds.some((id) => !toolsById[id])) setSelectedIds((ids) => ids.filter((id) => toolsById[id]));
  }, [toolsById, selectedIds]);

  // Agent presence and "follow the agent", like following a collaborator in Figma.
  useEffect(() => {
    if (!ready) return;
    if (lastSeq.current === null) {
      lastSeq.current = events.at(-1)?.seq ?? 0; // history is not news
      return;
    }
    const fresh = events.filter((e) => e.seq > lastSeq.current!);
    if (!fresh.length) return;
    lastSeq.current = fresh.at(-1)!.seq;
    const touched = fresh.filter((e) => e.actor === "agent" && e.toolId && e.type !== "tool_deleted").map((e) => e.toolId!);
    if (!touched.length) return;
    const until = Date.now() + 3500;
    setActiveUntil((a) => ({ ...a, ...Object.fromEntries(touched.map((id) => [id, until])) }));
    const busy = Date.now() - lastInteract.current < 4000 || (isEditable(document.activeElement) && !!document.activeElement?.closest(".board-pane"));
    if (active && follow && !busy) window.setTimeout(() => cam.focusTool(touched.at(-1)!, { onlyIfHidden: true }), 80);
  }, [events, ready, follow, cam, active]);

  useEffect(() => {
    if (!Object.values(activeUntil).some((u) => u > Date.now())) return;
    const id = window.setTimeout(() => setTick((n) => n + 1), 500);
    return () => clearTimeout(id);
  }, [activeUntil, tick]);
  const activeKey = Object.entries(activeUntil)
    .filter(([, u]) => u > Date.now())
    .map(([id]) => id)
    .sort()
    .join(",");
  const activeIds = useMemo(() => new Set(activeKey.split(",").filter(Boolean)), [activeKey]);
  const waitingKey = asks
    .map((a) => a.toolId)
    .filter(Boolean)
    .sort()
    .join(",");
  const waitingIds = useMemo(() => new Set(waitingKey.split(",").filter(Boolean)), [waitingKey]);

  // A new ask pulls the camera to its frame (when following).
  const askCount = useRef(0);
  useEffect(() => {
    if (asks.length > askCount.current && follow && active) {
      const tid = asks.at(-1)?.toolId;
      if (tid) window.setTimeout(() => cam.focusTool(tid, { onlyIfHidden: true }), 80);
    }
    askCount.current = asks.length;
  }, [asks, follow, cam, active]);

  const pick = useCallback(
    (id: string) => {
      setSelectedIds([id]);
      cam.focusTool(id);
    },
    [cam],
  );
  const fitTo = useCallback((ids: string[]) => rf.fitView({ nodes: ids.map((id) => ({ id })), duration: 300, padding: 0.2, maxZoom: 1 }), [rf]);

  const removeTools = useCallback(
    async (ids: string[]) => {
      const names = ids.map((id) => toolsById[id]?.title).filter(Boolean);
      const question = ids.length === 1 ? t(`Delete "${names[0]}"?`, `"${names[0]}" 도구를 삭제할까요?`) : t(`Delete ${ids.length} tools?`, `${ids.length}개 도구를 삭제할까요?`);
      if (!names.length || !confirm(question)) return;
      for (const id of ids) await api.deleteTool(id).catch((err) => onNotice(err.message));
    },
    [toolsById, onNotice, api, t],
  );

  const duplicate = async (ids: string[]) => {
    const made: string[] = [];
    for (const id of ids) {
      const src = toolsById[id];
      if (!src?.layout) continue;
      const { sourcePath: _keep, ...props } = src.props ?? {};
      try {
        const copy = await api.createTool({
          kind: src.kind,
          title: `${src.title}${t(" copy", " 사본")}`,
          description: src.description,
          props: src.kind === "app" ? { ...props, sourcePath: src.props.sourcePath } : src.props,
          state: src.state,
          width: src.layout.w,
          at: { x: src.layout.x + 48 + src.layout.w / 2, y: src.layout.y + 48 + 80 },
        });
        made.push(copy.id);
      } catch (err) {
        onNotice((err as Error).message);
      }
    }
    if (made.length) setSelectedIds(made);
  };

  const addTool = async (kind: "note" | "checklist", at = cam.center()) => {
    try {
      const created = await api.createTool(
        kind === "note" ? { kind, title: t("Note", "메모"), state: { text: "" }, at } : { kind, title: t("Checklist", "체크리스트"), state: { items: [] }, at },
      );
      setSelectedIds([created.id]);
    } catch (err) {
      onNotice((err as Error).message);
    }
  };

  const addTemplate = async (id: string, at = cam.center()) => {
    try {
      const created = await api.useTemplate(id, at);
      setSelectedIds([created.id]);
    } catch (err) {
      onNotice((err as Error).message);
    }
  };

  // Figma-ish shortcuts (never while typing or inside the terminal window; only on the board on screen).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(document.activeElement) || document.activeElement?.closest(".term-window")) return;
      if (e.shiftKey && e.code === "Digit1") {
        e.preventDefault();
        cam.fitAll();
      } else if (e.shiftKey && e.code === "Digit0") {
        e.preventDefault();
        cam.zoomTo(1);
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "v") {
        setTool("select");
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "h") {
        setTool("hand");
      } else if (e.key === "Escape") {
        setSelectedIds([]);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.length) {
        removeTools(selectedIds);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && selectedIds.length) {
        e.preventDefault();
        setSendIds(selectedIds);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedIds(tools.map((tl) => tl.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cam, selectedIds, tools, removeTools, active, setTool]);

  const menuItems = (m: Menu): MenuItem[] => {
    const targets = m.ids.map((id) => toolsById[id]).filter(Boolean) as Tool[];
    if (!targets.length) {
      return [
        { label: t("+ Note here", "+ 메모 여기에"), onSelect: () => addTool("note", m.at) },
        { label: t("+ Checklist here", "+ 체크리스트 여기에"), onSelect: () => addTool("checklist", m.at) },
        { label: libraryOpen ? t("Close library", "라이브러리 닫기") : t("Open library", "라이브러리 열기"), onSelect: () => setLibraryOpen(!libraryOpen) },
        { separator: true },
        { label: t("Send to Claude…", "Claude에게 보내기…"), onSelect: () => setSendIds([]) },
        { label: t("Select all", "모두 선택"), hint: "⌘A", onSelect: () => setSelectedIds(tools.map((tl) => tl.id)) },
        { label: t("Zoom to fit all", "전체 보기"), hint: "⇧1", onSelect: cam.fitAll },
      ];
    }
    const one = targets.length === 1 ? targets[0] : null;
    const ids = targets.map((tl) => tl.id);
    const allRead = targets.every((tl) => tl.agentAccess === "read");
    return [
      {
        label: targets.length > 1 ? t(`Send ${targets.length} to Claude…`, `Claude에게 보내기 (${targets.length}개)…`) : t("Send to Claude…", "Claude에게 보내기…"),
        hint: "⌘↵",
        strong: true,
        onSelect: () => setSendIds(ids),
      },
      { separator: true },
      { label: t("Zoom to fit", "화면에 맞추기"), onSelect: () => fitTo(ids) },
      ...(one
        ? ([
            {
              label: t("Rename", "이름 바꾸기"),
              onSelect: () => {
                setSelectedIds([one.id]);
                setInspectorOpen(true); // renaming happens in the inspector
                window.setTimeout(() => (document.getElementById("insp-title") as HTMLInputElement | null)?.select(), 50);
              },
            },
            { label: t("Save to library…", "라이브러리에 저장…"), onSelect: () => setSaveTool(one) },
            { label: t("Copy ID", "ID 복사"), hint: one.id, onSelect: () => navigator.clipboard?.writeText(one.id).then(() => onNotice(t(`Copied ${one.id}`, `${one.id} 복사됨`))) },
          ] as MenuItem[])
        : []),
      { label: targets.length > 1 ? t(`Duplicate ${targets.length}`, `복제 (${targets.length}개)`) : t("Duplicate", "복제"), onSelect: () => duplicate(ids) },
      {
        label: allRead ? t("Let the agent edit", "agent가 수정할 수 있게") : t("Agent can only read", "agent는 읽기만"),
        onSelect: () => ids.forEach((id) => api.updateTool(id, { agentAccess: allRead ? "write" : "read" }).catch((err) => onNotice(err.message))),
      },
      { separator: true },
      { label: targets.length > 1 ? t(`Delete ${targets.length}`, `${targets.length}개 삭제`) : t("Delete", "삭제"), hint: "⌫", danger: true, onSelect: () => removeTools(ids) },
    ];
  };

  const selected = selectedIds.map((id) => toolsById[id]).filter(Boolean) as Tool[];
  return (
    <LiveProvider value={live}>
    <section className="pane board-pane" aria-label={t(`Board ${boardName}`, `보드 ${boardName}`)}>
      <header className="pane-head board-head">
        <h2 className="board-name">{boardName}</h2>
        <span className={`status ${connected ? "status-open" : "status-closed"}`}>{connected ? t("Live", "실시간") : t("Reconnecting", "재연결 중")}</span>
        <button className={libraryOpen ? "toggle on lib" : "toggle lib"} aria-pressed={libraryOpen} onClick={() => setLibraryOpen(!libraryOpen)} title={t("Saved components", "저장한 컴포넌트")}>
          {t("Library", "라이브러리")} <span className="count">{library.length}</span>
        </button>
        <div className="spacer" />
        <button className={`toggle${follow ? " on" : ""}`} aria-pressed={follow} onClick={() => setFollow(!follow)} title={t("Move the view to whatever the agent is working on", "agent가 작업하는 도구로 화면을 옮깁니다")}>
          <span className="dot" /> {t("Follow", "따라가기")}
        </button>
        <div className="zoom" role="group" aria-label={t("Zoom", "확대/축소")}>
          <button className="ghost icon" onClick={cam.zoomOut} aria-label={t("Zoom out", "축소")}>
            −
          </button>
          <button className="ghost zoom-pct" onClick={() => cam.zoomTo(1)} title="100% (Shift+0)">
            {Math.round(cam.zoom * 100)}%
          </button>
          <button className="ghost icon" onClick={cam.zoomIn} aria-label={t("Zoom in", "확대")}>
            +
          </button>
          <button className="ghost" onClick={cam.fitAll} title={t("Zoom to fit all (Shift+1)", "전체 보기 (Shift+1)")}>
            {t("Fit", "전체")}
          </button>
          <button
            className={minimap ? "ghost on" : "ghost"}
            aria-pressed={minimap}
            onClick={() => setMinimap(!minimap)}
            title={t("Minimap: the visible area of the whole board", "미니맵: 보드 전체에서 지금 보이는 영역")}
          >
            {t("Minimap", "미니맵")}
          </button>
        </div>
        <button
          className="danger"
          title={t("Send the agent a stop event. It stops the next time it checks the board.", "agent에게 중단 이벤트를 보냅니다. agent가 보드를 확인할 때 멈춥니다.")}
          onClick={() => api.stop().then(() => onNotice(t("Stop request sent.", "중단 요청을 보냈습니다.")), (e) => onNotice(e.message))}
        >
          {t("Stop", "중단")}
        </button>
        {terminalButton}
      </header>

      <div className="board-main">
        <div className={`canvas-wrap${minimap ? " minimap-on" : ""}${tool === "hand" ? " hand-mode" : ""}`}>
          <BoardCanvas
            showMinimap={minimap}
            tool={tool}
            boardId={boardId}
            tools={tools}
            selectedIds={selectedIds}
            onSelect={onSelect}
            onContextMenu={(pos, ids, at) => setMenu({ ...pos, ids, at })}
            onDropTemplate={(id, at) => addTemplate(id, at)}
            activeIds={activeIds}
            waitingIds={waitingIds}
            appErrors={appErrors}
            onAppErrors={onAppErrors}
            onInteract={onInteract}
            onNotice={onNotice}
          >
            {libraryOpen && (
              <Panel position="top-left">
                <LibraryPanel items={library} onAdd={(id) => addTemplate(id)} onClose={() => setLibraryOpen(false)} onNotice={onNotice} />
              </Panel>
            )}
            {asks.length > 0 && (
              <Panel position="top-right" className="asks-panel nowheel" aria-live="polite">
                {asks.map((a) => (
                  <AskCard key={a.id} ask={a} tool={a.toolId ? toolsById[a.toolId] : undefined} now={now} onNotice={onNotice} onLocate={a.toolId ? () => pick(a.toolId!) : undefined} />
                ))}
              </Panel>
            )}
            <Panel position="top-center" className="top-stack">
              <LoginBanner status={agentStatus} onOpenTerminal={onOpenTerminal} onRefresh={onRefreshStatus} onNotice={onNotice} />
              {ready && tools.length === 0 && (
                <div className="canvas-empty">
                  <p>
                    <b>{t("This board is empty.", "빈 보드입니다.")}</b>{" "}
                    {t(
                      "Open the terminal (top right) and ask Claude to build a tool, or type a request in the box below.",
                      "오른쪽 위 터미널 버튼을 눌러 Claude에게 도구를 만들어 달라고 하거나, 아래 입력창에 바로 적어 보세요.",
                    )}
                  </p>
                  <code>
                    {t(
                      "Make a v2.3 release checklist on the board. Get my approval before the prod deploy.",
                      "v2.3 릴리스 체크리스트 보드에 만들어줘. prod 배포 전엔 내 승인 받아.",
                    )}
                  </code>
                </div>
              )}
            </Panel>
            <Panel position="bottom-center" className="cmd-panel">
              <CommandBar
                tool={tool}
                onTool={setTool}
                selected={selected}
                onAdd={(k) => addTool(k)}
                onSend={async (prompt) => {
                  try {
                    const r = await api.sendToAgent(prompt, selectedIds);
                    onNotice(r.mode === "claude" ? t("Sent to Claude.", "Claude에게 보냈습니다.") : t("Started Claude in the terminal with your request.", "터미널에서 Claude를 시작해 요청을 보냈습니다."));
                    onSentToClaude(r.mode);
                  } catch (err) {
                    if (err instanceof ApiError && err.data?.reason) onOpenTerminal();
                    throw err;
                  }
                }}
                onNotice={onNotice}
              />
            </Panel>
          </BoardCanvas>
        </div>
        {inspectorOpen ? (
        <Inspector
          onCollapse={() => setInspectorOpen(false)}
          selected={selected}
          tools={tools}
          channels={channels}
          events={events}
          now={now}
          errors={selected.length === 1 ? (appErrors[selected[0].id] ?? 0) : 0}
          onPick={pick}
          onNotice={onNotice}
          onSendToClaude={setSendIds}
          onSave={setSaveTool}
          onFit={fitTo}
          onDelete={removeTools}
        />
        ) : (
          <button
            className="inspector-rail"
            onClick={() => setInspectorOpen(true)}
            title={t("Open properties panel", "속성 패널 열기")}
            aria-label={t("Open properties panel", "속성 패널 열기")}
          >
            <span className="rail-arrow">«</span>
            {selected.length > 0 && <span className="rail-count">{selected.length}</span>}
            <span className="rail-label">{selected.length ? t("Properties", "속성") : t("Layers · History", "레이어 · 이력")}</span>
          </button>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.ids.length > 1 ? t(`${menu.ids.length} selected`, `${menu.ids.length}개 선택`) : menu.ids.length === 1 ? toolsById[menu.ids[0]]?.title : undefined}
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}
      {sendIds && (
        <SendToClaudeDialog
          tools={sendIds.map((id) => toolsById[id]).filter(Boolean) as Tool[]}
          status={agentStatus}
          onClose={() => setSendIds(null)}
          onNotice={onNotice}
          onSent={onSentToClaude}
          onOpenTerminal={onOpenTerminal}
        />
      )}
      {saveTool && <SaveToLibraryDialog tool={saveTool} onClose={() => setSaveTool(null)} onNotice={onNotice} />}
    </section>
    </LiveProvider>
  );
}

/** Shown on the board while Claude cannot be used: not installed, not signed in, or the terminal's Claude asks to sign in. */
function LoginBanner({ status, onOpenTerminal, onRefresh, onNotice }: { status: AgentStatus | null; onOpenTerminal: () => void; onRefresh: () => void; onNotice: (m: string) => void }) {
  const api = useApi();
  const t = useT();
  const problem = loginProblem(status);
  const key = problem ? `${problem.kind}:${problem.detail ?? ""}` : "";
  const [dismissed, setDismissed] = useState("");
  const [busy, setBusy] = useState(false);
  if (!problem || dismissed === key) return null;

  const signIn = async () => {
    setBusy(true);
    try {
      const r = await api.startLogin();
      onOpenTerminal();
      onNotice(
        r.mode === "started"
          ? t("Sign-in started in the terminal. Open the link it shows in your browser to sign in.", "터미널에서 로그인을 시작했습니다. 나오는 링크를 브라우저에서 열어 로그인하세요.")
          : t("Sign in on Claude's screen in the terminal. If you don't see it, type /login.", "터미널의 Claude 화면에서 로그인하세요. 로그인 화면이 안 보이면 /login 을 입력하세요."),
      );
    } catch (err) {
      onNotice((err as Error).message);
      onOpenTerminal();
    } finally {
      setBusy(false);
    }
  };

  const text =
    problem.kind === "install"
      ? {
          title: t("Claude Code is not installed", "Claude Code가 설치되어 있지 않습니다"),
          body: t("Install Claude Code on this machine to use Claude on the board.", "이 PC에 Claude Code를 설치해야 보드에서 Claude를 쓸 수 있습니다."),
        }
      : problem.kind === "account"
        ? {
            title: t("Sign in to Claude", "Claude 로그인이 필요합니다"),
            body: t(
              "No Claude account is signed in on this machine. Once you sign in, Claude can build and edit tools on every board. All boards share the sign-in.",
              "이 PC에 Claude 계정이 로그인되어 있지 않습니다. 로그인하면 보드마다 Claude가 도구를 만들고 고칠 수 있습니다. 로그인은 모든 보드가 함께 씁니다.",
            ),
          }
        : {
            title: t("Sign in to Claude", "Claude 로그인이 필요합니다"),
            body: t(
              `Claude in this board's terminal asked you to sign in${problem.detail ? ` (${problem.detail})` : ""}. The saved sign-in may have expired.`,
              `이 보드의 터미널에서 Claude가 로그인을 요구했습니다${problem.detail ? ` (${problem.detail})` : ""}. 저장된 로그인이 만료되었을 수 있습니다.`,
            ),
          };

  return (
    <div className="login-banner" role="alert">
      <ClaudeMark size={22} />
      <div className="login-text">
        <b>{text.title}</b>
        <span>{text.body}</span>
      </div>
      <div className="login-actions">
        {problem.kind !== "install" && (
          <button className="primary" disabled={busy} onClick={signIn}>
            {t("Sign in from terminal", "터미널에서 로그인")}
          </button>
        )}
        <button className="ghost" onClick={onRefresh} title={t("Check the sign-in status again", "로그인 상태를 다시 확인합니다")}>
          {t("Check again", "다시 확인")}
        </button>
        <button className="ghost icon" onClick={() => setDismissed(key)} aria-label={t("Dismiss", "안내 닫기")} title={t("Dismiss", "닫기")}>
          ×
        </button>
      </div>
    </div>
  );
}

const panHelp = (t: T) =>
  t(
    "Zoom: wheel, pinch / Pan: drag with the hand tool (H) · hold Space and drag · middle-button drag · Shift+wheel",
    "확대·축소: 휠, 핀치 / 화면 이동: 손 도구(H)로 드래그 · Space 누른 채 드래그 · 가운데 버튼 드래그 · Shift+휠",
  );

function CommandBar({
  tool,
  onTool,
  selected,
  onAdd,
  onSend,
  onNotice,
}: {
  tool: "select" | "hand";
  onTool: (t: "select" | "hand") => void;
  selected: Tool[];
  onAdd: (k: "note" | "checklist") => void;
  onSend: (prompt: string) => Promise<void>;
  onNotice: (m: string) => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const clean = text.trim();
  const send = async () => {
    if (!clean || busy) return;
    setBusy(true);
    try {
      await onSend(clean);
      setText("");
    } catch (err) {
      onNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="commandbar">
      <div className="tools" role="group" aria-label={t("Tools", "도구")}>
        <button
          className={tool === "select" ? "tool on" : "tool"}
          aria-pressed={tool === "select"}
          onClick={() => onTool("select")}
          title={`${t("Select (V): drag on empty space to select several", "선택 (V): 빈 곳을 드래그하면 여러 개를 선택합니다")}\n${panHelp(t)}`}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path d="M3 2l9 5.2-4 .9-1.7 3.9z" fill="currentColor" />
          </svg>
        </button>
        <button
          className={tool === "hand" ? "tool on" : "tool"}
          aria-pressed={tool === "hand"}
          onClick={() => onTool("hand")}
          title={`${t("Hand (H): drag anywhere to pan", "손 (H): 어디서든 드래그해서 화면을 옮깁니다")}\n${panHelp(t)}`}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path
              d="M5.5 8V3.6a1 1 0 0 1 2 0V7m0-3.9V2.6a1 1 0 0 1 2 0V7m0-3.4a1 1 0 0 1 2 0V8m0-2.6a1 1 0 0 1 2 0v4.3A4.3 4.3 0 0 1 9.2 14H8.4a4 4 0 0 1-3.2-1.6L2.9 9.3a1 1 0 0 1 1.5-1.3L5.5 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <span className="sep" />
      <button className="ghost" onClick={() => onAdd("note")} title={t("Add a note in the middle of the view", "화면 가운데에 메모 추가")}>
        {t("+ Note", "+ 메모")}
      </button>
      <button className="ghost" onClick={() => onAdd("checklist")} title={t("Add a checklist in the middle of the view", "화면 가운데에 체크리스트 추가")}>
        {t("+ Checklist", "+ 체크리스트")}
      </button>
      <span className="sep" />
      {selected.length > 0 && (
        <span className="ctx-chip" title={selected.map((tl) => tl.title).join(", ")}>
          {t(`${selected.length} selected attached`, `선택 ${selected.length}개 포함`)}
        </span>
      )}
      <input
        value={text}
        placeholder={selected.length ? t("What should Claude do with the selection?", "선택한 컴포넌트로 Claude에게 시킬 일") : t("Ask Claude", "Claude에게 말하기")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button className="primary" disabled={!clean || busy} onClick={send}>
        {t("Send ↵", "보내기 ↵")}
      </button>
    </div>
  );
}
