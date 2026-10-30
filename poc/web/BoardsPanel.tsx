// Left panel: the work boards. Each board owns one terminal (one Claude session).
import { useEffect, useRef, useState } from "react";
import type { BoardSummary } from "./api.ts";
import { ContextMenu } from "./ContextMenu.tsx";
import { agentStateLabel, LangSwitch, useT } from "./i18n.tsx";
import { ClaudeMark } from "./TerminalButton.tsx";

interface BoardsPanelProps {
  boards: BoardSummary[];
  activeId: string;
  open: boolean;
  activity: Record<string, boolean>;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onCreate: () => Promise<string | undefined>;
  onRename: (id: string, name: string) => void;
  onDelete: (b: BoardSummary) => void;
  onOpenWindow: (id: string) => void;
  onNotice: (m: string) => void;
}

const recent = (iso?: string, ms = 8000) => !!iso && Date.now() - Date.parse(iso) < ms;

export function BoardsPanel(props: BoardsPanelProps) {
  const { boards, activeId, open } = props;
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; board: BoardSummary } | null>(null);

  if (!open) {
    return (
      <nav className="boards rail" aria-label={t("Work boards", "작업 보드")}>
        <button className="ghost icon rail-toggle" onClick={props.onToggle} title={t("Show boards", "보드 목록 열기")} aria-label={t("Show boards", "보드 목록 열기")}>
          »
        </button>
        {boards.map((b) => (
          <button key={b.id} className={`rail-board${b.id === activeId ? " active" : ""}`} onClick={() => props.onSelect(b.id)} title={b.name}>
            {[...b.name][0] ?? "?"}
            {(b.pendingAsks > 0 || b.agentState === "permission" || props.activity[b.id]) && (
              <span className={`rail-dot${b.pendingAsks > 0 || b.agentState === "permission" ? " wait" : ""}`} />
            )}
          </button>
        ))}
        <button className="ghost icon" onClick={async () => setEditing((await props.onCreate()) ?? null)} title={t("New board", "새 보드")} aria-label={t("New board", "새 보드")}>
          +
        </button>
        <span className="spacer" />
        <LangSwitch compact />
      </nav>
    );
  }

  return (
    <nav className="boards" aria-label={t("Work boards", "작업 보드")}>
      <header>
        <h2>{t("Boards", "작업 보드")}</h2>
        <span className="spacer" />
        <button className="ghost" onClick={async () => setEditing((await props.onCreate()) ?? null)} title={t("New board (a new Claude session)", "새 보드 (새 Claude 세션)")}>
          {t("+ New board", "+ 새 보드")}
        </button>
        <button className="ghost icon" onClick={props.onToggle} title={t("Hide boards", "보드 목록 접기")} aria-label={t("Hide boards", "보드 목록 접기")}>
          «
        </button>
      </header>
      <ul>
        {boards.map((b) => (
          <li key={b.id}>
            {editing === b.id ? (
              <RenameInput
                value={b.name}
                onDone={(name) => {
                  setEditing(null);
                  if (name && name !== b.name) props.onRename(b.id, name);
                }}
              />
            ) : (
              <button
                className={`board-item${b.id === activeId ? " active" : ""}`}
                onClick={() => props.onSelect(b.id)}
                onDoubleClick={() => setEditing(b.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, board: b });
                }}
                title={t(
                  `${b.name}\nWork folder: ${b.workspace}\nDouble-click: rename · Right-click: more`,
                  `${b.name}\n작업 폴더: ${b.workspace}\n더블클릭: 이름 바꾸기 · 우클릭: 더 보기`,
                )}
              >
                <span className="board-item-name">{b.name}</span>
                <span className="board-item-meta">
                  {b.claudeRunning ? (
                    <span className={`session on state-${b.agentState}`}>
                      <ClaudeMark size={12} /> {agentStateLabel(b.agentState, t)}
                    </span>
                  ) : (
                    <span className="session">{b.shellRunning ? t("shell", "셸") : t("idle", "대기")}</span>
                  )}
                  <span>· {t(`${b.tools} tools`, `도구 ${b.tools}`)}</span>
                  {recent(b.lastAgentAt) && <span className="pill agent">{t("working", "작업 중")}</span>}
                  {b.pendingAsks > 0 && <span className="pill wait">{t(`${b.pendingAsks} waiting`, `응답 ${b.pendingAsks}`)}</span>}
                  {b.loginRequired && <span className="pill wait">{t("sign-in needed", "로그인 필요")}</span>}
                  {props.activity[b.id] && b.id !== activeId && <span className="activity-dot inline" title={t("New terminal output", "터미널에 새 출력")} />}
                </span>
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="boards-foot muted">
        <span className="boards-foot-text">
          <span>{t("Each board has its own terminal and Claude session.", "보드마다 터미널과 Claude 세션이 따로 있습니다.")}</span>
          <a href="/third-party-licenses.md" target="_blank" rel="noopener noreferrer">
            {t("Open source licenses", "오픈소스 라이선스")}
          </a>
        </span>
        <LangSwitch />
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.board.name}
          onClose={() => setMenu(null)}
          items={[
            { label: t("Open", "열기"), onSelect: () => props.onSelect(menu.board.id) },
            { label: t("Open in new window", "새 창에서 열기"), hint: t("side by side", "나란히 보기"), onSelect: () => props.onOpenWindow(menu.board.id) },
            { label: t("Rename", "이름 바꾸기"), onSelect: () => setEditing(menu.board.id) },
            {
              label: t("Copy work folder path", "작업 폴더 경로 복사"),
              hint: "cwd",
              onSelect: () => navigator.clipboard?.writeText(menu.board.workspace).then(() => props.onNotice(t("Path copied.", "경로를 복사했습니다."))),
            },
            { separator: true },
            { label: t("Delete board", "보드 삭제"), danger: true, disabled: boards.length === 1, onSelect: () => props.onDelete(menu.board) },
          ]}
        />
      )}
    </nav>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  const t = useT();
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <input
      ref={ref}
      className="board-rename"
      aria-label={t("Board name", "보드 이름")}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) onDone(v.trim());
        if (e.key === "Escape") onDone(value);
      }}
    />
  );
}
