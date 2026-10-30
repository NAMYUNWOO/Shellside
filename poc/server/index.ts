// WorkBoard PoC server: boards (each with its own terminal + Claude session), Board MCP per board, on one localhost port.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { BoardError } from "./board.ts";
import { handleMcp } from "./mcp.ts";
import { compileApp, ensureRuntime, loadSource, RUNTIME_OUT } from "./apps.ts";
import { claudeAuth, composeRequest, isClaude, isShell, requestTools, shellQuote } from "./agent.ts";
import { Library } from "./library.ts";
import { BoardRegistry, type BoardRuntime } from "./boards.ts";
import { BrowserService } from "./browser.ts";
import { CATALOG_DOC, type Actor } from "../shared/catalog.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1"; // never expose a shell beyond this machine
const PORT = Number(process.env.WB_PORT ?? 4100);
const SERVER_URL = `http://${HOST}:${PORT}`;
const DATA_DIR = resolve(process.env.WB_DATA_DIR ?? join(ROOT, "data"));
const WORKSPACES = resolve(process.env.WB_WORKSPACES ?? join(ROOT, "workspaces"));
const LIBRARY_FILE = resolve(process.env.WB_LIBRARY ?? join(DATA_DIR, "library.json"));
const DIST = join(ROOT, "dist");
const PROD = process.env.NODE_ENV === "production";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(process.env.WB_ALLOWED_ORIGINS?.split(",").filter(Boolean) ?? []),
]);

ensureRuntime();
const library = new Library(LIBRARY_FILE);
const HOOK_COMMAND = `"${process.execPath}" "${join(ROOT, "bin", "wb.mjs")}" hook`;
// One headless Chrome (started on first use) behind every board's browser tools. Its profile lives in data/browser/.
const browsers = new BrowserService(DATA_DIR);
const boards = new BoardRegistry({ dataDir: DATA_DIR, workspacesDir: WORKSPACES, serverUrl: SERVER_URL, binDir: join(ROOT, "bin"), hookCommand: HOOK_COMMAND, compile: compileApp, browsers });

// ── request guards ───────────────────────────────────────────────────────────
// Blocks other websites (cross-site requests carry their Origin) and DNS rebinding (foreign Host).
function allowed(req: IncomingMessage): string | null {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!ALLOWED_HOSTS.has(host)) return `host "${host}" not allowed`;
  // Browsers mark requests a page on another site makes (e.g. <img src="http://127.0.0.1:4100/...">). Simple GETs
  // like that carry no Origin, and some GETs have effects (they consume the agent's events), so refuse them all.
  if (req.headers["sec-fetch-site"] === "cross-site") return "cross-site request not allowed";
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return `origin "${origin}" not allowed`;
  return null;
}

const actorOf = (req: IncomingMessage): Actor => (req.headers["x-wb-actor"] === "agent" ? "agent" : "human");
type Lang = "en" | "ko";
/** The board UI sends its language; messages meant for the person follow it. Agent-facing text stays English. */
const langOf = (req: IncomingMessage): Lang => (req.headers["x-wb-lang"] === "ko" ? "ko" : "en");
const L = (lang: Lang, en: string, ko: string) => (lang === "ko" ? ko : en);

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new BoardError("request body too large", 413);
    chunks.push(chunk);
  }
  if (!size) return undefined;
  const type = req.headers["content-type"] ?? "";
  if (!type.includes("application/json")) throw new BoardError("content-type must be application/json", 415);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BoardError("invalid JSON body");
  }
}

function abortOnClose(res: ServerResponse) {
  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());
  return ctrl.signal;
}

const channelName = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new BoardError("bad channel name in the URL");
  }
};
const clampTimeout = (v: string | null, def: number) => Math.min(Math.max(Number(v ?? def) || def, 1), 600) * 1000;
/** "auto" = the board's only browser. */
const browserOf = (rt: BoardRuntime, id: string) => rt.browsers.pick(id === "auto" ? undefined : id);
const humanOnly = (actor: Actor, what: string) => {
  if (actor !== "human") throw new BoardError(`${what} must come from the person`, 403);
};

