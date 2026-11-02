// The board browser's network log: the pages it loaded and the data requests behind them (XHR/fetch), with the
// responses. The agent reads the JSON a page fetched (a listing, search results, chart data) exactly, instead of
// scraping it off the screen.
//
// What stays out:
// - Requests made while the person has taken the browser over (they may be signing in or paying).
// - Request and response headers (cookies, authorization).
// - Values under secret-looking keys (password, token, apiKey…) in URLs, request bodies and JSON responses.
// - Images, fonts, styles, scripts and media.
// Kept bodies live in server memory only, within a budget; the oldest go first.

export interface NetEntry {
  id: number;
  sessionId: string;
  requestId: string;
  targetId: string;
  at: number;
  method: string;
  url: string;
  type: string;
  redirects?: string[];
  postData?: string;
  postDataMissing?: boolean;
  status?: number;
  mime?: string;
  size?: number;
  state: "pending" | "done" | "failed";
  error?: string;
  body?: { text: string; base64: boolean };
  /** Why there is no kept body (too big, not text, gone). */
  bodyNote?: string;
}

const MAX_ENTRIES = 400;
const BODY_BUDGET = 24 * 1024 * 1024; // characters of kept bodies per browser
const MAX_KEPT_BODY = 4 * 1024 * 1024; // bigger bodies are not kept; save them with saveTo while the page is open
const MAX_POST = 64 * 1024;
/** Not recorded: they crowd out the data requests and hardly ever hold data. */
const STATIC = new Set(["Image", "Font", "Stylesheet", "Media", "Script", "Manifest", "TextTrack", "Ping", "CSPViolationReport", "Preflight", "SignedExchange", "Prefetch"]);
const KEEP_BODY = new Set(["Document", "XHR", "Fetch", "Other"]);
const TEXTUAL = /json|^text\/|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|csv/i;

/** Chrome's own buffers, so a body can still be read later (bigger ones, or ones not kept). */
export const NETWORK_ENABLE = { maxTotalBufferSize: 100 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024 };

type FetchBody = (sessionId: string, requestId: string) => Promise<{ body: string; base64Encoded: boolean }>;

export class NetLog {
  private entries: NetEntry[] = [];
  private inflight = new Map<string, NetEntry>();
  private seq = 0;
  private bodyChars = 0;

  constructor(
    /** False while the person has taken the browser over: nothing is recorded then. */
    private recording: () => boolean,
    private fetchBody: FetchBody,
  ) {}

  get size() {
    return this.entries.length;
  }
  get newest() {
    return this.seq;
  }

  onEvent(tab: { sessionId: string; targetId: string }, method: string, p: any) {
    const key = `${tab.sessionId}:${p.requestId}`;
    switch (method) {
      case "Network.requestWillBeSent": {
        const url = String(p.request?.url ?? "");
        if (!/^https?:/i.test(url)) return;
        const prev = this.inflight.get(key);
        if (prev && p.redirectResponse) {
          // Same request, new address.
          prev.redirects = [...(prev.redirects ?? []), prev.url].slice(-5);
          prev.url = hideInUrl(url);
          return;
        }
        if (STATIC.has(p.type) || /\/favicon\.ico(\?|$)/i.test(url) || !this.recording()) return;
        const e: NetEntry = {
          id: ++this.seq,
          sessionId: tab.sessionId,
          requestId: String(p.requestId),
          targetId: tab.targetId,
          at: Date.now(),
          method: String(p.request.method ?? "GET"),
          url: hideInUrl(url),
          type: String(p.type ?? "Other"),
          state: "pending",
        };
        if (typeof p.request.postData === "string") e.postData = hideInBody(p.request.postData.slice(0, MAX_POST));
        else if (p.request.hasPostData) e.postDataMissing = true;
        this.entries.push(e);
        this.inflight.set(key, e);
        while (this.entries.length > MAX_ENTRIES) this.drop(this.entries.shift()!);
        return;
      }
      case "Network.responseReceived": {
        const e = this.inflight.get(key);
        if (!e) return;
        e.status = p.response?.status;
        e.mime = p.response?.mimeType;
        // An icon or a font fetched as "Other": not data, drop it.
        if (/^(image|font|audio|video)\//i.test(e.mime ?? "")) {
          this.inflight.delete(key);
          this.entries.splice(this.entries.indexOf(e), 1);
        }
        return;
      }
      case "Network.loadingFinished": {
        const e = this.inflight.get(key);
        if (!e) return;
        this.inflight.delete(key);
        e.state = "done";
        e.size = p.encodedDataLength;
        if (KEEP_BODY.has(e.type) && TEXTUAL.test(e.mime ?? "")) void this.keep(e);
        return;
      }
      case "Network.loadingFailed": {
        const e = this.inflight.get(key);
        if (!e) return;
        this.inflight.delete(key);
        e.state = "failed";
        e.error = p.canceled ? "canceled" : String(p.errorText ?? "failed");
        return;
      }
    }
  }

  /** A tab went away: its unfinished requests never will finish. */
  forgetSession(sessionId: string) {
    for (const [key, e] of this.inflight) {
      if (e.sessionId !== sessionId) continue;
      this.inflight.delete(key);
      e.state = "failed";
      e.error = "tab closed";
    }
  }

