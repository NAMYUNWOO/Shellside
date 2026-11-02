// One headless Chrome for the whole server, driven over the Chrome DevTools Protocol (CDP).
// The connection is a pipe (--remote-debugging-pipe), not a TCP port: no other process or website can reach it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { BoardError } from "./board.ts";
import { browserEnv } from "./certs.ts";

type EventFn = (method: string, params: any) => void;

/**
 * Pixel density the board browser renders at. Screencast frames come at the screen's density, not the page's
 * emulated one, so the whole headless browser runs at 2× and every frame is equally sharp on high-density displays.
 */
export const BROWSER_SCALE = Math.max(1, Math.min(3, Number(process.env.WB_BROWSER_SCALE) || 2));

/** What the browser lookup depends on (tests pass their own). */
export interface ChromeHost {
  env: NodeJS.ProcessEnv;
  os: NodeJS.Platform;
  home: string;
  /** Linux under WSL (Windows Subsystem for Linux). */
  wsl: boolean;
}

let wsl: boolean | undefined;
function isWsl(): boolean {
  if (wsl !== undefined) return wsl;
  if (platform() !== "linux") return (wsl = false);
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return (wsl = true);
  try {
    return (wsl = /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8")));
  } catch {
    return (wsl = false);
  }
}

const thisHost = (): ChromeHost => ({ env: process.env, os: platform(), home: homedir(), wsl: isWsl() });

/**
 * A Windows program seen from WSL (`/mnt/c/.../chrome.exe`) can't be the board browser: Chrome is driven over a pipe on
 * file descriptors 3 and 4 (--remote-debugging-pipe), and WSL passes only stdin, stdout and stderr to a Windows .exe.
 */
const windowsProgram = (host: ChromeHost, file: string) => host.wsl && /\.exe$/i.test(file);

/** Where to find a Chromium-based browser. WB_CHROME wins; then the usual install places; then Playwright's copy. */
export function findChrome(host = thisHost()): string | null {
  const { env, os, home } = host;
  if (env.WB_CHROME) return existsSync(env.WB_CHROME) && !windowsProgram(host, env.WB_CHROME) ? env.WB_CHROME : null;
  const candidates: string[] = [];
  if (os === "darwin") {
    for (const base of ["/Applications", join(home, "Applications")]) {
      candidates.push(
        `${base}/Google Chrome.app/Contents/MacOS/Google Chrome`,
        `${base}/Chromium.app/Contents/MacOS/Chromium`,
        `${base}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
        `${base}/Brave Browser.app/Contents/MacOS/Brave Browser`,
      );
    }
  } else if (os === "win32") {
    for (const base of [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(`${base}\\Google\\Chrome\\Application\\chrome.exe`, `${base}\\Microsoft\\Edge\\Application\\msedge.exe`);
    }
  } else {
    for (const dir of (env.PATH ?? "").split(delimiter)) {
      if (host.wsl && dir.startsWith("/mnt/")) continue; // Windows folders on WSL's PATH: nothing there can be used
      for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) candidates.push(join(dir, name));
    }
  }
  candidates.push(...playwrightChromes(host));
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * Playwright's Chromium (`npx playwright install chromium`), newest first. Current releases install Chrome for Testing
 * (`chrome-linux64/chrome`, `chrome-mac-arm64/Google Chrome for Testing.app`); older ones used Chromium builds.
 */
export function playwrightChromes({ env, os, home }: ChromeHost): string[] {
  const custom = env.PLAYWRIGHT_BROWSERS_PATH;
  const root =
    custom && custom !== "0"
      ? custom
      : os === "darwin"
        ? join(home, "Library", "Caches", "ms-playwright")
        : os === "win32"
          ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ms-playwright")
          : join(env.XDG_CACHE_HOME || join(home, ".cache"), "ms-playwright");
  let dirs: string[];
  try {
    dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d));
  } catch {
    return [];
  }
  dirs.sort((a, b) => Number(b.slice("chromium-".length)) - Number(a.slice("chromium-".length)));
  const cft = ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"];
  const chromium = ["Chromium.app", "Contents", "MacOS", "Chromium"];
  const layouts =
    os === "darwin"
      ? [["chrome-mac-arm64", ...cft], ["chrome-mac-x64", ...cft], ["chrome-mac-arm64", ...chromium], ["chrome-mac", ...chromium]]
      : os === "win32"
        ? [["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"]]
        : [["chrome-linux64", "chrome"], ["chrome-linux", "chrome"]];
  return dirs.flatMap((d) => layouts.map((parts) => join(root, d, ...parts)));
}

const PLAYWRIGHT_INSTALL = `"npx playwright install chromium"`;

/** Why no board browser was found, and the shortest way to get one on this computer. */
export function noChromeMessage(host = thisHost()): string {
  const chosen = host.env.WB_CHROME;
  if (chosen && windowsProgram(host, chosen))
    return `WB_CHROME points to a Windows program (${chosen}), which can't be the board browser under WSL. Install a Linux Chromium inside WSL with ${PLAYWRIGHT_INSTALL}, then unset WB_CHROME and restart the server.`;
  if (chosen) return `WB_CHROME is set to ${chosen}, but there is no file there. Fix or unset it and restart the server.`;
  if (host.wsl)
    return `No Linux Chrome or Chromium was found for the board browser. Under WSL, Windows Chrome can't be used: install a Linux Chromium inside WSL with ${PLAYWRIGHT_INSTALL} (no restart needed), or set WB_CHROME to one and restart the server.`;
  return `No Chrome, Chromium, Edge or Brave was found for the board browser. Install Google Chrome or run ${PLAYWRIGHT_INSTALL} (no restart needed), or set WB_CHROME to a Chromium-based browser's executable and restart the server.`;
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
  /** CDP's UserAgentMetadata for this browser, to send with the user agent (null if it could not be read). */
  userAgentMetadata: object | null = null;

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
    if (!exe) throw new BoardError(noChromeMessage(), 503);
    // WB_BROWSER_CA: its own certificate database (certs.ts). Without it, Chrome runs with the server's environment.
    const env = browserEnv(dirname(this.profileDir));
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
      // The debugging pipe and headless mode set navigator.webdriver, and sites then treat every visit as a bot's
      // (Google answers the first search with a captcha). A person drives this browser most of the time.
      "--disable-blink-features=AutomationControlled",
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
      const r = await this.start(exe, args, env);
      if (r === true) return;
      if (!r.quit || attempt === 3) {
        // A Linux Chromium from Playwright needs system libraries that a minimal install (WSL, containers) may lack.
        const hint = /error while loading shared libraries/.test(r.message)
          ? ` Install the libraries it needs with "npx playwright install-deps chromium".`
          : /as root without --no-sandbox|zygote/i.test(r.message) && process.getuid?.() === 0
            ? " Chrome doesn't run as root with its sandbox on: start the server as a normal user."
            : "";
        throw new BoardError(`could not start the board browser (${exe}): ${r.message}${hint}`, 503);
      }
      await sleep(1000 * attempt);
    }
  }

  /** One try at starting Chrome: true, or why not (quit: it exited by itself rather than hanging). */
  private async start(exe: string, args: string[], env?: NodeJS.ProcessEnv): Promise<true | { quit: boolean; message: string }> {
    const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env });
    this.proc = proc;
    this.parts = [];
    let stderr = "";
    proc.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const out = proc.stdio[4] as NodeJS.ReadableStream;
    out.on("data", (chunk: Buffer) => this.onData(chunk));
    // On Linux these pipes are socket pairs, and a Chrome that dies or fails to start resets them (ECONNRESET, EPIPE).
    // The exit handler below cleans up; unhandled, the error would take the whole server down.
    for (const s of [proc.stdio[3], proc.stdio[4], proc.stderr]) (s as NodeJS.EventEmitter | null)?.on("error", () => {});
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
      this.userAgentMetadata = await this.readUserAgentMetadata().catch(() => null);
      await this.send("Target.setDiscoverTargets", { discover: true });
      return true;
    } catch (err) {
      const quit = proc.exitCode !== null || proc.signalCode !== null;
      this.kill();
      const hint = stderr.trim().split("\n").slice(-3).join(" ");
      return { quit, message: `${(err as Error).message}${hint ? ` — ${hint}` : ""}` };
    }
  }

  /**
   * The browser's own brand, version and platform (navigator.userAgentData, the Sec-CH-UA headers), read once from a
   * throwaway tab. Overriding the user agent without them clears them, and a Chrome that sends none looks like a bot.
   */
  private async readUserAgentMetadata(): Promise<object | null> {
    // userAgentData exists only on secure pages, and about:blank is not one.
    const { targetId } = await this.send("Target.createTarget", { url: "chrome://version" });
    try {
      const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
      for (let i = 0; i < 30; i++) {
        const r = await this.send("Runtime.evaluate", { expression: UA_METADATA_JS, awaitPromise: true, returnByValue: true }, sessionId).catch(() => null);
        const m = r?.result?.value;
        if (m && Array.isArray(m.brands) && m.brands.length) return m;
        await sleep(100); // still on the blank page it starts with
      }
      return null;
    } finally {
      await this.send("Target.closeTarget", { targetId }).catch(() => {});
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

/** navigator.userAgentData in the shape of CDP's Emulation.UserAgentMetadata. */
const UA_METADATA_JS = `(async () => {
  const d = navigator.userAgentData;
  if (!d) return null;
  const v = await d.getHighEntropyValues(["architecture", "bitness", "fullVersionList", "model", "platformVersion", "uaFullVersion", "wow64", "formFactors"]);
  return { brands: v.brands, fullVersionList: v.fullVersionList, fullVersion: v.uaFullVersion, platform: v.platform, platformVersion: v.platformVersion,
    architecture: v.architecture, model: v.model, mobile: v.mobile, bitness: v.bitness, wow64: v.wow64, formFactors: v.formFactors };
})()`;

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
