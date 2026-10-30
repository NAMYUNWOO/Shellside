// Top-right terminal button: a tiny terminal window. The Shellside mark appears only when Claude actually runs
// in this board's terminal; a stored login alone does not count.
import { loginProblem, type AgentStatus } from "./api.ts";
import { useT, type T } from "./i18n.tsx";
import { ShellsideMark } from "./ShellsideMark.tsx";

function describe(status: AgentStatus | null, t: T): string {
  const term = t("Terminal", "터미널");
  if (!status) return term;
  if (!status.claude.installed) return `${term} · ${t("Claude Code is not installed", "Claude Code가 설치되어 있지 않습니다")}`;
  if (loginProblem(status))
    return `${term} · ${t('Claude needs you to sign in. Use "Sign in from terminal" in the notice on the board', 'Claude 로그인이 필요합니다. 보드 위 안내의 "터미널에서 로그인"을 누르세요')}`;
  const account = status.claude.loggedIn ? t("account signed in", "계정 로그인됨") : t("account not signed in: run it, then /login", "계정 로그인 필요: 실행 후 /login");
  switch (status.terminal.agentState) {
    case "none":
      return `${term} · ${t(`Claude is off on this board. Open the terminal and press "Start Claude Code" (${account})`, `이 보드에서 Claude가 꺼져 있습니다. 터미널을 열고 "Claude Code 시작"을 누르세요 (${account})`)}`;
    case "starting":
      return `${term} · ${t("Claude is starting: the terminal may ask you to trust the folder or sign in", "Claude 시작 중: 터미널에서 폴더 신뢰나 로그인 확인이 필요할 수 있습니다")}`;
    case "idle":
      return `${term} · ${t("Claude is idle", "Claude 대기 중")}`;
    case "busy":
      return `${term} · ${t("Claude is working", "Claude 작업 중")}`;
    case "permission":
      return `${term} · ${t("Claude is waiting for permission. Answer it in the terminal", "Claude가 권한 확인을 기다립니다. 터미널에서 답해 주세요")}`;
  }
}

export function TerminalButton({ open, status, activity, onClick }: { open: boolean; status: AgentStatus | null; activity: boolean; onClick: () => void }) {
  const t = useT();
  const state = status?.terminal.agentState ?? "none";
  const title = `${describe(status, t)} · Ctrl+\``;
  const showMark = state !== "none";
  const needsLogin = !!loginProblem(status);
  return (
    <button className={`term-btn${open ? " open" : ""} state-${state}`} onClick={onClick} aria-pressed={open} aria-label={title} title={title}>
      <span className="term-glyph" aria-hidden>
        <span className="term-glyph-bar">
          <i />
          <i />
          <i />
        </span>
        <span className="term-glyph-screen">{showMark ? <ShellsideMark size={14} /> : <span className="term-prompt">&gt;_</span>}</span>
      </span>
      {needsLogin || state === "permission" ? (
        <span className="term-alert" aria-hidden>
          !
        </span>
      ) : state === "starting" ? (
        <span className="term-alert waiting" aria-hidden>
          …
        </span>
      ) : (
        activity && !open && <span className="activity-dot" aria-hidden />
      )}
    </button>
  );
}