/** Hand a request to the board's agent: into Claude's prompt if it runs, else start Claude with it. */
function sendToAgent(rt: BoardRuntime, prompt: string, toolIds: string[], lang: Lang) {
  if (!prompt?.trim()) throw new BoardError(L(lang, "Write what you want Claude to do.", "Claude에게 보낼 내용을 적어 주세요."));
  const { tools, links } = requestTools(rt.board, prompt, toolIds);
  if (!rt.shell.running) throw new BoardError(L(lang, "This board's terminal hasn't started yet. Open the terminal once.", "이 보드의 터미널이 아직 시작되지 않았습니다. 터미널을 한 번 열어 주세요."), 409);
  const text = composeRequest(prompt, tools, links);
  const fg = rt.shell.foreground();
  let mode: "claude" | "started";
  const state = rt.agentState();
  // Never press Enter into a dialog: on a permission prompt it would approve the pending tool call.
  if (state === "permission")
    throw new BoardError(
      L(lang, "Claude is waiting for a permission answer in the terminal. Answer it there first.", "Claude가 터미널에서 권한 확인을 기다리고 있습니다. 먼저 터미널에서 답해 주세요."),
      409,
      { reason: "permission" },
    );
  if (state === "starting")
    throw new BoardError(
      L(lang, "Claude isn't ready yet (folder trust prompt or similar). Check the terminal.", "Claude가 아직 준비되지 않았습니다(폴더 신뢰 확인 등). 터미널에서 확인해 주세요."),
      409,
      { reason: "starting" },
    );
  if (isClaude(fg)) {
    // Bracketed paste keeps line breaks inside Claude's input; Enter (a moment later) submits it.
    rt.shell.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => rt.shell.write("\r"), 150);
    mode = "claude";
  } else if (isShell(fg)) {
    rt.shell.write(`claude ${shellQuote(text)}\r`);
    rt.markStarting();
    mode = "started";
  } else {
    const prog = fg.split("/").pop();
    throw new BoardError(L(lang, `"${prog}" is running in the terminal, so this can't be sent. Try again when it finishes.`, `터미널에서 "${prog}"이(가) 실행 중이라 보낼 수 없습니다. 끝난 뒤 다시 보내세요.`), 409);
  }
  rt.board.logPrompt(prompt.trim(), toolIds);
  return { mode };
}

// ── routes ───────────────────────────────────────────────────────────────────
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  url: URL;
  body: any;
  actor: Actor;
  lang: Lang;
}
type BoardCtx = Ctx & { rt: BoardRuntime };
type Route = [method: string, re: RegExp, handler: (ctx: Ctx) => unknown];
type BoardRoute = [method: string, re: RegExp, handler: (ctx: BoardCtx) => unknown];

const globalRoutes: Route[] = [
  ["GET", /^\/api\/health$/, () => ({ ok: true, boards: boards.list().length })],
  ["GET", /^\/api\/catalog$/, () => ({ doc: CATALOG_DOC })],
  ["GET", /^\/api\/agent\/auth$/, async ({ url }) => claudeAuth(url.searchParams.get("refresh") === "1")],
  ["GET", /^\/api\/boards$/, () => ({ boards: boards.list() })],
  [
    "POST",
    /^\/api\/boards$/,
    ({ body, actor }) => {
      humanOnly(actor, "new boards");
      return boards.create(String(body?.name ?? "")).summary();
    },
  ],
  ["PATCH", /^\/api\/boards\/([\w-]+)$/, ({ params, body }) => boards.rename(params[0], String(body?.name ?? ""))],
  [
    "DELETE",
    /^\/api\/boards\/([\w-]+)$/,
    ({ params, actor, lang }) => {
      humanOnly(actor, "deleting a board");
      boards.remove(params[0], lang);
      return { ok: true };
    },
  ],
  ["GET", /^\/api\/library$/, ({ url }) => ({ items: library.list(url.searchParams.get("q") ?? undefined) })],
  ["PATCH", /^\/api\/library\/([\w-]+)$/, ({ params, body }) => library.update(params[0], body ?? {})],
  [
    "DELETE",
    /^\/api\/library\/([\w-]+)$/,
    ({ params }) => {
      library.remove(params[0]);
      return { ok: true };
    },
  ],
];

