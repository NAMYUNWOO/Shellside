// Several work boards. Each board has its own data, its own terminal shell (one Claude session) and its own
// workspace folder whose .mcp.json points at that board's MCP endpoint.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { WebSocket } from "ws";
import { Board, BoardError } from "./board.ts";
import { ShellSession } from "./pty.ts";
import { powershellArgs, prepareWorkspace, writeSessionKit } from "./workspace.ts";
import { claudeAuth, cleanEnv, isClaude, isShell, loginSignal, shellQuote, stateAfterHook, type AgentState } from "./agent.ts";
import { BoardBrowsers, type BrowserService } from "./browser.ts";

export interface BoardMeta {
  id: string;
  name: string;
  createdAt: string;
  workspace: string;
}

export interface BoardSummary extends BoardMeta {
  tools: number;
  pendingAsks: number;
  shellRunning: boolean;
  claudeRunning: boolean;
  agentState: AgentState;
  loginRequired: boolean;
  lastEventAt?: string;
  lastAgentAt?: string;
}

interface RegistryOptions {
  dataDir: string;
  workspacesDir: string;
  serverUrl: string;
  binDir: string;
  /** The program that runs bin/wb.mjs for the wb CLI: Node, or the desktop app's own runtime. */
  nodePath: string;
  compile: (source: string) => string;
  /** The server's one headless Chrome, shared by every board's browser tools. */
  browsers: BrowserService;
}

const WINDOWS = process.platform === "win32";

/**
 * The board terminal's shell: WB_SHELL, else PowerShell on Windows and the person's login shell elsewhere. bash gets our
 * rcfile, which loads the normal login setup and then wraps `claude` so the board follows you to any folder.
 * PowerShell (5.1, or 7 as pwsh) loads the person's profile and then the same wrapper. Other shells start as login shells.
 */
