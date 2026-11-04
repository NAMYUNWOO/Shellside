// WorkBoard PoC server: boards (each with its own terminal + Claude session), Board MCP per board, on one localhost port.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { BoardError } from "./board.ts";
import { handleMcp } from "./mcp.ts";
import { compileApp, ensureMonaco, ensureRuntime, loadSource, MONACO_OUT, RUNTIME_OUT } from "./apps.ts";
import { claudeAuth, composeRequest, isClaude, isShell, programName, requestTools } from "./agent.ts";
import { Library } from "./library.ts";
import { BoardRegistry, type BoardRuntime } from "./boards.ts";
import { BrowserService } from "./browser.ts";
import { findChrome, noChromeMessage } from "./cdp.ts";
import { startupNotes } from "./certs.ts";
import { HumanSessions, sessionCookie } from "./auth.ts";
import { contentHeaders, copyIntoWorkspace, describeFile, receiveFile } from "./files.ts";
import { createEntry, describeRoot, listDir, readText, statFile, writeText } from "./code.ts";
import { CATALOG_DOC, type Actor } from "../shared/catalog.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1"; // never expose a shell beyond this machine
const PORT = Number(process.env.WB_PORT ?? 4100);
const SERVER_URL = `http://${HOST}:${PORT}`;
const DATA_DIR = resolve(process.env.WB_DATA_DIR ?? join(ROOT, "data"));
const WORKSPACES = resolve(process.env.WB_WORKSPACES ?? join(ROOT, "workspaces"));
const LIBRARY_FILE = resolve(process.env.WB_LIBRARY ?? join(DATA_DIR, "library.json"));
const DIST = join(ROOT, "dist");
// `npm start` passes --production (NODE_ENV=… before a command is POSIX-only); the desktop app sets NODE_ENV.
const PROD = process.env.NODE_ENV === "production" || process.argv.includes("--production");

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(process.env.WB_ALLOWED_ORIGINS?.split(",").filter(Boolean) ?? []),
]);

ensureRuntime();
// Monaco for apps' CodeEditor: built in the background (a checkout, first start); served once it is there.
ensureMonaco().catch((err) => console.error(`[workboard] Monaco for apps did not build: ${(err as Error).message}`));
const library = new Library(LIBRARY_FILE);
// One headless Chrome (started on first use) behind every board's browser tools. Its profile lives in data/browser/.
const browsers = new BrowserService(DATA_DIR);
// Browsers paired with this server: the only requests that count as the person (see auth.ts).
const humans = new HumanSessions(join(DATA_DIR, "browser-sessions.json"), sessionCookie(PORT));
const boards = new BoardRegistry({ dataDir: DATA_DIR, workspacesDir: WORKSPACES, serverUrl: SERVER_URL, binDir: join(ROOT, "bin"), nodePath: process.execPath, compile: compileApp, browsers });

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

/** The agent says so (wb CLI, hooks, app writes); the person proves it with a paired browser's session cookie.
 *  Anything else (a script, Claude's own curl without the agent header) is neither, and is refused. */
