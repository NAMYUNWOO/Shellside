// Shellside desktop app: runs the board server (server/index.mjs) in an Electron utility process and shows the board
// in a window, so nobody has to start anything from a terminal. The board's own terminals still run the person's shell
// (PowerShell on Windows) with Claude Code in it, exactly as with `npm start`.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, utilityProcess } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { checkForUpdates, latestRelease, setAutoCheck, updateSettings } from "./updates.mjs";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const ko = () => app.getLocale().startsWith("ko");
const T = (en, kr) => (ko() ? kr : en);
/** SHELLSIDE_SMOKE=<file>: start, check the board and a terminal, write the result there, quit (CI). */
const SMOKE = process.env.SHELLSIDE_SMOKE;

/** The first free port from 4110 on (4100 is the default of `npm run dev`, which may run beside the app). */
async function freePort(from = Number(process.env.WB_PORT) || 4110) {
  for (let port = from; port < from + 40; port++) {
    const free = await new Promise((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port between ${from} and ${from + 39}`);
}

/**
 * Opened from the Dock or Finder, a macOS app gets launchd's bare environment: none of the PATH entries, proxy settings
 * or tokens the person's shell profile sets up, so `claude` (in ~/.local/bin) would not be found. Ask the login shell
 * for its environment, as VS Code does. Profiles can be slow or stall (one that reads a folder macOS guards waits for
 * the person to allow it), so give up after a few seconds: kill the shell's whole process group (an interactive shell
 * ignores SIGTERM) and fall back to the usual install folders. Windows apps get the person's full environment already.
 */
function loginShellEnv() {
  if (process.platform === "win32" || process.env.SHELLSIDE_NO_SHELL_ENV) return Promise.resolve({});
  let sh = process.env.SHELL;
  try {
    sh ||= userInfo().shell;
  } catch {}
  sh ||= "/bin/zsh";
  const mark = "_SHELLSIDE_ENV_";
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (env, why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (why) console.error(`[shellside] using a basic environment: the login shell ${why}`);
      resolve(env);
    };
    const child = spawn(sh, ["-ilc", `printf '${mark}'; command env -0; printf '${mark}'`], {
      cwd: homedir(),
      detached: true, // its own process group, so a stuck profile can be killed with everything it started
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, SHELLSIDE_RESOLVING_ENVIRONMENT: "1" },
    });
    child.stdout.setEncoding("utf8");
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      finish(fallbackEnv(), "took longer than 6 s");
    }, 6000);
    child.stdout.on("data", (d) => {
      out += d;
      const body = out.split(mark);
      if (body.length < 3) return;
      const env = {};
      for (const line of body[1].split("\0")) {
        const i = line.indexOf("=");
        if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
      }
      for (const k of ["_", "SHLVL", "PWD", "OLDPWD", "TERM", "SHELLSIDE_RESOLVING_ENVIRONMENT"]) delete env[k];
      finish(env);
      // Whatever the profile left running in the background is not ours to keep.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    });
    child.on("error", (err) => finish(fallbackEnv(), `could not start (${err.message})`));
    child.on("close", (code) => finish(fallbackEnv(), `exited (${code}) without printing its environment`));
  });
}

/** PATH with the folders Claude Code, Homebrew and npm usually install into. */
function fallbackEnv() {
  const have = (process.env.PATH ?? "").split(":");
  const extra = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter((d) => !have.includes(d));
  return { PATH: [...extra, ...have].filter(Boolean).join(":") };
}

let server = null; // the utility process
let serverUrl = "";
let win = null;
let quitting = false;
const replies = new Map(); // message type → resolve, for questions to the server

function ask(type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      replies.delete(type);
      reject(new Error(`the server did not answer "${type}"`));
    }, timeoutMs);
    replies.set(type, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    server.postMessage({ type });
  });
}

async function startServer(port, logFile) {
  const log = createWriteStream(logFile, { flags: "w" });
  const env = {
    ...process.env,
    ...(await loginShellEnv()),
    NODE_ENV: "production",
    WB_PORT: String(port),
    WB_DATA_DIR: process.env.WB_DATA_DIR || join(app.getPath("userData"), "data"),
    // Board folders, where Claude works: in the home folder, easy to find (and outside ~/Documents, which macOS guards).
    WB_WORKSPACES: process.env.WB_WORKSPACES || join(homedir(), "Shellside"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  server = utilityProcess.fork(join(APP_DIR, "server", "index.mjs"), [], { env, stdio: "pipe", serviceName: "Shellside server" });
  server.stdout.on("data", (d) => log.write(d));
  server.stderr.on("data", (d) => log.write(d));
  return new Promise((resolve, reject) => {
    server.on("message", (msg) => {
      if (msg?.type === "ready") resolve(msg.url);
      else if (msg?.type === "error") reject(new Error(msg.message));
      else if (msg?.type === "pairing-code") showPairingCode(msg.code);
      else replies.get(msg?.type)?.(msg);
    });
    server.on("exit", (code) => {
      server = null;
      reject(new Error(`the server stopped (exit code ${code})`));
      if (!quitting) {
        if (!SMOKE)
          dialog.showErrorBox(
            T("Shellside stopped", "Shellside가 멈췄습니다"),
            T(`The board server stopped unexpectedly (exit code ${code}). Details: ${logFile}`, `보드 서버가 예기치 않게 멈췄습니다(종료 코드 ${code}). 자세한 내용: ${logFile}`),
          );
        app.quit();
      }
    });
  });
}

/** The app's window is the person's browser: the server gives it a session directly, so it never needs a code. */
async function pairWindow() {
  const s = await ask("app-session");
  await session.defaultSession.cookies.set({
    url: serverUrl,
    name: s.name,
    value: s.value,
    httpOnly: true,
    sameSite: "strict",
    expirationDate: Math.floor(Date.now() / 1000) + s.maxAge,
  });
}

function showPairingCode(code) {
  const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
  void dialog.showMessageBox(win ?? undefined, {
    type: "info",
    title: T("Pairing code", "연결 코드"),
    message: T(`Pairing code for a new browser: ${pretty}`, `새 브라우저 연결 코드: ${pretty}`),
    detail: T(
      "Type it in the browser that asked to connect. It works once, for 10 minutes. If you didn't ask, ignore it.",
      "연결하려는 브라우저 화면에 입력하세요. 10분 동안 한 번 쓸 수 있습니다. 요청한 적이 없다면 무시하세요.",
    ),
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    title: "Shellside",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151515" : "#ffffff",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, preload: join(APP_DIR, "preload.cjs") },
  });
  win.once("ready-to-show", () => !SMOKE && win.show());
  win.on("closed", () => (win = null));
  // Windows and Linux: closing the window quits the app. Ask while the window is still there, so the question shows on
  // top of it (asked after it closed, it could open behind other windows and leave the app running unseen).
  win.on("close", (e) => {
    if (process.platform === "darwin" || quitting || SMOKE) return;
    e.preventDefault();
    void requestQuit();
  });
  // Only the board opens in this window; links elsewhere go to the default browser.
  const external = (url) => /^https?:\/\//i.test(url) && void shell.openExternal(url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin === new URL(serverUrl).origin) return;
    e.preventDefault();
    external(url);
  });
  void win.loadURL(`${serverUrl}/`);
  return win;
}

/** Menu commands the board handles when it has the keys (window.__wb…() says true), else the page's own. */
function boardFirst(hook, fallback) {
  const wc = win?.webContents;
  if (!wc) return;
  void wc
    .executeJavaScript(`window.${hook} ? window.${hook}() : false`)
    .then((done) => done || fallback(wc))
    .catch(() => fallback(wc));
}

function buildMenu() {
  const mac = process.platform === "darwin";
  const folder = (p) => () => void shell.openPath(p);
  const updates = [
    { label: T("Check for Updates…", "업데이트 확인…"), click: () => void checkForUpdates({ manual: true, parent: win ?? undefined, T }) },
    { label: T("Check for Updates Automatically", "업데이트 자동 확인"), type: "checkbox", checked: updateSettings().auto, click: (item) => setAutoCheck(item.checked) },
  ];
  const template = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              ...updates,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: T("File", "파일"),
      submenu: [
        { label: T("Open in Browser", "브라우저에서 열기"), click: () => void shell.openExternal(serverUrl) },
        { type: "separator" },
        { label: T("Show Board Folders", "보드 폴더 보기"), click: folder(process.env.WB_WORKSPACES || join(homedir(), "Shellside")) },
        { label: T("Show Logs", "로그 보기"), click: folder(app.getPath("logs")) },
        ...(mac ? [] : [{ type: "separator" }, { role: "quit" }]),
      ],
    },
    {
      label: T("Edit", "편집"),
      submenu: [
        // On the board (not in a text field) these undo the board's steps; elsewhere the text's, as usual.
        { label: T("Undo", "실행 취소"), accelerator: "CmdOrCtrl+Z", click: () => boardFirst("__wbUndo", (wc) => wc.undo()) },
        { label: T("Redo", "다시 실행"), accelerator: mac ? "Shift+Cmd+Z" : "Ctrl+Y", click: () => boardFirst("__wbRedo", (wc) => wc.redo()) },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(mac ? [{ role: "pasteAndMatchStyle" }] : []),
        // On the board (not in a text field) it selects every frame; elsewhere all text, as usual.
        { label: T("Select All", "모두 선택"), accelerator: "CmdOrCtrl+A", click: () => boardFirst("__wbSelectAll", (wc) => wc.selectAll()) },
      ],
    },
    // Without the window zoom shortcuts: ⌘/Ctrl + = − 0 zoom the board, as in Figma.
    {
      label: T("View", "보기"),
      submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        ...(mac ? [] : [...updates, { type: "separator" }]),
        { label: T("Shellside on GitHub", "GitHub의 Shellside"), click: () => void shell.openExternal("https://github.com/NAMYUNWOO/Shellside") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Quitting stops every board terminal, and Claude in them: ask first when Claude is running somewhere. */
async function confirmQuit() {
  if (SMOKE || !server) return true;
  let running = 0;
  try {
    running = (await ask("status", 1500)).claudeRunning ?? 0;
  } catch {}
  if (!running) return true;
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: "warning",
    buttons: [T("Quit", "종료"), T("Cancel", "취소")],
    defaultId: 1,
    cancelId: 1,
    message: T(`Claude is running on ${running === 1 ? "a board" : `${running} boards`}.`, `Claude가 보드 ${running}개에서 실행 중입니다.`),
    detail: T("Quitting Shellside stops it and closes every board's terminal.", "Shellside를 종료하면 Claude가 멈추고 모든 보드의 터미널이 닫힙니다."),
  });
  return response === 0;
}

/** Ask first (when Claude runs somewhere), then stop the server and exit. The app never stays behind without a
 *  window: whatever happens, it is gone 8 s after quitting starts. */
let asking = false;
async function requestQuit() {
  if (quitting || asking) return;
  asking = true;
  const ok = await confirmQuit().finally(() => (asking = false));
  if (!ok) return;
  quitting = true;
  setTimeout(() => app.exit(0), 8000).unref?.();
  const s = server;
  if (!s) return app.exit(0);
  // The server stops its terminals and its browser itself; kill it if it takes too long.
  const timer = setTimeout(() => s.kill(), 4000);
  s.once("exit", () => {
    clearTimeout(timer);
    app.exit(0);
  });
  s.postMessage({ type: "quit" });
}

app.on("before-quit", (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  void requestQuit();
});

// The window's bridge (preload.cjs): open a board file with its own app, or show it in its folder. Only files inside the
// board folders, asked by the board's own page.
const boardFolders = () => resolve(process.env.WB_WORKSPACES || join(homedir(), "Shellside"));
function boardFile(e, path) {
  if (!serverUrl || new URL(e.senderFrame?.url ?? "about:blank").origin !== new URL(serverUrl).origin) return null;
  const abs = resolve(String(path));
  const rel = relative(boardFolders(), abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? abs : null;
}
ipcMain.handle("shellside:open-path", (e, path) => {
  const abs = boardFile(e, path);
  return abs ? shell.openPath(abs) : T("Only files in the board folders open from here.", "보드 폴더 안의 파일만 여기서 열 수 있습니다.");
});
ipcMain.handle("shellside:show-in-folder", (e, path) => {
  const abs = boardFile(e, path);
  if (abs) shell.showItemInFolder(abs);
});

/** CI: the board loads, a terminal starts the shell, `wb` runs in it with the app's runtime. */
async function smoke(file) {
  const SMOKE_FILE = join(app.getPath("temp"), "shellside-smoke.csv");
  const result = { platform: process.platform, url: serverUrl };
  writeFileSync(SMOKE_FILE, "name,score\nkim,3\n");
  try {
    await new Promise((resolve, reject) => {
      win.webContents.once("did-finish-load", resolve);
      win.webContents.once("did-fail-load", (_e, code, desc) => reject(new Error(`page did not load: ${desc} (${code})`)));
    });
    Object.assign(
      result,
      await win.webContents.executeJavaScript(`(async () => {
        const out = { title: document.title };
        out.health = await (await fetch("/api/health")).json();
        out.bridge = typeof window.shellside?.pathForFile === "function";
        const dropped = await fetch("/api/b/main/file-tools/from-path", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: ${JSON.stringify(SMOKE_FILE)} }) });
        out.file = dropped.ok ? (await dropped.json()).props : { error: (await dropped.json()).error };
        out.claude = await (await fetch("/api/agent/auth")).json();
        const ws = new WebSocket("ws://" + location.host + "/ws/pty?board=main");
        ws.binaryType = "arraybuffer";
        let text = "";
        ws.onmessage = (e) => { if (typeof e.data !== "string") text += new TextDecoder().decode(e.data); };
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("terminal socket failed")); });
        ws.send(JSON.stringify({ t: "init", cols: 160, rows: 40 }));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const status = async () => (await (await fetch("/api/b/main/agent/status")).json()).terminal;
        for (let i = 0; i < 60 && !/^(powershell|pwsh|bash|zsh|sh)$/.test((await status()).foreground); i++) await wait(500);
        out.shell = (await status()).foreground;
        const win = navigator.userAgent.includes("Windows");
        ws.send(JSON.stringify({ t: "in", d: (win ? "Write-Output ('smo' + 'ke-' + 'ok')" : "echo smo''ke-ok") + "\\r" }));
        ws.send(JSON.stringify({ t: "in", d: "wb help\\r" }));
        for (let i = 0; i < 40 && !/WorkBoard from the terminal/.test(text); i++) await wait(500);
        out.echo = /(^|\\n)smoke-ok/.test(text.replace(/\\x1b\\[[0-9;?]*[a-zA-Z]/g, ""));
        out.wb = /WorkBoard from the terminal/.test(text);
        out.afterWb = (await status()).foreground;
        out.tail = text.slice(-1500);
        ws.close();
        return out;
      })()`),
    );
    result.ok = result.health?.ok === true && !!result.shell && result.echo && result.wb && result.bridge && /^\/|^[A-Za-z]:/.test(result.file?.path ?? "");
    // With SHELLSIDE_UPDATE_URL (a test server), also: the update check reads the latest version.
    if (process.env.SHELLSIDE_UPDATE_URL) result.update = await latestRelease().catch((err) => ({ error: String(err?.message ?? err) }));
  } catch (err) {
    result.ok = false;
    result.error = String(err?.stack ?? err);
  }
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.exit(result.ok ? 0 : 1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) createWindow();
    else {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on("window-all-closed", () => {
    // macOS apps stay in the Dock with their window closed; the boards (and Claude) keep running.
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => serverUrl && !win && createWindow());
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done) =>
      done(["clipboard-read", "clipboard-sanitized-write", "fullscreen", "notifications"].includes(permission)),
    );
    mkdirSync(app.getPath("logs"), { recursive: true });
    const logFile = join(app.getPath("logs"), "server.log");
    try {
      serverUrl = await startServer(await freePort(), logFile);
      await pairWindow();
    } catch (err) {
      if (SMOKE) {
        writeFileSync(SMOKE, JSON.stringify({ ok: false, error: String(err?.message ?? err), log: logFile }));
        return app.exit(1);
      }
      dialog.showErrorBox(T("Shellside could not start", "Shellside를 시작할 수 없습니다"), `${err.message}\n\n${T("Details", "자세한 내용")}: ${logFile}`);
      quitting = true;
      server?.kill();
      return app.quit();
    }
    buildMenu();
    createWindow();
    if (SMOKE) void smoke(SMOKE);
    else setTimeout(() => void checkForUpdates({ parent: win ?? undefined, T }), 8000);
  });
}