// Everything below lives under /api/b/<boardId>/…
const boardRoutes: BoardRoute[] = [
  ["GET", /^\/board$/, ({ rt }) => rt.board.snapshot()],
  [
    "GET",
    /^\/agent\/status$/,
    async ({ rt, url }) => {
      const fg = rt.shell.foreground();
      return {
        claude: await claudeAuth(url.searchParams.get("refresh") === "1"),
        terminal: {
          running: rt.shell.running,
          foreground: fg.split("/").pop() ?? "",
          claudeRunning: isClaude(fg),
          agentState: rt.agentState(),
          loginRequired: rt.login.needed,
          loginHint: rt.login.hint,
        },
      };
    },
  ],
  [
    "POST",
    /^\/agent\/login$/,
    ({ rt, actor, lang }) => {
      humanOnly(actor, "sign-in");
      if (!rt.shell.running) throw new BoardError(L(lang, "This board's terminal hasn't started yet. Open the terminal once.", "이 보드의 터미널이 아직 시작되지 않았습니다. 터미널을 한 번 열어 주세요."), 409);
      const fg = rt.shell.foreground();
      // Inside a running Claude the person signs in on its own screen (/login); typing there could pick a menu item.
      if (isClaude(fg)) return { mode: "claude" };
      const prog = fg.split("/").pop();
      if (!isShell(fg)) throw new BoardError(L(lang, `"${prog}" is running in the terminal. Try again when it finishes.`, `터미널에서 "${prog}"이(가) 실행 중입니다. 끝난 뒤 다시 시도하세요.`), 409);
      rt.shell.write("claude auth login\r");
      return { mode: "started" };
    },
  ],
  [
    "POST",
    /^\/agent\/send$/,
    ({ rt, body, actor, lang }) => {
      humanOnly(actor, "requests to the agent");
      return sendToAgent(rt, String(body?.prompt ?? ""), Array.isArray(body?.toolIds) ? body.toolIds.map(String) : [], lang);
    },
  ],
  ["GET", /^\/catalog$/, () => ({ doc: CATALOG_DOC })],
  [
    "POST",
    /^\/agent\/hook$/,
    ({ rt, body }) => {
      rt.onHook(String(body?.event ?? ""), { notificationType: body?.notificationType, message: body?.message });
      return { state: rt.agentState() };
    },
  ],
  ["GET", /^\/tools\/([\w-]+)$/, ({ rt, params }) => rt.board.getTool(params[0])],
  ["POST", /^\/tools$/, ({ rt, body, actor }) => rt.board.createTool(actor, body ?? {})],
  ["PATCH", /^\/tools\/([\w-]+)$/, ({ rt, params, body, actor }) => rt.board.updateTool(actor, params[0], body ?? {})],
  ["PATCH", /^\/tools\/([\w-]+)\/layout$/, ({ rt, params, body }) => rt.board.setLayout(params[0], body ?? {})],
  ["POST", /^\/tools\/([\w-]+)\/patch$/, ({ rt, params, body, actor }) => rt.board.patchState(actor, params[0], body?.patch, body?.baseVersion)],
  ["POST", /^\/links$/, ({ rt, body, actor }) => rt.board.createLink(actor, body ?? {})],
  ["PATCH", /^\/links\/([\w-]+)$/, ({ rt, params, body, actor }) => rt.board.updateLink(actor, params[0], body ?? {})],
  [
    "DELETE",
    /^\/links\/([\w-]+)$/,
    ({ rt, params, actor }) => {
      rt.board.deleteLink(actor, params[0]);
      return { ok: true };
    },
  ],
  [
    "DELETE",
    /^\/tools\/([\w-]+)$/,
    ({ rt, params, actor }) => {
      rt.board.deleteTool(actor, params[0]);
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/library$/,
    ({ rt, body, actor }) => library.save(actor, rt.board.getTool(String(body?.toolId ?? "")), { name: body?.name, description: body?.description, includeState: !!body?.includeState }),
  ],
  [
    "POST",
    /^\/library\/([\w-]+)\/use$/,
    ({ rt, params, body, actor }) => {
      const tpl = library.get(params[0]);
      const tool = rt.board.createTool(actor, { kind: tpl.kind, title: body?.title ?? tpl.name, description: tpl.description, props: tpl.props, state: tpl.state, width: tpl.width, at: body?.at });
      library.markUsed(tpl.id);
      return tool;
    },
  ],
  [
    "POST",
    /^\/asks$/,
    async ({ rt, body, actor, url, res }) => {
      const ask = rt.board.createAsk(actor, body ?? {});
      const wait = url.searchParams.get("wait");
      return wait ? rt.board.waitAsk(ask.id, clampTimeout(wait, 120), abortOnClose(res)) : ask;
    },
  ],
  ["GET", /^\/asks\/([\w-]+)\/wait$/, ({ rt, params, url, res }) => rt.board.waitAsk(params[0], clampTimeout(url.searchParams.get("timeout"), 120), abortOnClose(res))],
  [
    "POST",
    /^\/asks\/([\w-]+)\/answer$/,
    ({ rt, params, body, actor, lang }) => {
      humanOnly(actor, "answers");
      return rt.board.answerAsk(params[0], { approved: body?.approved, values: body?.values, comment: body?.comment }, lang);
    },
  ],
  [
    "POST",
    /^\/messages$/,
    ({ rt, body, actor }) => {
      humanOnly(actor, "messages");
      if (!body?.text?.trim()) throw new BoardError("text is required");
      return rt.board.postMessage(body.text.trim(), body.toolId);
    },
  ],
  [
    "POST",
    /^\/stop$/,
    ({ rt, body, actor }) => {
      humanOnly(actor, "stop requests");
      return rt.board.postStop(body?.reason);
    },
  ],
  ["GET", /^\/events\/wait$/, async ({ rt, url, res }) => ({ events: await rt.board.waitForAgentEvents(clampTimeout(url.searchParams.get("timeout"), 60), abortOnClose(res)) })],
  // channels: named values every app on the board shares (see CATALOG_DOC)
  ["GET", /^\/channels$/, ({ rt }) => ({ channels: rt.board.listChannels() })],
  ["GET", /^\/channels\/([^/]+)$/, ({ rt, params }) => rt.board.getChannel(channelName(params[0]))],
  [
    "PUT",
    /^\/channels\/([^/]+)$/,
    ({ rt, params, body, actor }) =>
      rt.board.setChannel(actor, channelName(params[0]), body?.value, {
        toolId: typeof body?.toolId === "string" ? body.toolId : undefined,
        baseVersion: typeof body?.baseVersion === "number" ? body.baseVersion : undefined,
      }),
  ],
  [
    "DELETE",
    /^\/channels\/([^/]+)$/,
    ({ rt, params, actor }) => {
      rt.board.deleteChannel(actor, channelName(params[0]));
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/apps$/,
    ({ rt, body, actor }) => {
      const src = loadSource(rt.meta.workspace, body ?? {});
      return rt.board.createTool(actor, { kind: "app", title: body?.title ?? "App", description: body?.description, props: { ...src, height: body?.height }, state: body?.state ?? {}, width: body?.width });
    },
  ],
  [
    "PATCH",
    /^\/apps\/([\w-]+)$/,
    ({ rt, params, body, actor }) => {
      const t = rt.board.getTool(params[0]);
      if (t.kind !== "app") throw new BoardError(`"${t.title}" is not an app`);
      const src = loadSource(rt.meta.workspace, { source: body?.source, sourcePath: body?.sourcePath ?? (body?.source ? undefined : t.props.sourcePath) });
      return rt.board.updateTool(actor, t.id, { title: body?.title, description: body?.description, props: { ...t.props, ...src } });
    },
  ],
  ["GET", /^\/apps\/([\w-]+)\/snapshot$/, ({ rt, params }) => rt.browserRpc("app_snapshot", rt.board.getTool(params[0]).id, {})],
  [
    "POST",
    /^\/apps\/([\w-]+)\/invoke$/,
    async ({ rt, params, body }) => ({ result: await rt.browserRpc("app_invoke", rt.board.getTool(params[0]).id, { action: body?.action, args: body?.args }) }),
  ],
  ["GET", /^\/apps\/([\w-]+)\/logs$/, ({ rt, params, url }) => ({ logs: rt.board.getAppLogs(params[0], url.searchParams.get("clear") === "1") })],
  [
    "POST",
    /^\/apps\/([\w-]+)\/logs$/,
    ({ rt, params, body }) => {
      rt.board.appendAppLog(params[0], String(body?.level ?? "log"), String(body?.message ?? ""));
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/apps\/([\w-]+)\/emit$/,
    ({ rt, params, body, actor }) => {
      humanOnly(actor, "app events");
      return rt.board.appEvent(params[0], String(body?.type ?? "event"), body?.payload);
    },
  ],
  // the board browser (see CATALOG_DOC, kind "browser")
  [
    "POST",
    /^\/browser$/,
    async ({ rt, body, actor }) => {
      const bt = await rt.browsers.open(actor, { url: String(body?.url ?? ""), toolId: body?.toolId, title: body?.title, width: body?.width, height: body?.height });
      if (body?.snapshot === false) return { toolId: bt.toolId, url: bt.tab?.url, title: bt.tab?.title };
      return bt.snapshot(actor, { maxChars: body?.maxChars });
    },
  ],
  [
    "GET",
    /^\/browser\/([\w-]+)\/snapshot$/,
    ({ rt, params, url, actor }) =>
      browserOf(rt, params[0]).snapshot(actor, {
        selector: url.searchParams.get("selector") ?? undefined,
        interactive: url.searchParams.get("interactive") === "1",
        maxChars: Number(url.searchParams.get("max")) || undefined,
      }),
  ],
  ["POST", /^\/browser\/([\w-]+)\/act$/, ({ rt, params, body, actor }) => browserOf(rt, params[0]).act(actor, body?.steps, { snapshot: body?.snapshot, maxChars: body?.maxChars })],
  [
    "GET",
    /^\/browser\/([\w-]+)\/screenshot$/,
    async ({ rt, params, url, actor, res }) => {
      const shot = await browserOf(rt, params[0]).screenshot(actor, { fullPage: url.searchParams.get("full") === "1", format: url.searchParams.get("format") === "jpeg" ? "jpeg" : "png" });
      res.writeHead(200, { "content-type": shot.mimeType, "cache-control": "no-store", "x-wb-page-url": encodeURI(shot.url ?? "") });
      res.end(shot.data);
    },
  ],
  [
    "POST",
    /^\/browser\/([\w-]+)\/handoff$/,
    async ({ rt, params, body, actor, res }) => {
      if (actor !== "agent") throw new BoardError("hand-offs come from the agent", 403);
      const a = await browserOf(rt, params[0]).handoff(String(body?.message ?? "Please finish this step in the browser."), Math.min(Math.max(Number(body?.timeout) || 300, 5), 1800), abortOnClose(res));
      return { askId: a.id, status: a.status, ...(a.answer ?? {}) };
    },
  ],
  [
    "POST",
    /^\/terminal\/input$/,
    ({ rt, body, actor }) => {
      humanOnly(actor, "terminal input from the board");
      if (typeof body?.text !== "string" || !body.text) throw new BoardError("text is required");
      if (!rt.shell.running) throw new BoardError("the terminal is not running", 409);
      rt.shell.write(body.text);
      return { ok: true };
    },
  ],
];

// ── file uploads from apps: saved into the board's workspace so its agent can read them by path ──
const MAX_UPLOAD = 25 * 1024 * 1024;
async function saveUpload(rt: BoardRuntime, req: IncomingMessage, url: URL) {
  humanOnly(actorOf(req), "uploads");
  // octet-stream is not a CORS-simple type, so other sites cannot post here without a preflight we never grant.
  if (!(req.headers["content-type"] ?? "").startsWith("application/octet-stream")) throw new BoardError("content-type must be application/octet-stream", 415);
  const tool = rt.board.getTool(url.searchParams.get("toolId") ?? "");
  const name = (url.searchParams.get("name") ?? "file").normalize("NFC");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD) throw new BoardError(`file is larger than ${MAX_UPLOAD / 1024 / 1024} MB`, 413);
    chunks.push(chunk);
  }
  const ws = rt.meta.workspace;
  const dir = join(ws, ".board", "uploads", tool.id);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(ws, ".board", ".gitignore"))) writeFileSync(join(ws, ".board", ".gitignore"), "*\n");
  const safe = name.replace(/[^\w.\-가-힣 ]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
  const abs = join(dir, `${Date.now()}-${safe}`);
  writeFileSync(abs, Buffer.concat(chunks));
  const meta = { path: abs, relPath: relative(ws, abs), name, size, type: url.searchParams.get("type") ?? "" };
  rt.board.fileUploaded(tool.id, meta);
  return meta;
}