  clear() {
    this.entries = [];
    this.inflight.clear();
    this.bodyChars = 0;
  }

  list(filter: { url?: string; type?: string; json?: boolean; since?: number; limit?: number }) {
    const needle = filter.url?.toLowerCase();
    const type = filter.type?.toLowerCase();
    const hits = this.entries.filter(
      (e) =>
        (!filter.since || e.id > filter.since) &&
        (!needle || e.url.toLowerCase().includes(needle) || safeDecode(e.url).toLowerCase().includes(needle)) &&
        (!type || e.type.toLowerCase() === type) &&
        (!filter.json || /json/i.test(e.mime ?? "")),
    );
    return { total: hits.length, entries: hits.slice(-(filter.limit ?? 40)) };
  }

  get(id: number) {
    return this.entries.find((e) => e.id === id);
  }

  /** The whole response: the kept one, or Chrome's copy while it still has it. */
  async body(e: NetEntry): Promise<{ text: string; base64: boolean }> {
    if (e.body) return e.body;
    if (e.state === "pending") throw new Error("still loading; try again in a moment");
    if (e.state === "failed") throw new Error(`the request failed (${e.error})`);
    let r;
    try {
      r = await this.fetchBody(e.sessionId, e.requestId);
    } catch {
      throw new Error("Chrome no longer has this response (the tab closed or it was dropped). Reload the page and read the new request.");
    }
    return { text: !r.base64Encoded && /json/i.test(e.mime ?? "") ? hideInJson(r.body) : r.body, base64: r.base64Encoded };
  }

  private async keep(e: NetEntry) {
    try {
      const r = await this.fetchBody(e.sessionId, e.requestId);
      if (!this.entries.includes(e)) return;
      if (r.body.length > MAX_KEPT_BODY) {
        e.bodyNote = `too big to keep (${r.body.length} chars); save it with saveTo while the page is open`;
        return;
      }
      const text = !r.base64Encoded && /json/i.test(e.mime ?? "") ? hideInJson(r.body) : r.body;
      e.body = { text, base64: r.base64Encoded };
      this.bodyChars += text.length;
      for (const old of this.entries) {
        if (this.bodyChars <= BODY_BUDGET) break;
        if (old.body && old !== e) this.dropBody(old, "dropped to make room for newer ones");
      }
    } catch {
      e.bodyNote = "Chrome kept no body";
    }
  }

  private drop(e: NetEntry) {
    this.inflight.delete(`${e.sessionId}:${e.requestId}`);
    if (e.body) this.bodyChars -= e.body.text.length;
  }
  private dropBody(e: NetEntry, note: string) {
    this.bodyChars -= e.body!.text.length;
    e.body = undefined;
    e.bodyNote = note;
  }
}

// ── hiding secrets ────────────────────────────────────────────────────────────
const SECRET_WORDS = new Set([
  "password", "passwd", "pass", "pwd", "passcode", "secret", "token", "otp", "pin", "cvc", "cvv", "ssn",
  "authorization", "auth", "credential", "credentials", "cookie", "signature",
]);
const SECRET_JOINED = new Set(["apikey", "servicekey", "accesskey", "secretkey", "privatekey", "clientsecret", "sessionid", "sessionkey", "authkey", "appkey"]);
export const HIDDEN = "(hidden)";

/** password, user_pass, accessToken, X-Api-Key, serviceKey… (but not "key", "authorName", "spinner" or "sigCd"). */
export function secretKey(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const joined = words.join("");
  return words.some((w) => SECRET_WORDS.has(w)) || [...SECRET_JOINED].some((j) => joined.endsWith(j));
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function hidePairs(query: string) {
  return query
    .split("&")
    .map((pair) => {
      const i = pair.indexOf("=");
      return i > 0 && secretKey(safeDecode(pair.slice(0, i))) ? `${pair.slice(0, i)}=${HIDDEN}` : pair;
    })
    .join("&");
}

export function hideInUrl(url: string) {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const hash = url.indexOf("#", q);
  const query = hash < 0 ? url.slice(q + 1) : url.slice(q + 1, hash);
  return `${url.slice(0, q + 1)}${hidePairs(query)}${hash < 0 ? "" : url.slice(hash)}`;
}

function hideValues(v: unknown, depth = 0): unknown {
  if (depth > 64 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => hideValues(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = secretKey(k) && x !== null && typeof x !== "object" ? HIDDEN : hideValues(x, depth + 1);
  return out;
}

/** JSON with secret-looking values hidden. Keeps an anti-hijacking prefix such as )]}' ; other text is left as it is. */
export function hideInJson(text: string) {
  const m = /^\s*(\)\]\}'[^\n]*\n|while\s*\(1\);|for\s*\(;;\);)/.exec(text);
  const prefix = m ? m[0] : "";
  try {
    return prefix + JSON.stringify(hideValues(JSON.parse(text.slice(prefix.length))));
  } catch {
    return text;
  }
}

/** A request body: JSON, a form, or multipart fields. */
export function hideInBody(text: string) {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) return hideInJson(text);
  if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(t)) return hidePairs(t);
  return text.replace(/(name="([^"]+)"[^\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([^\r\n]*)/g, (all, head, name) => (secretKey(name) ? `${head}${HIDDEN}` : all));
}
