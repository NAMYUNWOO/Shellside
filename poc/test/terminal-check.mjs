// End-to-end check of a board terminal on this OS, with a fake `claude` first on PATH (CI runs it on Windows, macOS and
// Linux). It starts the server on a free port with throwaway folders, then checks: the shell starts and the board sees
// it; `wb` runs there; a request from the board starts Claude and reaches it intact (Korean, quotes, $, newlines);
// Claude Code's HTTP hooks move the board's state; `claude auth status` works (claude.cmd on Windows).
//   node test/terminal-check.mjs
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const POC = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const tmp = mkdtempSync(join(tmpdir(), "wb-terminal-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
};

// A fake Claude Code: prints its arguments, then (as the real one does) reads a pasted prompt up to Enter.
const fakeDir = join(tmp, "fakebin");
const fake = join(fakeDir, "fake-claude.mjs");
mkdirSync(fakeDir, { recursive: true });
writeFileSync(
  fake,
  `const a = process.argv.slice(2);
if (a[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "fake" })); process.exit(0); }
console.log("ARGV:" + Buffer.from(JSON.stringify(a)).toString("base64"));
let got = Buffer.alloc(0), timer;
if (process.stdin.isTTY) process.stdin.setRawMode(true);
// A pasted newline can arrive as Enter too: take everything until input stops after an Enter.
process.stdin.on("data", (d) => {
  got = Buffer.concat([got, d]);
  clearTimeout(timer);
  if (got.includes(13)) timer = setTimeout(() => { console.log("GOT:" + got.toString("base64")); process.exit(0); }, 800);
});
setTimeout(() => process.exit(0), 30000);
`,
);
if (WIN) writeFileSync(join(fakeDir, "claude.cmd"), `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`);
else {
  writeFileSync(join(fakeDir, "claude"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`);
  chmodSync(join(fakeDir, "claude"), 0o755);
}

const port = await new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const BASE = `http://127.0.0.1:${port}`;
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const server = spawn(process.execPath, [join(POC, "node_modules", "tsx", "dist", "cli.mjs"), join(POC, "server", "index.ts")], {
  cwd: POC,
  env: {
    ...process.env,
    [pathKey]: fakeDir + delimiter + process.env[pathKey],
    // macOS/Linux: an empty home, so no shell profile puts a real `claude` ahead of the fake one.
    ...(WIN ? {} : { HOME: tmp }),
    WB_PORT: String(port),
    WB_DATA_DIR: join(tmp, "data"),
    WB_WORKSPACES: join(tmp, "ws"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
process.on("exit", () => server.kill());
process.on("uncaughtException", (err) => finish(err.stack));
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  await sleep(500);
  up = await fetch(`${BASE}/api/auth/status`).then((r) => r.ok, () => false);
}
if (!up) await finish(`server did not start:\n${serverLog}`);

const paired = await fetch(`${BASE}/api/auth/first`, { method: "POST", headers: { origin: BASE } });
const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0];
check("first browser pairs", paired.ok && !!cookie);
const H = { cookie, origin: BASE };
const api = async (method, path, body, extra = {}) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { ...H, ...extra, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
};
const status = async () => (await api("GET", "/api/b/main/agent/status")).data;
const hook = (body) => api("POST", "/api/b/main/agent/hook", body, { "x-wb-actor": "agent", cookie: "" });

const auth = (await api("GET", "/api/agent/auth?refresh=1")).data;
check("claude auth status runs (claude.cmd on Windows)", auth.installed && auth.loggedIn && auth.method === "fake", JSON.stringify(auth));

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?board=main`, { headers: H });
let out = "";
ws.on("message", (d, binary) => binary && (out += d.toString("utf8")));
await new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});
ws.send(JSON.stringify({ t: "init", cols: 200, rows: 50 }));
const type = (text) => ws.send(JSON.stringify({ t: "in", d: text }));
const until = async (what, fn, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
};
const isShellName = (n) => /^(powershell|pwsh|bash|zsh|sh|dash)$/.test(n);
const shell = await until("shell", async () => {
  const t = (await status()).terminal;
  return isShellName(t.foreground) ? t.foreground : null;
});
check("the board sees the shell in the foreground", !!shell, shell ?? (await status()).terminal.foreground);

type("wb help\r");
check("wb runs in the board terminal", !!(await until("wb", () => out.includes("WorkBoard from the terminal"))));

if (WIN) {
  type("Start-Sleep -Seconds 4\r");
  const during = await until("sleep", async () => ((await status()).terminal.foreground === "Start-Sleep" ? "Start-Sleep" : null), 3000);
  check("PowerShell reports the program it runs", during === "Start-Sleep");
  check("…and itself again when it ends", !!(await until("back", async () => isShellName((await status()).terminal.foreground), 8000)));
}

// Never start a real Claude: the terminal must find the fake one. (`which`, not `command -v`: in bash, `claude` is the
// board's wrapper function.) The marker is split as typed, so the echoed command line can't match.
type(WIN ? 'Write-Output ("WH" + "ICH<" + (Get-Command claude -CommandType Application).Source + ">")\r' : 'echo "WH""ICH<$(which claude)>"\r');
const which = await until("which", () => /WHICH<([^>\r\n]*)>/.exec(out)?.[1], 10000);
const fakeFound = !!which && which.toLowerCase().startsWith(fakeDir.toLowerCase());
check("the terminal finds the fake claude", fakeFound, which ?? "nothing");
if (!fakeFound) await finish("stopping: a request now could start a real Claude");

// The SessionStart hook from the board's settings, run as Claude Code runs it: exec form (command + args, no shell) or
// through sh, with the terminal's environment and the hook input on stdin. It must print nothing (that would go into
// Claude's context). WB_URL can point it somewhere else (only the wb CLI form reads it).
async function runSessionStartHook(wbUrl = BASE) {
  const settings = JSON.parse(readFileSync(join(tmp, "data", "sessions", "main", "settings.json"), "utf8"));
  const h = settings.hooks.SessionStart[0].hooks[0];
  const env = { ...process.env, WB_URL: wbUrl, WB_BOARD: "main", WB_NODE: process.execPath };
  const child = h.args ? spawn(h.command, h.args, { env }) : spawn("sh", ["-c", h.command], { env });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stdin.end(JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup", cwd: tmp }));
  const code = await new Promise((r) => child.on("close", r));
  return { type: h.type, form: h.args ? "exec" : "shell", code, stdout };
}

// A request from the board while the shell is in front: Claude starts with it.
const prompt = `Say "hi" — 한국어 'single' $HOME %PATH% \`tick\` & | ; done.\nSecond line.`;
const sent = await api("POST", "/api/b/main/agent/send", { prompt, toolIds: [] });
check("the board starts Claude with a request", sent.data?.mode === "started", JSON.stringify(sent.data));
const argvLine = await until("argv", () => /ARGV:([A-Za-z0-9+/=]+)/.exec(out)?.[1]);
const argv = argvLine ? JSON.parse(Buffer.from(argvLine, "base64").toString("utf8")) : [];
const strip = (s) => s.replace(/\x1b\[20[01]~/g, "").replace(/\r$/, "");
if (WIN) {
  check("the claude wrapper adds the board's MCP config, settings and rules", ["--mcp-config", "--settings", "--append-system-prompt-file"].every((f) => argv.includes(f)), JSON.stringify(argv).slice(0, 300));
  const t = (await status()).terminal;
  check("the board sees Claude running (and not ready yet)", t.claudeRunning && t.agentState === "starting", JSON.stringify(t));
  // The board's SessionStart hook, as Claude Code runs it when the session is up; the board then pastes the request.
  const ran = await runSessionStartHook();
  check("the SessionStart hook is a command hook that runs and prints nothing", ran.type === "command" && ran.code === 0 && ran.stdout === "", JSON.stringify(ran));
  check("SessionStart makes Claude ready", (await status()).terminal.agentState === "idle", (await status()).terminal.agentState);
  const got = await until("paste", () => /GOT:([A-Za-z0-9+/=]+)/.exec(out)?.[1], 15000);
  const text = got ? strip(Buffer.from(got, "base64").toString("utf8")) : "";
  check("the request reaches Claude intact", text.replace(/\r\n?/g, "\n") === prompt, JSON.stringify(text).slice(0, 200));
} else {
  check("the request reaches Claude intact as its argument", argv.at(-1) === prompt, JSON.stringify(argv.at(-1)).slice(0, 200));
  type("\r"); // the fake Claude ends at Enter
  // The fake Claude shows as "node" here, so the board can't count it as Claude: catch what the hook sends instead.
  const caught = [];
  const catcher = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      caught.push({ url: req.url, actor: req.headers["x-wb-actor"], body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((r) => catcher.listen(0, "127.0.0.1", r));
  const ran = await runSessionStartHook(`http://127.0.0.1:${catcher.address().port}`);
  catcher.close();
  const got = caught[0];
  check("the SessionStart hook runs and prints nothing", ran.type === "command" && ran.code === 0 && ran.stdout === "", JSON.stringify(ran));
  check("…and reports SessionStart for this board as the agent", got?.url === "/api/b/main/agent/hook" && got.actor === "agent" && JSON.parse(got.body).event === "SessionStart", JSON.stringify(got));
}
check("the shell is in front again when Claude exits", !!(await until("back", async () => isShellName((await status()).terminal.foreground), 35000)));

// Hooks while Claude is not running don't change what the board shows, and old-style hooks still work.
const old = await hook({ event: "Stop" });
check("an old wb-hook post still answers JSON", old.status === 200 && old.data?.state === "none", JSON.stringify(old.data));
const big = await hook({ hook_event_name: "PostToolUse", tool_response: "x".repeat(5_000_000) });
check("a hook carrying a 5 MB tool result is accepted", big.status === 204, String(big.status));
const anon = await fetch(`${BASE}/api/b/main/agent/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("a hook without the agent header is refused", anon.status === 401, String(anon.status));

ws.close();
finish();

function finish(error) {
  if (finish.done) return;
  finish.done = true;
  if (error) {
    console.log(`FAIL ${error}`);
    failures++;
  }
  server?.kill();
  if (failures) console.log(`\nterminal output:\n${out.slice(-4000)}\n\nserver log:\n${serverLog.slice(-3000)}`);
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  setTimeout(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
    process.exit(failures ? 1 : 0);
  }, 500);
  return new Promise(() => {}); // nothing after this runs
}