// ── open source notices (written by `vite build`, see build.license in vite.config.ts) ──
const LICENSES = "third-party-licenses.md";
function serveLicenses(res: ServerResponse) {
  const file = join(DIST, LICENSES);
  const found = existsSync(file);
  res.writeHead(found ? 200 : 404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
  res.end(found ? readFileSync(file) : `The open source list of the board UI is written by \`npm run build\` (dist/${LICENSES}). Run it once, then reload.\n`);
}

// ── static files (production build) ─────────────────────────────────────────
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".json": "application/json", ".ico": "image/x-icon" };
function serveStatic(url: URL, res: ServerResponse) {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  let file = resolve(DIST, rel || "index.html");
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  if (!existsSync(file)) return send(res, 404, { error: "run `npm run build` first, or use `npm run dev`" });
  // No other site may frame the board (it could trick a click into an approval or the terminal).
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
  res.end(readFileSync(file));
}

async function dispatch<C>(routes: [string, RegExp, (ctx: C) => unknown][], path: string, req: IncomingMessage, res: ServerResponse, make: (params: string[], body: any) => C) {
  for (const [method, re, handler] of routes) {
    const m = re.exec(path);
    if (!m || req.method !== method) continue;
    const body = method === "GET" || method === "DELETE" ? undefined : await readBody(req);
    const result = await handler(make(m.slice(1), body));
    if (!res.headersSent && !res.writableEnded) send(res, 200, result);
    return true;
  }
  return false;
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // The app iframes have an opaque origin ("null"). They may load the runtime script, and nothing else.
  if (req.method === "GET" && req.url?.split("?")[0] === "/sandbox/runtime.js") {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!ALLOWED_HOSTS.has(host)) return send(res, 403, { error: "host not allowed" });
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "access-control-allow-origin": "*" });
    return res.end(readFileSync(RUNTIME_OUT));
  }
  const denied = allowed(req);
  if (denied) return send(res, 403, { error: denied });
  const url = new URL(req.url ?? "/", SERVER_URL);
  try {
    const mcp = /^\/mcp\/([\w-]+)$/.exec(url.pathname);
    if (mcp) {
      if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
      const rt = boards.get(mcp[1]);
      return await handleMcp(rt.board, { workspace: rt.meta.workspace, browserRpc: rt.browserRpc.bind(rt), library, browsers: rt.browsers }, req, res, await readBody(req));
    }
    const scoped = /^\/api\/b\/([\w-]+)(\/.*)$/.exec(url.pathname);
    if (scoped) {
      const rt = boards.get(scoped[1]);
      const sub = scoped[2];
      if (sub === "/files" && req.method === "POST") return send(res, 200, await saveUpload(rt, req, url));
      const hit = await dispatch(boardRoutes, sub, req, res, (params, body) => ({ req, res, params, url, body, actor: actorOf(req), lang: langOf(req), rt }));
      if (!hit) send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const hit = await dispatch(globalRoutes, url.pathname, req, res, (params, body) => ({ req, res, params, url, body, actor: actorOf(req), lang: langOf(req) }));
      if (!hit) send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      return;
    }
    if (url.pathname === `/${LICENSES}` && req.method === "GET") return serveLicenses(res);
    if (PROD) return serveStatic(url, res);
    send(res, 404, { error: "dev mode: open the Vite app at http://127.0.0.1:5173" });
  } catch (err) {
    const status = err instanceof BoardError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: (err as Error).message, ...(err instanceof BoardError && err.data ? { data: err.data } : {}) });
  }
});