function boardShell(bashrc: string): { shell: string; args: string[]; powershell: boolean } {
  let login = "";
  try {
    if (!WINDOWS) login = userInfo().shell ?? "";
  } catch {}
  // Started from the Dock or Finder, an app may get no SHELL: then the account's login shell.
  const shell = process.env.WB_SHELL || (WINDOWS ? "powershell.exe" : process.env.SHELL || login || "/bin/bash");
  if (/(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(shell)) return { shell, args: powershellArgs(), powershell: true };
  return { shell, args: /(^|\/)bash$/.test(shell) ? ["--rcfile", bashrc, "-i"] : ["-l"], powershell: false };
}

/**
 * This process's env for a board terminal (see cleanEnv), with bin/ (the wb CLI) first on PATH. Windows calls the
 * variable "Path"; a second "PATH" key next to it would leave it unclear which one a program gets. Local addresses
 * never go through a proxy: Claude Code reaches the board's MCP endpoint and hooks there.
 */
function terminalEnv(binDir: string) {
  const env = cleanEnv();
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = [binDir, env[pathKey]].filter(Boolean).join(delimiter);
  if (Object.keys(env).some((k) => /^(https?|all)_proxy$/i.test(k))) {
    // Windows names are case-insensitive: one key there. Elsewhere programs read either spelling.
    const keys = WINDOWS ? [Object.keys(env).find((k) => /^no_proxy$/i.test(k)) ?? "NO_PROXY"] : ["NO_PROXY", "no_proxy"];
    for (const key of keys) {
      const have = (env[key] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      env[key] = [...new Set([...have, "127.0.0.1", "localhost"])].join(",");
    }
  }
  return env;
}

/** One board, its shell and the browser tabs watching it. */
export class BoardRuntime {
  readonly board: Board;
  readonly shell: ShellSession;
  readonly browsers: BoardBrowsers;
  readonly clients = new Set<WebSocket>();
  /** waiting = tabs that have not answered yet; error = the first tab's error, used once every tab failed. */
  private rpcPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; waiting: number; error?: string }>();
  private hook: { state: AgentState; at: string } = { state: "starting", at: new Date().toISOString() };
  /** Set when Claude in this terminal asks to sign in; cleared on "Login successful" or once Claude works. */
  login: { needed: boolean; hint?: string; at?: string } = { needed: false };
  private tail = "";
  private watch: NodeJS.Timeout;

  constructor(
    public meta: BoardMeta,
    opts: RegistryOptions,
  ) {
    const mcpUrl = `${opts.serverUrl}/mcp/${meta.id}`;
    const hookUrl = `${opts.serverUrl}/api/b/${meta.id}/agent/hook`;
    const sessionDir = join(opts.dataDir, "sessions", meta.id);
    prepareWorkspace(meta.workspace, mcpUrl, hookUrl);
    const kit = writeSessionKit(sessionDir, mcpUrl, hookUrl);
    this.board = new Board(join(opts.dataDir, "boards", `${meta.id}.json`), opts.compile);
    this.browsers = new BoardBrowsers(opts.browsers, meta.id, this.board, meta.workspace);
    const { shell, args, powershell } = boardShell(kit.bashrc);
    this.powershell = powershell;
    const fgFile = powershell ? join(sessionDir, "foreground") : undefined;
    this.shell = new ShellSession({
      cwd: meta.workspace,
      shell,
      args,
      foregroundFile: fgFile,
      env: {
        ...terminalEnv(opts.binDir),
        WB_NODE: opts.nodePath,
        ...(fgFile ? { WB_FG: fgFile } : {}),
        WB_WORKSPACE: meta.workspace,
        WB_BIN: opts.binDir,
        WB_MCP_CONFIG: kit.mcpConfig,
        WB_SETTINGS: kit.settings,
        WB_RULES: kit.rules,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        WB_URL: opts.serverUrl,
        WB_BOARD: meta.id,
        // Long waits on board_ask are expected; keep the agent's MCP client from giving up early.
        MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? "900000",
      },
    });
    // Watch the terminal for sign-in prompts (stored credentials can still be rejected, e.g. an expired token).
    this.shell.onData((buf) => {
      this.tail = (this.tail + buf.toString("utf8"))
        .replace(/\x1b\[[0-9;?<>]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
        .slice(-4000);
      const sig = loginSignal(this.tail);
      if (!sig || sig.needed === this.login.needed) return;
      this.login = { ...sig, at: new Date().toISOString() };
      this.tail = "";
      if (!sig.needed) void claudeAuth(true); // signed in: refresh the cached account status
    });
    // When Claude leaves the foreground, forget its last state: a new session is not ready until SessionStart.
    this.watch = setInterval(() => {
      const fg = this.shell.foreground();
      if (this.hook.state !== "starting" && !isClaude(fg)) this.hook = { state: "starting", at: new Date().toISOString() };
      if (this.pendingPrompt && (isShell(fg) || Date.now() > this.pendingPrompt.until)) this.pendingPrompt = null; // that Claude is gone
    }, 1000);
    this.watch.unref();
  }

  /** The terminal runs PowerShell (always on Windows). */
  private readonly powershell: boolean;
  /** PowerShell: a request for the Claude we just started bare, typed in once it is ready (see startClaude). */
  private pendingPrompt: { text: string; until: number } | null = null;

  /** Start Claude in the terminal (a shell is in the foreground) with a request as its first prompt. */
  startClaude(text: string) {
    this.markStarting();
    if (!this.powershell) return this.shell.write(`claude ${shellQuote(text)}\r`);
    // Windows PowerShell 5.1 mangles double quotes in arguments to programs: start Claude bare, and paste the request
    // when SessionStart says it is up (a trust prompt first just makes it wait).
    this.pendingPrompt = { text, until: Date.now() + 5 * 60_000 };
    this.shell.write("claude\r");
  }

  /** Bracketed paste keeps line breaks inside Claude's input; Enter (a moment later) submits it. */
  typeIntoClaude(text: string) {
    this.shell.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => this.shell.write("\r"), 150);
  }

  onHook(event: string, info: { notificationType?: string; message?: string }) {
    const next = stateAfterHook(event, info);
    if (next) this.hook = { state: next, at: new Date().toISOString() };
    if (event === "SessionStart" && this.pendingPrompt) {
      const { text } = this.pendingPrompt;
      this.pendingPrompt = null;
      // SessionStart comes a moment before Claude's input box takes keys.
      setTimeout(() => {
        if (isClaude(this.shell.foreground())) this.typeIntoClaude(text);
      }, 1500);
    }
    // Claude taking prompts or finishing turns means it is signed in.
    if (event === "UserPromptSubmit" || event === "Stop" || event === "PostToolUse") this.login = { needed: false };
  }

  /** none = Claude is not running in this board's terminal; starting = running but not ready (e.g. trust prompt). */
  agentState(): AgentState {
    if (!isClaude(this.shell.foreground())) return "none";
    return this.hook.state;
  }

  markStarting() {
    this.hook = { state: "starting", at: new Date().toISOString() };
  }

  /** If no tab shows the board (the person is reloading the page, or the socket is reconnecting), wait this long for one. */
  static readonly TAB_WAIT_MS = 10_000;

  private openClients() {
    return [...this.clients].filter((ws) => ws.readyState === ws.OPEN);
  }

  /** Ask a browser tab showing this board to run something inside an app iframe. */
  async browserRpc(method: string, toolId: string, params: unknown, timeoutMs = 20000): Promise<unknown> {
    let clients = this.openClients();
    for (const until = Date.now() + BoardRuntime.TAB_WAIT_MS; !clients.length && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 250));
      clients = this.openClients();
    }
    if (!clients.length) {
      throw new BoardError(
        `no browser tab has board "${this.meta.name}" open (waited ${BoardRuntime.TAB_WAIT_MS / 1000}s), so its apps are not running. ` +
          `Ask the person to open this board, then try again.`,
        409,
      );
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A tab that closed mid-call never answers; if another tab already failed, its reason is the better error.
        const error = this.rpcPending.get(id)?.error;
        this.rpcPending.delete(id);
        reject(error ? new BoardError(error, 422) : new BoardError(`the app did not answer within ${Math.round(timeoutMs / 1000)}s`, 504));
      }, timeoutMs);
      this.rpcPending.set(id, { resolve, reject, timer, waiting: clients.length });
      for (const ws of clients) ws.send(JSON.stringify({ type: "rpc", id, method, toolId, params }));
    });
  }

  rpcResult(msg: { id: string; result?: unknown; error?: string }) {
    const p = this.rpcPending.get(msg.id);
    if (!p) return; // already settled: another tab answered first
    if (msg.error) {
      p.error ??= String(msg.error);
      if (--p.waiting > 0) return; // another tab may still have the app running
    }
    this.rpcPending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new BoardError(p.error!, 422));
    else p.resolve(msg.result);
  }

  summary(): BoardSummary {
    const snap = this.board.snapshot();
    const last = snap.events.at(-1);
    const lastAgent = [...snap.events].reverse().find((e) => e.actor === "agent");
    return {
      ...this.meta,
      tools: snap.tools.length,
      pendingAsks: snap.asks.length,
      shellRunning: this.shell.running,
      claudeRunning: isClaude(this.shell.foreground()),
      agentState: this.agentState(),
      loginRequired: this.login.needed,
      lastEventAt: last?.at,
      lastAgentAt: lastAgent?.at,
    };
  }

  dispose() {
    clearInterval(this.watch);
    this.browsers.dispose();
    this.shell.kill();
    for (const ws of this.clients) ws.close();
  }
}

