// Tells the person when a newer Shellside is out (GitHub's latest release): at start, at most once a day and once per
// new version, and whenever they ask from the menu. Turned off with the menu's "Check for Updates Automatically" (or
// SHELLSIDE_NO_UPDATE_CHECK=1). The request carries nothing but the app's version in its User-Agent.
import { app, clipboard, dialog, net, shell } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = "NAMYUNWOO/Shellside";
// Where github.com sends "the latest release" (…/releases/tag/v<version>). Not api.github.com: that allows 60 requests
// an hour per address, and an office shares one.
const LATEST = process.env.SHELLSIDE_UPDATE_URL || `https://github.com/${REPO}/releases/latest`;
export const INSTALL_COMMAND = `irm https://raw.githubusercontent.com/${REPO}/main/poc/desktop/install.ps1 | iex`;
const DAY = 24 * 3600 * 1000;

const file = () => join(app.getPath("userData"), "updates.json");
export function updateSettings() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(file(), "utf8"));
  } catch {}
  return { auto: !process.env.SHELLSIDE_NO_UPDATE_CHECK, ...saved };
}
function save(patch) {
  try {
    writeFileSync(file(), JSON.stringify({ ...updateSettings(), ...patch }, null, 2) + "\n");
  } catch {}
}
export const setAutoCheck = (auto) => save({ auto });

const parts = (v) => String(v).replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
/** a is a later version than b ("0.2.0" > "0.1.9"). */
export function isNewer(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** Installed with install.ps1 (into %LOCALAPPDATA%\Shellside): updated by running that line again. */
export function installedByScript() {
  const local = process.env.LOCALAPPDATA;
  return process.platform === "win32" && !!local && dirname(process.execPath).toLowerCase() === join(local, "Shellside").toLowerCase();
}

/** Where a request is redirected (net.fetch follows redirects without telling where to). */
function redirectOf(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: "HEAD", redirect: "manual" });
    req.setHeader("user-agent", `Shellside/${app.getVersion()}`);
    req.on("redirect", (_status, _method, to) => {
      resolve(to);
      req.abort();
    });
    req.on("response", (res) => reject(new Error(`GitHub answered ${res.statusCode} without a redirect`)));
    req.on("error", reject);
    req.end();
  });
}

/** The latest release: its version, its page, and the file this kind of install updates from. */
export async function latestRelease() {
  const url = new URL(LATEST);
  url.searchParams.set("t", String(Date.now())); // not an edge cache's answer from before the newest release
  const page = await redirectOf(url.toString());
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(new URL(page).pathname)?.[1];
  if (!tag) throw new Error("no release is published yet");
  const version = decodeURIComponent(tag).replace(/^v/, "");
  const file = process.platform === "darwin" ? `Shellside-${version}-mac-${process.arch}.dmg` : `Shellside-Setup-${version}-x64.exe`;
  return { version, page, download: `https://github.com/${REPO}/releases/download/v${version}/${file}` };
}

/** manual: asked from the menu, so it always answers (also "up to date" and errors). */
export async function checkForUpdates({ manual = false, parent, T }) {
  const s = updateSettings();
  if (!manual && (!s.auto || Date.now() - (s.checkedAt ?? 0) < DAY)) return;
  let latest;
  try {
    latest = await latestRelease();
  } catch (err) {
    if (manual) void dialog.showMessageBox(parent, { type: "warning", message: T("Couldn't check for updates.", "업데이트를 확인하지 못했습니다."), detail: String(err?.message ?? err) });
    return;
  }
  save({ checkedAt: Date.now() });
  const current = app.getVersion();
  if (!isNewer(latest.version, current)) {
    if (manual) void dialog.showMessageBox(parent, { type: "info", message: T(`Shellside ${current} is up to date.`, `Shellside ${current}은(는) 최신 버전입니다.`) });
    return;
  }
  if (!manual && s.notified === latest.version) return; // said once; the menu still tells
  save({ notified: latest.version });
  const script = installedByScript();
  const buttons = script
    ? [T("Copy Command", "명령 복사"), T("Release Notes", "릴리스 노트"), T("Later", "나중에")]
    : [T("Download", "다운로드"), T("Release Notes", "릴리스 노트"), T("Later", "나중에")];
  const { response } = await dialog.showMessageBox(parent, {
    type: "info",
    buttons,
    defaultId: 0,
    cancelId: 2,
    message: T(`Shellside ${latest.version} is out (you have ${current}).`, `Shellside ${latest.version}이(가) 나왔습니다(지금 ${current}).`),
    detail: script
      ? T(`To update, quit Shellside and run this in PowerShell:\n\n${INSTALL_COMMAND}`, `업데이트하려면 Shellside를 종료하고 PowerShell에서 실행하세요:\n\n${INSTALL_COMMAND}`)
      : T("Download the new version and open it to replace this one. Your boards stay.", "새 버전을 내려받아 열면 지금 앱을 교체합니다. 보드는 그대로 남습니다."),
  });
  if (response === 0) {
    if (script) clipboard.writeText(INSTALL_COMMAND);
    else void shell.openExternal(latest.download ?? latest.page);
  } else if (response === 1) void shell.openExternal(latest.page);
}