// ── WebSockets: /ws/pty?board=… (terminal bytes) and /ws/board?board=… (live board) ──
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const denied = allowed(req);
  // A WebSocket always carries an Origin from browsers; require an allowed one so no website can open these shells.
  if (denied || !req.headers.origin) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  const url = new URL(req.url ?? "/", SERVER_URL);
  let rt: BoardRuntime;
  try {
    rt = boards.get(url.searchParams.get("board") ?? "");
  } catch {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return socket.destroy();
  }
  if (url.pathname === "/ws/browser") {
    const toolId = url.searchParams.get("tool") ?? "";
    let ok = false;
    try {
      ok = rt.board.getTool(toolId).kind === "browser";
    } catch {}
    if (!ok) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }
    return wss.handleUpgrade(req, socket, head, (ws) => attachBrowser(rt, toolId, ws));
  }
  if (url.pathname !== "/ws/pty" && url.pathname !== "/ws/board") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => (url.pathname === "/ws/pty" ? attachPty(rt, ws) : attachBoard(rt, ws)));
});

/** A board view of one browser tool: page frames (binary) out, the person's mouse/keys/navigation (JSON) in. */
function attachBrowser(rt: BoardRuntime, toolId: string, ws: WebSocket) {
  let bt;
  try {
    bt = rt.browsers.get(toolId);
  } catch {
    return ws.close();
  }
  const view = bt;
  void view.addViewer(ws);
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    view.handleViewerMessage(ws, msg);
  });
  ws.on("close", () => view.removeViewer(ws));
}

