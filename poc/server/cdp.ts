// One headless Chrome for the whole server, driven over the Chrome DevTools Protocol (CDP).
// The connection is a pipe (--remote-debugging-pipe), not a TCP port: no other process or website can reach it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import { BoardError } from "./board.ts";

type EventFn = (method: string, params: any) => void;

/**
 * Pixel density the board browser renders at. Screencast frames come at the screen's density, not the page's
 * emulated one, so the whole headless browser runs at 2× and every frame is equally sharp on high-density displays.
 */
export const BROWSER_SCALE = Math.max(1, Math.min(3, Number(process.env.WB_BROWSER_SCALE) || 2));

/** Where to find a Chromium-based browser. WB_CHROME wins; then the usual install places; then Playwright's copy. */
export function findChrome(): string | null {
  const env = process.env.WB_CHROME;
  if (env) return existsSync(env) ? env : null;
  const home = homedir();
  const candidates: string[] = [];
  if (platform() === "darwin") {
    for (const base of ["/Applications", join(home, "Applications")]) {
      candidates.push(
        `${base}/Google Chrome.app/Contents/MacOS/Google Chrome`,
        `${base}/Chromium.app/Contents/MacOS/Chromium`,
        `${base}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
        `${base}/Brave Browser.app/Contents/MacOS/Brave Browser`,
      );
    }
  } else if (platform() === "win32") {
    for (const base of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(`${base}\\Google\\Chrome\\Application\\chrome.exe`, `${base}\\Microsoft\\Edge\\Application\\msedge.exe`);
    }
  } else {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) candidates.push(join(dir, name));
    }
  }
  const pw = platform() === "darwin" ? join(home, "Library", "Caches", "ms-playwright") : join(home, ".cache", "ms-playwright");
  if (existsSync(pw)) {
    for (const dir of readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      candidates.push(
        join(pw, dir, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
        join(pw, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        join(pw, dir, "chrome-linux", "chrome"),
      );
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

export class Chrome {
  private proc: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private sessions = new Map<string, EventFn>();
  private rootListeners = new Set<EventFn>();
  private starting: Promise<void> | null = null;
  /** The start of a message that has not fully arrived yet (raw bytes, cut where a read ended). */
  private parts: Buffer[] = [];
  /** Called when Chrome goes away (crash or kill), so tabs can forget their sessions. */
  onExit: (() => void) | null = null;
  userAgent = "";

  constructor(private profileDir: string) {}

  get running() {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  /** Start Chrome if it is not running. Safe to call often. */
  ensure(): Promise<void> {
    if (this.running && !this.starting) return Promise.resolve();
    this.starting ??= this.launch().finally(() => (this.starting = null));
    return this.starting;
  }

  private async launch() {
    const exe = findChrome();
    if (!exe) {
      throw new BoardError(
        "No Chrome, Chromium, Edge or Brave was found for the board browser. Install Google Chrome, or set WB_CHROME to a Chromium-based browser's executable and restart the server.",
        503,
      );
    }
    mkdirSync(this.profileDir, { recursive: true });
    const lang = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
    const args = [
      "--headless",
      "--remote-debugging-pipe",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Keep every board browser painting and running timers even though no window is visible.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=Translate,MediaRouter,DialMediaRouteProvider",
      // macOS: no Keychain prompt for this separate profile (Playwright and Puppeteer do the same).
      ...(platform() === "darwin" ? ["--use-mock-keychain"] : []),
      "--mute-audio",
      `--lang=${lang}`,
      "--window-size=1280,800",
      `--force-device-scale-factor=${BROWSER_SCALE}`,
      "about:blank",
    ];
    // A Chrome that is still shutting down (the server just restarted) holds the profile for a moment, and a new one
    // started on it quits at once: try again shortly.
    for (let attempt = 1; ; attempt++) {
      const r = await this.start(exe, args);
      if (r === true) return;
      if (!r.quit || attempt === 3) throw new BoardError(`could not start the board browser (${exe}): ${r.message}`, 503);
      await sleep(1000 * attempt);
    }
  }

  /** One try at starting Chrome: true, or why not (quit: it exited by itself rather than hanging). */
  private async start(exe: string, args: string[]): Promise<true | { quit: boolean; message: string }> {
    const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.parts = [];
    let stderr = "";
    proc.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const out = proc.stdio[4] as NodeJS.ReadableStream;
    out.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.on("exit", () => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new BoardError(`the board browser closed (${p.method})`, 503));
      this.pending.clear();
      this.sessions.clear();
      this.onExit?.();
    });
    proc.on("error", () => {});
    try {
      const v = await withTimeout(this.send("Browser.getVersion"), 15000, "Chrome did not start within 15s");
      this.userAgent = String(v.userAgent ?? "").replace("HeadlessChrome", "Chrome");
      await this.send("Target.setDiscoverTargets", { discover: true });
      return true;
    } catch (err) {
      const quit = proc.exitCode !== null || proc.signalCode !== null;
      this.kill();
      const hint = stderr.trim().split("\n").slice(-3).join(" ");
      return { quit, message: `${(err as Error).message}${hint ? ` — ${hint}` : ""}` };
    }
  }

  // Messages end with a NUL byte. Only the new bytes are searched, and a message is joined once when it is complete:
  // a screencast frame is up to a few MB and arrives in many reads.
  private onData(chunk: Buffer) {
    let from = 0;
    let end: number;
    while ((end = chunk.indexOf(0, from)) >= 0) {
      this.parts.push(chunk.subarray(from, end));
      const raw = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
      this.parts = [];
      from = end + 1;
      this.dispatch(raw);
    }
    if (from < chunk.length) this.parts.push(chunk.subarray(from));
  }

  private dispatch(raw: Buffer) {
    let msg: any;
    try {
      msg = parseMessage(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(msg.error.message ?? "CDP error", p.method));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) {
      if (msg.sessionId) this.sessions.get(msg.sessionId)?.(msg.method, msg.params ?? {});
      else for (const fn of this.rootListeners) fn(msg.method, msg.params ?? {});
    }
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const pipe = this.proc?.stdio[3] as NodeJS.WritableStream | undefined;
    if (!pipe || !this.running) return Promise.reject(new BoardError("the board browser is not running", 503));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      pipe.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }

  /** Events without a session (Target.*, Browser.*). */
  onRoot(fn: EventFn) {
    this.rootListeners.add(fn);
    return () => this.rootListeners.delete(fn);
  }

  /** All events of one attached target. */
  onSession(sessionId: string, fn: EventFn) {
    this.sessions.set(sessionId, fn);
    return () => this.sessions.delete(sessionId);
  }

  kill() {
    const p = this.proc;
    if (!p) return;
    try {
      p.kill("SIGTERM");
    } catch {}
    setTimeout(() => p.exitCode === null && p.signalCode === null && p.kill("SIGKILL"), 2000).unref();
  }

  /** Quit Chrome and wait until it is gone (at most timeoutMs), so the next server start finds its profile free. */
  async stop(timeoutMs = 3000) {
    const p = this.proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    const gone = new Promise<void>((r) => p.once("exit", () => r()));
    this.kill();
    await Promise.race([gone, sleep(timeoutMs)]);
    if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FRAME_EVENT = '"method":"Page.screencastFrame"';
const DATA_KEY = Buffer.from('"data":"');

/**
 * One message from Chrome. Screencast frames take a short cut: the picture (base64, no escapes) is decoded straight
 * from the bytes and only the small rest goes through JSON.parse. Their params.data is then a Buffer, not a string.
 */
function parseMessage(raw: Buffer): any {
  if (raw.length > 4096 && raw.toString("latin1", 0, 80).includes(FRAME_EVENT)) {
    const key = raw.indexOf(DATA_KEY);
    const start = key + DATA_KEY.length;
    const stop = key < 0 ? -1 : raw.indexOf(0x22, start); // the closing quote
    if (stop > start) {
      const msg = JSON.parse(raw.toString("utf8", 0, start) + raw.toString("utf8", stop));
      if (msg?.params) {
        msg.params.data = Buffer.from(raw.toString("latin1", start, stop), "base64");
        return msg;
      }
    }
  }
  return JSON.parse(raw.toString("utf8"));
}

export class CdpError extends Error {
  constructor(
    message: string,
    public method: string,
  ) {
    super(message);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new BoardError(message, 504)), ms)))]).finally(() => clearTimeout(timer));
}
