// Several work boards. Each board has its own data, its own terminal shell (one Claude session) and its own
// workspace folder whose .mcp.json points at that board's MCP endpoint.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WebSocket } from "ws";
import { Board, BoardError } from "./board.ts";
import { ShellSession } from "./pty.ts";
import { prepareWorkspace, writeSessionKit } from "./workspace.ts";
import { claudeAuth, cleanEnv, isClaude, loginSignal, stateAfterHook, type AgentState } from "./agent.ts";

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
  /** Command Claude Code hooks run to report state, e.g. `"node" ".../wb.mjs" hook`. */
  hookCommand: string;
  compile: (source: string) => string;
}

/** One board, its shell and the browser tabs watching it. */
export class BoardRuntime {
  readonly board: Board;
  readonly shell: ShellSession;
  readonly clients = new Set<WebSocket>();
  private rpcPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
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
    prepareWorkspace(meta.workspace, mcpUrl, opts.hookCommand);
    const kit = writeSessionKit(join(opts.dataDir, "sessions", meta.id), mcpUrl, opts.hookCommand);
    this.board = new Board(join(opts.dataDir, "boards", `${meta.id}.json`), opts.compile);
    const shellPath = process.env.SHELL ?? "/bin/bash";
    const isBash = /(^|\/)bash$/.test(shellPath);
    this.shell = new ShellSession({
      cwd: meta.workspace,
      shell: shellPath,
      // bash: our rcfile loads the normal login setup, then wraps `claude` so the board follows you to any folder.
      args: isBash ? ["--rcfile", kit.bashrc, "-i"] : ["-l"],
      env: {
        ...cleanEnv(),
        WB_WORKSPACE: meta.workspace,
        WB_BIN: opts.binDir,
        WB_MCP_CONFIG: kit.mcpConfig,
        WB_SETTINGS: kit.settings,
        WB_RULES: kit.rules,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        WB_URL: opts.serverUrl,
        WB_BOARD: meta.id,
        PATH: `${opts.binDir}:${process.env.PATH ?? ""}`,
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
      if (this.hook.state !== "starting" && !isClaude(this.shell.foreground())) this.hook = { state: "starting", at: new Date().toISOString() };
    }, 1000);
    this.watch.unref();
  }

  onHook(event: string, info: { notificationType?: string; message?: string }) {
    const next = stateAfterHook(event, info);
    if (next) this.hook = { state: next, at: new Date().toISOString() };
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

  /** Ask a browser tab showing this board to run something inside an app iframe. */
  browserRpc(method: string, toolId: string, params: unknown, timeoutMs = 15000): Promise<unknown> {
    const clients = [...this.clients].filter((ws) => ws.readyState === ws.OPEN);
    if (!clients.length) {
      return Promise.reject(
        new BoardError(`board "${this.meta.name}" is not open in a browser, so its apps are not running. Ask the person to open this board in WorkBoard.`, 409),
      );
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcPending.delete(id);
        reject(new BoardError(`the app did not answer within ${Math.round(timeoutMs / 1000)}s`, 504));
      }, timeoutMs);
      this.rpcPending.set(id, { resolve, reject, timer });
      for (const ws of clients) ws.send(JSON.stringify({ type: "rpc", id, method, toolId, params }));
    });
  }

  rpcResult(msg: { id: string; result?: unknown; error?: string }) {
    const p = this.rpcPending.get(msg.id);
    if (!p) return; // another tab answered first
    this.rpcPending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new BoardError(String(msg.error), 422));
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