function attachPty(rt: BoardRuntime, ws: WebSocket) {
  const shell = rt.shell;
  let offData: (() => void) | null = null;
  let offExit: (() => void) | null = null;
  const start = (cols: number, rows: number, resize = true) => {
    const fresh = !shell.running;
    shell.ensureStarted(cols, rows);
    if (!fresh) {
      if (resize) shell.resize(cols, rows); // hidden panes attach without taking over the size
      const replay = shell.replayBuffer();
      if (replay.length) ws.send(replay);
    }
    offData?.();
    offExit?.();
    offData = shell.onData((d) => ws.readyState === ws.OPEN && ws.send(d));
    offExit = shell.onExit((code) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: "exit", code })));
  };
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === "init" || msg.t === "restart") start(msg.cols | 0 || 100, msg.rows | 0 || 30, msg.resize !== false);
    else if (msg.t === "in" && typeof msg.d === "string") shell.write(msg.d);
    else if (msg.t === "resize") shell.resize(msg.cols | 0, msg.rows | 0);
  });
  ws.on("close", () => {
    offData?.();
    offExit?.();
  });
}

function attachBoard(rt: BoardRuntime, ws: WebSocket) {
  ws.send(JSON.stringify({ type: "snapshot", ...rt.board.snapshot(), library: library.list() }));
  const off = rt.board.subscribe((change) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(change)));
  const offLib = library.subscribe((items) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: "library", items })));
  rt.clients.add(ws);
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg?.type === "rpc_result") rt.rpcResult(msg);
  });
  ws.on("close", () => {
    off();
    offLib();
    rt.clients.delete(ws);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`[workboard] server  ${SERVER_URL}`);
  console.log(`[workboard] boards  ${boards.list().map((b) => `${b.name} (${b.id})`).join(", ")}`);
  console.log(`[workboard] MCP     ${SERVER_URL}/mcp/<boardId>`);
  console.log(`[workboard] folders ${WORKSPACES}/<boardId>`);
  console.log(PROD ? `[workboard] open    ${SERVER_URL}` : `[workboard] open    http://127.0.0.1:5173  (vite)`);
});

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(0); // asked twice: do not wait
    stopping = true;
    boards.disposeAll();
    void browsers.dispose().finally(() => process.exit(0));
  });
}
