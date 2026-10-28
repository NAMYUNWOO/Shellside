// One shared shell for the PoC. It outlives browser reconnects and replays recent output.
import * as pty from "node-pty";

const REPLAY_LIMIT = 512 * 1024; // bytes of recent output kept for reconnecting tabs

export interface PtyOptions {
  cwd: string;
  env: Record<string, string>;
  shell?: string;
  /** Defaults to a login shell (-l). */
  args?: string[];
}

type Listener = (data: Buffer) => void;

export class ShellSession {
  private proc: pty.IPty | null = null;
  private replay: Buffer[] = [];
  private replayBytes = 0;
  private listeners = new Set<Listener>();
  private exitListeners = new Set<(code: number) => void>();
  cols = 100;
  rows = 30;

  constructor(private opts: PtyOptions) {}

  get running() {
    return this.proc !== null;
  }

  ensureStarted(cols: number, rows: number) {
    if (this.proc) return;
    this.cols = cols;
    this.rows = rows;
    const shell = this.opts.shell ?? process.env.SHELL ?? "/bin/bash";
    this.replay = [];
    this.replayBytes = 0;
    const proc = pty.spawn(shell, this.opts.args ?? ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.opts.cwd,
      env: this.opts.env,
      encoding: null, // raw bytes: the browser terminal decodes UTF-8 itself
    });
    proc.onData((chunk: string | Buffer) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      this.remember(data);
      for (const fn of this.listeners) fn(data);
    });
    proc.onExit(({ exitCode }) => {
      this.proc = null;
      for (const fn of this.exitListeners) fn(exitCode);
    });
    this.proc = proc;
  }

  private remember(data: Buffer) {
    this.replay.push(data);
    this.replayBytes += data.length;
    while (this.replayBytes > REPLAY_LIMIT && this.replay.length > 1) {
      this.replayBytes -= this.replay.shift()!.length;
    }
  }

  replayBuffer(): Buffer {
    return Buffer.concat(this.replay);
  }

  onData(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onExit(fn: (code: number) => void) {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  /** Name of the program in the foreground of the terminal, e.g. "/bin/bash" or "claude". */
  foreground(): string {
    try {
      return this.proc?.process ?? "";
    } catch {
      return "";
    }
  }

  write(data: string) {
    this.proc?.write(data);
  }

  resize(cols: number, rows: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 1024 || rows > 512) return;
    this.cols = cols;
    this.rows = rows;
    this.proc?.resize(cols, rows);
  }

  kill() {
    this.proc?.kill();
    this.proc = null;
  }
}