const actorOf = (req: IncomingMessage): Actor | null => (req.headers["x-wb-actor"] === "agent" ? "agent" : humans.isHuman(req) ? "human" : null);
type Lang = "en" | "ko";
/** The board UI sends its language; messages meant for the person follow it. Agent-facing text stays English. */
const langOf = (req: IncomingMessage): Lang => (req.headers["x-wb-lang"] === "ko" ? "ko" : "en");
const L = (lang: Lang, en: string, ko: string) => (lang === "ko" ? ko : en);

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage, max = 2 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new BoardError("request body too large", 413);
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
function sendToAgent(rt: BoardRuntime, prompt: string, toolIds: string[], lang: Lang, sectionIds: string[] = []) {
  if (!prompt?.trim()) throw new BoardError(L(lang, "Write what you want Claude to do.", "Claude에게 보낼 내용을 적어 주세요."));
  const { tools, links, sections } = requestTools(rt.board, prompt, toolIds, sectionIds);
  if (!rt.shell.running) throw new BoardError(L(lang, "This board's terminal hasn't started yet. Open the terminal once.", "이 보드의 터미널이 아직 시작되지 않았습니다. 터미널을 한 번 열어 주세요."), 409);
  const text = composeRequest(prompt, tools, links, sections);
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
    rt.typeIntoClaude(text);
    mode = "claude";
  } else if (isShell(fg)) {
    rt.startClaude(text);
    mode = "started";
  } else {
    const prog = programName(fg);
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
type AuthRoute = [method: string, re: RegExp, handler: (ctx: { req: IncomingMessage; res: ServerResponse; body: any; lang: Lang }) => unknown];

const notPaired = (lang: Lang) => ({
  error: L(
    lang,
    "This browser isn't connected to the Shellside server. Scripts and agents: send x-wb-actor: agent, or use the wb CLI.",
    "이 브라우저는 Shellside 서버에 연결되지 않았습니다. 스크립트나 에이전트라면 x-wb-actor: agent 헤더를 보내거나 wb CLI를 쓰세요.",
  ),
  data: { reason: "pair" },
});

// Pairing a browser with this server (see auth.ts). Open to anyone who passes the Host/Origin checks: they only
// report the status, pair the very first browser, print a code in the server console, or check a typed code.
const authRoutes: AuthRoute[] = [
  ["GET", /^\/api\/auth\/status$/, ({ req }) => ({ paired: humans.isHuman(req), firstRun: humans.firstRun })],
  [
    "POST",
    /^\/api\/auth\/first$/,
    ({ req, res, lang }) => {
      const cookie = humans.pairFirst(req);
      if (!cookie) throw new BoardError(L(lang, "A browser is already connected to this server, so connect with a pairing code.", "이미 연결된 브라우저가 있어 연결 코드로 연결해야 합니다."), 409);
      res.setHeader("set-cookie", cookie);
      return { paired: true };
    },
  ],
  [
    "POST",
    /^\/api\/auth\/code$/,
    ({ lang }) => {
      const r = humans.requestCode();
      if (!r.ok) {
        const s = Math.ceil(r.retryInMs / 1000);
        throw new BoardError(L(lang, `Try again in ${s} s.`, `${s}초 뒤에 다시 시도해 주세요.`), 429);
      }
      return { expiresAt: r.expiresAt };
    },
  ],
  [
    "POST",
    /^\/api\/auth\/pair$/,
    ({ req, res, body, lang }) => {
      const r = humans.confirmCode(String(body?.code ?? ""), req, body?.temporary === true);
      if (r.ok) {
        res.setHeader("set-cookie", r.cookie);
        return { paired: true };
      }
      if (r.reason === "wrong_code") throw new BoardError(L(lang, `That code doesn't match. ${r.triesLeft === 1 ? "1 more try" : `${r.triesLeft} more tries`}.`, `코드가 맞지 않습니다. ${r.triesLeft}번 더 시도할 수 있습니다.`), 403);
      throw new BoardError(L(lang, "No code is active: it expired, was already used, or was cancelled. Show a new code.", "쓸 수 있는 코드가 없습니다. 시간이 지났거나, 이미 썼거나, 취소된 코드입니다. 코드를 다시 띄워 주세요."), 403);
    },
  ],
];

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
          foreground: programName(fg),
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
      const prog = programName(fg);
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
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
      return sendToAgent(rt, String(body?.prompt ?? ""), list(body?.toolIds), lang, list(body?.sectionIds));
    },
  ],
  ["GET", /^\/catalog$/, () => ({ doc: CATALOG_DOC })],
  [
    "POST",
    /^\/agent\/hook$/,
    ({ rt, body, res }) => {
      // Claude Code's HTTP hooks POST the hook input as is (hook_event_name, notification_type, …). Their answer must be
      // empty: a JSON body would be read as hook output. Older board workspaces still run `wb hook`, which sends {event}.
      if (typeof body?.hook_event_name === "string") {
        rt.onHook(body.hook_event_name, { notificationType: body.notification_type, message: body.message });
        res.writeHead(204).end();
        return;
      }
      rt.onHook(String(body?.event ?? ""), { notificationType: body?.notificationType, message: body?.message });
      return { state: rt.agentState() };
    },
  ],
  ["GET", /^\/tools\/([\w-]+)$/, ({ rt, params }) => rt.board.getTool(params[0])],
  [
    "POST",
    /^\/tools$/,
    async ({ rt, body, actor }) => {
      if (body?.kind === "code") {
        // A code editor again (undo of a delete): the person's only, its root checked on the disk.
        humanOnly(actor, "code editors");
        const props = await describeRoot(String(body?.props?.root ?? ""));
        return rt.board.createTool(actor, { ...body, props }, { fileOk: true });
      }
      if (body?.kind !== "file") return rt.board.createTool(actor, body ?? {});
      // A file tool again (undo of a delete): the person's only, and its details come from the file itself.
      humanOnly(actor, "file tools");
      const props = await describeFile(rt.meta.workspace, String(body?.props?.path ?? ""));
      return rt.board.createTool(actor, { ...body, props, title: body.title || props.fileName }, { fileOk: true });
    },
  ],
  // Code editors: open one on a folder or a file (the person's choice of path), then list, read, save under its root.
  [
    "POST",
    /^\/code-tools$/,
    async ({ rt, body, actor }) => {
      humanOnly(actor, "opening a code editor");
      const props = await describeRoot(String(body?.path ?? ""));
      const at = body?.at && Number.isFinite(body.at.x) && Number.isFinite(body.at.y) ? { at: { x: body.at.x + 450, y: body.at.y + 80 } } : {};
      const title = props.root.split(/[\\/]/).filter(Boolean).pop() || props.root;
      return rt.board.createTool(actor, { kind: "code", title, props, state: { open: props.single ? [""] : [], active: "" }, ...at }, { fileOk: true });
    },
  ],
  ["GET", /^\/code\/([\w-]+)\/list$/, ({ rt, params, url, actor }) => codeOp(rt, actor, params[0], (r, one) => listDir(r, one, url.searchParams.get("dir") ?? ""))],
  ["GET", /^\/code\/([\w-]+)\/file$/, ({ rt, params, url, actor }) => codeOp(rt, actor, params[0], (r, one) => readText(r, one, url.searchParams.get("path") ?? ""))],
  ["GET", /^\/code\/([\w-]+)\/stat$/, ({ rt, params, url, actor }) => codeOp(rt, actor, params[0], (r, one) => statFile(r, one, url.searchParams.get("path") ?? ""))],
  [
    "PUT",
    /^\/code\/([\w-]+)\/file$/,
    ({ rt, params, url, body, actor }) => codeOp(rt, actor, params[0], (r, one) => writeText(r, one, url.searchParams.get("path") ?? "", body?.text, body?.baseMtime, body?.force === true)),
  ],
  ["POST", /^\/code\/([\w-]+)\/new$/, ({ rt, params, body, actor }) => codeOp(rt, actor, params[0], (r, one) => createEntry(r, one, String(body?.path ?? ""), body?.dir === true))],
  // The desktop app's drop: copy the file from where it is on this machine (the window knows its path).
  [
    "POST",
    /^\/file-tools\/from-path$/,
    async ({ rt, body, actor }) => {
      humanOnly(actor, "dropping files");
      const dest = await copyIntoWorkspace(rt.meta.workspace, String(body?.path ?? ""));
      return fileTool(rt, actor, dest, body?.at);
    },
  ],
  ["PATCH", /^\/tools\/([\w-]+)$/, ({ rt, params, body, actor }) => rt.board.updateTool(actor, params[0], body ?? {})],
  ["PATCH", /^\/tools\/([\w-]+)\/layout$/, ({ rt, params, body }) => rt.board.setLayout(params[0], body ?? {})],
  ["POST", /^\/tools\/([\w-]+)\/patch$/, ({ rt, params, body, actor }) => rt.board.patchState(actor, params[0], body?.patch, body?.baseVersion)],
  ["POST", /^\/links$/, ({ rt, body, actor }) => rt.board.createLink(actor, body ?? {})],
  // Sections: named areas that group tools.
  ["POST", /^\/sections$/, ({ rt, body, actor }) => rt.board.createSection(actor, body ?? {})],
  ["PATCH", /^\/sections\/([\w-]+)$/, ({ rt, params, body, actor }) => rt.board.updateSection(actor, params[0], body ?? {})],
  ["PATCH", /^\/sections\/([\w-]+)\/layout$/, ({ rt, params, body }) => rt.board.setSectionLayout(params[0], body ?? {}, body?.moveContents === true)],
  [
    "DELETE",
    /^\/sections\/([\w-]+)$/,
    ({ rt, params, actor, url }) => {
      rt.board.deleteSection(actor, params[0], url.searchParams.get("contents") === "1");
      return { ok: true };
    },
  ],
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
    "GET",
    /^\/browser\/([\w-]+)\/network$/,
    ({ rt, params, url, actor }) => {
      const p = url.searchParams;
      return browserOf(rt, params[0]).network(actor, {
        url: p.get("url") ?? undefined,
        type: p.get("type") ?? undefined,
        json: p.get("json") === "1",
        since: p.get("since") ?? undefined,
        limit: Number(p.get("limit")) || undefined,
      });
    },
  ],
  [
    "GET",
    /^\/browser\/([\w-]+)\/network\/(n?\d+)$/,
    ({ rt, params, url, actor }) => browserOf(rt, params[0]).networkBody(actor, params[1], { maxChars: Number(url.searchParams.get("max")) || undefined }),
  ],
  [
    "POST",
    /^\/browser\/([\w-]+)\/network\/(n?\d+)\/save$/,
    ({ rt, params, body, actor }) => browserOf(rt, params[0]).networkBody(actor, params[1], { saveTo: String(body?.path ?? "") }),
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
async function saveUpload(rt: BoardRuntime, req: IncomingMessage, url: URL, actor: Actor) {
  humanOnly(actor, "uploads");
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

// ── code editors ──────────────────────────────────────────────────────────────
/** Run fn on a code tool's root, for the person (the agent edits files with its own tools). */
function codeOp<T>(rt: BoardRuntime, actor: Actor, toolId: string, fn: (root: string, single: boolean) => Promise<T>) {
  humanOnly(actor, "the code editor");
  const t = rt.board.getTool(toolId);
  if (t.kind !== "code") throw new BoardError("not a code editor", 400);
  return fn(t.props.root, t.props.single === true);
}

// ── file tools ────────────────────────────────────────────────────────────────
/** A file tool for a file now in the board's workspace. at: where the person dropped it (its top-left). */
async function fileTool(rt: BoardRuntime, actor: Actor, path: string, at?: { x: number; y: number }) {
  const props = await describeFile(rt.meta.workspace, path);
  const w = 340;
  const where = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { at: { x: at.x + w / 2, y: at.y + 80 } } : {};
  return rt.board.createTool(actor, { kind: "file", title: props.fileName, props, state: { note: "" }, width: w, ...where }, { fileOk: true });
}

/** The file behind a file tool, for the person's browser: previews and "Open". head=N: just its first N bytes, as text. */
async function serveFile(rt: BoardRuntime, toolId: string, url: URL, res: ServerResponse, actor: Actor) {
  humanOnly(actor, "files");
  const t = rt.board.getTool(toolId);
  if (t.kind !== "file") throw new BoardError("not a file tool", 400);
  const { path, fileName, mime } = t.props as { path: string; fileName: string; mime: string };
  if (!existsSync(path)) throw new BoardError(`the file is gone from ${path}`, 404);
  const head = Number(url.searchParams.get("head"));
  if (Number.isFinite(head) && head > 0) {
    res.writeHead(200, { ...contentHeaders(fileName, "text/plain"), "content-disposition": "inline" });
    return createReadStream(path, { start: 0, end: Math.min(head, 64 * 1024) - 1 }).pipe(res);
  }
  res.writeHead(200, { ...contentHeaders(fileName, mime), "content-length": statSync(path).size });
  createReadStream(path).pipe(res);
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
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".json": "application/json", ".ico": "image/x-icon", ".ttf": "font/ttf", ".woff2": "font/woff2" };
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
    // A hook's input carries the whole tool result (a file Claude read, say): far more than any other request.
    const big = path === "/agent/hook" ? 64 * 1024 * 1024 : /^\/code\/[\w-]+\/file$/.test(path) ? 12 * 1024 * 1024 : undefined;
    const body = method === "GET" || method === "DELETE" ? undefined : await readBody(req, big);
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
  // Monaco, for an app that shows a CodeEditor (a few MB: a browser keeps it, and asks again only if it changed).
  if (req.method === "GET" && req.url?.split("?")[0] === "/sandbox/monaco.js") {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!ALLOWED_HOSTS.has(host)) return send(res, 403, { error: "host not allowed" });
    try {
      await ensureMonaco();
    } catch {
      return send(res, 500, { error: "the code editor for apps did not build (see the server log)" });
    }
    const st = statSync(MONACO_OUT);
    const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const head = { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", etag, "access-control-allow-origin": "*" };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, head);
      return res.end();
    }
    res.writeHead(200, head);
    return res.end(readFileSync(MONACO_OUT));
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
    if (url.pathname.startsWith("/api/auth/")) {
      const hit = await dispatch(authRoutes, url.pathname, req, res, (_params, body) => ({ req, res, body, lang: langOf(req) }));
      if (!hit) send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      return;
    }
    const actor = actorOf(req);
    if (url.pathname.startsWith("/api/") && !actor) return send(res, 401, notPaired(langOf(req)));
    const scoped = /^\/api\/b\/([\w-]+)(\/.*)$/.exec(url.pathname);
    if (scoped) {
      const rt = boards.get(scoped[1]);
      const sub = scoped[2];
      if (sub === "/files" && req.method === "POST") return send(res, 200, await saveUpload(rt, req, url, actor!));
      // A file dropped in a browser: streamed to disk, any size.
      if (sub === "/file-tools" && req.method === "POST") {
        humanOnly(actor!, "dropping files");
        // octet-stream is not a CORS-simple type, so other sites cannot post here without a preflight we never grant.
        if (!(req.headers["content-type"] ?? "").startsWith("application/octet-stream")) throw new BoardError("content-type must be application/octet-stream", 415);
        const dest = await receiveFile(req, rt.meta.workspace, url.searchParams.get("name") ?? "file");
        const x = Number(url.searchParams.get("x"));
        const y = Number(url.searchParams.get("y"));
        return send(res, 200, await fileTool(rt, actor!, dest, Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined));
      }
      const fileContent = /^\/file-tools\/([\w-]+)\/content$/.exec(sub);
      if (fileContent && req.method === "GET") return serveFile(rt, fileContent[1], url, res, actor!);
      const hit = await dispatch(boardRoutes, sub, req, res, (params, body) => ({ req, res, params, url, body, actor: actor!, lang: langOf(req), rt }));
      if (!hit) send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const hit = await dispatch(globalRoutes, url.pathname, req, res, (params, body) => ({ req, res, params, url, body, actor: actor!, lang: langOf(req) }));
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
  // Terminals, the live board and the board browser's controls are the person's: only a paired browser opens them.
  if (!humans.isHuman(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
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
      if (replay.length) {
        // Marked, so the page can tell old output from new: queries in it (e.g. "what terminal are you?") were answered
        // long ago, and answering them again would type the answers into whatever runs now.
        ws.send(JSON.stringify({ t: "replay" }));
        ws.send(replay);
      }
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

// The desktop app runs this server in an Electron utility process and talks to it over parentPort: it pairs its own
// window, and shows pairing codes in a window (it has no console). Only the app's main process can reach parentPort.
type ParentPort = { postMessage(msg: unknown): void; on(event: "message", fn: (e: { data: any }) => void): void };
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent) {
  humans.onCode = (code, expiresAt) => parent.postMessage({ type: "pairing-code", code, expiresAt });
  parent.on("message", ({ data }) => {
    if (data?.type === "app-session") parent.postMessage({ type: "app-session", ...humans.appSession() });
    else if (data?.type === "status") parent.postMessage({ type: "status", claudeRunning: boards.list().filter((b) => b.claudeRunning).length });
    else if (data?.type === "quit") shutdown();
  });
}

// A big file dropped in a browser can take longer than Node's default 5 minutes per request (this is local only).
server.requestTimeout = 0;

server.on("error", (err: NodeJS.ErrnoException) => {
  const message = err.code === "EADDRINUSE" ? `port ${PORT} is in use (another Shellside server?). Set WB_PORT to use another.` : err.message;
  console.error(`[workboard] cannot start: ${message}`);
  parent?.postMessage({ type: "error", code: err.code, message });
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  parent?.postMessage({ type: "ready", url: SERVER_URL });
  console.log(`[workboard] server  ${SERVER_URL}`);
  console.log(`[workboard] boards  ${boards.list().map((b) => `${b.name} (${b.id})`).join(", ")}`);
  console.log(`[workboard] MCP     ${SERVER_URL}/mcp/<boardId>`);
  console.log(`[workboard] folders ${join(WORKSPACES, "<boardId>")}`);
  console.log(PROD ? `[workboard] open    ${SERVER_URL}` : `[workboard] open    http://127.0.0.1:5173  (vite)`);
  // Say it now rather than when someone first adds a browser frame.
  if (!findChrome()) console.log(`[workboard] browser ${noChromeMessage()}`);
  try {
    for (const note of startupNotes()) console.log(`[workboard] browser ${note}`);
  } catch (err) {
    console.log(`[workboard] browser could not check certificates: ${(err as Error).message}`);
  }
});

let stopping = false;
function shutdown() {
  if (stopping) process.exit(0); // asked twice: do not wait
  stopping = true;
  boards.disposeAll();
  void browsers.dispose().finally(() => process.exit(0));
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);