export class BoardRegistry {
  private runtimes = new Map<string, BoardRuntime>();
  private indexFile: string;

  constructor(private opts: RegistryOptions) {
    this.indexFile = join(opts.dataDir, "boards.json");
    mkdirSync(join(opts.dataDir, "boards"), { recursive: true });
    mkdirSync(opts.workspacesDir, { recursive: true });
    let metas: BoardMeta[] = [];
    if (existsSync(this.indexFile)) {
      try {
        metas = JSON.parse(readFileSync(this.indexFile, "utf8")).boards ?? [];
      } catch (err) {
        console.error(`[boards] could not read ${this.indexFile}:`, err);
      }
    }
    for (const m of metas) this.runtimes.set(m.id, new BoardRuntime(m, opts));
    if (!this.runtimes.size) this.migrateOrCreateDefault();
  }

  /** First run on the multi-board layout: adopt the single-board data and workspace if they exist. */
  private migrateOrCreateDefault() {
    const id = "main";
    const oldData = join(this.opts.dataDir, "board.json");
    if (existsSync(oldData)) renameSync(oldData, join(this.opts.dataDir, "boards", `${id}.json`));
    const workspace = join(this.opts.workspacesDir, id);
    const oldWorkspace = resolve(this.opts.workspacesDir, "..", "workspace");
    if (!existsSync(workspace) && existsSync(oldWorkspace)) renameSync(oldWorkspace, workspace);
    this.add({ id, name: "Main board", createdAt: new Date().toISOString(), workspace });
  }

  private add(meta: BoardMeta) {
    const rt = new BoardRuntime(meta, this.opts);
    this.runtimes.set(meta.id, rt);
    this.save();
    return rt;
  }

  private save() {
    writeFileSync(`${this.indexFile}.tmp`, JSON.stringify({ boards: [...this.runtimes.values()].map((r) => r.meta) }, null, 2));
    renameSync(`${this.indexFile}.tmp`, this.indexFile);
  }

  list(): BoardSummary[] {
    return [...this.runtimes.values()].map((r) => r.summary()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): BoardRuntime {
    const rt = this.runtimes.get(id);
    if (!rt) throw new BoardError(`board "${id}" not found`, 404);
    return rt;
  }

  create(name: string): BoardRuntime {
    const id = `b_${randomUUID().slice(0, 8)}`;
    return this.add({ id, name: name.trim().slice(0, 80) || "New board", createdAt: new Date().toISOString(), workspace: join(this.opts.workspacesDir, id) });
  }

  rename(id: string, name: string) {
    const rt = this.get(id);
    rt.meta = { ...rt.meta, name: name.trim().slice(0, 80) || rt.meta.name };
    this.save();
    return rt.summary();
  }

  /** Remove a board and stop its shell. Its workspace folder (the agent's files) is kept on disk. */
  remove(id: string, lang: "en" | "ko" = "en") {
    const rt = this.get(id);
    if (this.runtimes.size === 1) throw new BoardError(lang === "ko" ? "마지막 보드는 삭제할 수 없습니다" : "You can't delete the last board", 409);
    rt.dispose();
    this.runtimes.delete(id);
    rmSync(join(this.opts.dataDir, "boards", `${id}.json`), { force: true });
    this.save();
  }

  disposeAll() {
    for (const rt of this.runtimes.values()) rt.dispose();
  }
}
