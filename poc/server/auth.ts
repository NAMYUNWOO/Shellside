// Who counts as the person: only a browser holding a session cookie this server issued. Everything else that reaches
// the server (the wb CLI, Claude's own curl, any script on this machine) is the agent at most. Before this, a request
// that simply left out the agent header was taken as the person's, so Claude in a board's terminal could approve its
// own asks, or connect to its own terminal and answer its own permission prompts.
//
// Pairing: the first browser that opens a server nobody has paired with becomes the person's. No agent can be running
// then, because Claude starts from a board's terminal and only a paired browser can open one. Every later browser
// enters a one-time code that the server prints in its own console (the person's terminal, not a board's).
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";

export const SESSION_COOKIE = "wb_session";
const COOKIE_MAX_AGE = 400 * 24 * 3600; // the longest Chrome keeps a cookie
const CODE_DIGITS = 8;
const CODE_TTL_MS = 10 * 60_000;
const CODE_TRIES = 5;
/** A new code at most this often, so guessing stays hopeless (5 tries per code). */
const CODE_GAP_MS = 5_000;

interface Session {
  id: string;
  /** sha256 of the cookie value: the file alone does not let anyone act as the person. */
  hash: string;
  label: string;
  createdAt: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class HumanSessions {
  private sessions: Session[];
  private hashes: Set<string>;
  /** Set when the file was missing at start: nobody has paired with this server yet. */
  private fresh: boolean;
  private code: { digits: string; expires: number; tries: number } | null = null;
  private codeAt = 0;

  constructor(
    private file: string,
    private log: (line: string) => void = (line) => console.log(line),
  ) {
    this.fresh = !existsSync(file);
    this.sessions = this.fresh ? [] : load(file);
    this.hashes = new Set(this.sessions.map((s) => s.hash));
  }

  /** No browser has been paired yet (a damaged file does not count: then every browser needs a code). */
  get firstRun() {
    return this.fresh && this.sessions.length === 0;
  }

  /** The request comes from a paired browser. */
  isHuman(req: IncomingMessage) {
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    return !!token && this.hashes.has(sha256(token));
  }

  /** First run only: pair this browser without a code. The Set-Cookie value, or null when one is paired already. */
  pairFirst(req: IncomingMessage): string | null {
    return this.firstRun ? this.issue(req) : null;
  }

  /** Print a code in the server console. Asked again within a few seconds, the same code stays. */
  requestCode(): { ok: true; expiresAt: number } | { ok: false; retryInMs: number } {
    const now = Date.now();
    if (this.code && now < this.code.expires && now - this.codeAt < CODE_GAP_MS) return { ok: true, expiresAt: this.code.expires };
    if (now - this.codeAt < CODE_GAP_MS) return { ok: false, retryInMs: CODE_GAP_MS - (now - this.codeAt) };
    this.codeAt = now;
    const digits = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
    this.code = { digits, expires: now + CODE_TTL_MS, tries: 0 };
    this.log(
      [
        "",
        "[workboard] ┌ Pairing code for a new browser · 새 브라우저 연결 코드",
        `[workboard] │   ${digits.slice(0, 4)}-${digits.slice(4)}   (10 min, single use · 10분 동안 한 번)`,
        "[workboard] └ Type it in the browser that asked to connect. If you didn't ask, ignore it. · 연결하려는 브라우저 화면에 입력하세요. 요청한 적이 없다면 무시하세요.",
        "",
      ].join("\n"),
    );
    return { ok: true, expiresAt: this.code.expires };
  }

  /** Pair the browser that typed the code. Five wrong tries cancel the code. temporary: a script's session, kept in
   *  memory only, so it ends when the server stops. */
  confirmCode(input: string, req: IncomingMessage, temporary = false): { ok: true; cookie: string } | { ok: false; reason: "no_code" } | { ok: false; reason: "wrong_code"; triesLeft: number } {
    const code = this.code;
    if (!code || Date.now() > code.expires) {
      this.code = null;
      return { ok: false, reason: "no_code" };
    }
    const given = String(input ?? "").replace(/\D/g, "");
    if (given.length !== code.digits.length || !timingSafeEqual(Buffer.from(given), Buffer.from(code.digits))) {
      code.tries++;
      const triesLeft = CODE_TRIES - code.tries;
      if (triesLeft <= 0) {
        this.code = null;
        this.log(`[workboard] pairing code cancelled after ${CODE_TRIES} wrong tries · 연결 코드를 ${CODE_TRIES}번 잘못 입력해 취소했습니다`);
        return { ok: false, reason: "no_code" };
      }
      this.log(`[workboard] wrong pairing code (${triesLeft === 1 ? "1 try" : `${triesLeft} tries`} left) · 연결 코드가 맞지 않음 (${triesLeft}번 남음)`);
      return { ok: false, reason: "wrong_code", triesLeft };
    }
    this.code = null;
    return { ok: true, cookie: this.issue(req, temporary) };
  }

  private issue(req: IncomingMessage, temporary = false) {
    const token = randomBytes(32).toString("base64url");
    const session = { id: randomBytes(6).toString("hex"), hash: sha256(token), label: browserLabel(req.headers["user-agent"]), createdAt: new Date().toISOString() };
    this.hashes.add(session.hash);
    this.fresh = false;
    if (temporary) {
      this.log(`[workboard] paired ${session.label} until the server stops · 서버가 멈출 때까지 연결했습니다`);
      return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
    }
    this.sessions.push(session);
    this.save();
    this.log(`[workboard] paired a browser (${session.label}); ${this.sessions.length} paired · 브라우저를 연결했습니다`);
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: this.sessions }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function load(file: string): Session[] {
  try {
    const list = JSON.parse(readFileSync(file, "utf8"))?.sessions;
    return Array.isArray(list) ? list.filter((s) => typeof s?.hash === "string") : [];
  } catch {
    return [];
  }
}

function cookieValue(header: string | undefined, name: string) {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** "Chrome on macOS": enough to recognise a browser in the console, nothing more. */
function browserLabel(ua = "") {
  if (/^node\b/i.test(ua)) return "a script";
  const name = /HeadlessChrome\//.test(ua) ? "Headless Chrome" : /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "a browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${name} on ${os}` : name;
}
