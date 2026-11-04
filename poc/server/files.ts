// Files on the board. The person drops a file on the canvas: the desktop app copies it from where it is (a clone on
// APFS, so even a huge file takes no time or space), a browser streams it here; either way it lands in the board's
// workspace (files/), where the agent reads it. The agent puts its own files on the board with file_add.
import { constants, createWriteStream, existsSync, mkdirSync, statfsSync } from "node:fs";
import { copyFile, rename, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { BoardError } from "./board.ts";

export const FILES_DIR = "files";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml", heic: "image/heic", avif: "image/avif",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", jsonl: "application/x-ndjson",
  html: "text/html", htm: "text/html", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml", log: "text/plain", ini: "text/plain", toml: "text/plain",
  js: "text/javascript", mjs: "text/javascript", ts: "text/plain", tsx: "text/plain", jsx: "text/plain", py: "text/x-python", go: "text/plain", rs: "text/plain", java: "text/plain",
  c: "text/plain", h: "text/plain", cpp: "text/plain", cs: "text/plain", rb: "text/plain", php: "text/plain", sh: "text/plain", sql: "text/plain", css: "text/css",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const mimeOf = (name: string) => MIME[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";

/** A file name that is safe on every system: no folders, no characters Windows refuses, not too long. */
export function safeFileName(name: string) {
  const base = String(name ?? "").normalize("NFC").split(/[\\/]/).pop() ?? "";
  let clean = base.replace(/[\u0000-\u001f<>:"|?*]+/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean)) clean = `_${clean}`;
  if (clean.length > 150) {
    const ext = extname(clean).slice(0, 20);
    clean = clean.slice(0, 150 - ext.length) + ext;
  }
  return clean || "file";
}

/** name, or "name (2).ext", "name (3).ext"… — the first that is free in dir. */
function freeName(dir: string, name: string) {
  if (!existsSync(join(dir, name))) return join(dir, name);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) if (!existsSync(join(dir, `${stem} (${n})${ext}`))) return join(dir, `${stem} (${n})${ext}`);
}

function filesDir(workspace: string) {
  const dir = join(workspace, FILES_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Refuse before writing when the disk can't hold it (a half-written file helps nobody). */
function checkSpace(dir: string, bytes: number) {
  let free: number | null = null;
  try {
    const s = statfsSync(dir);
    free = Number(s.bavail) * Number(s.bsize);
  } catch {}
  if (free !== null && bytes > free) throw new BoardError(`not enough disk space: the file is ${gb(bytes)}, ${gb(free)} is free`, 507);
}
const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.ceil(n / 1e6)} MB`);

/** What a file tool records about a file, read from the disk (never taken from a request). */
export async function describeFile(workspace: string, path: string) {
  const abs = resolve(String(path ?? ""));
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new BoardError(`no file at ${abs}`, 404);
  }
  if (st.isDirectory()) throw new BoardError(`${abs} is a folder; drop the files in it instead`, 400);
  if (!st.isFile()) throw new BoardError(`${abs} is not a regular file`, 400);
  const rel = relative(workspace, abs);
  const inside = !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  return { fileName: basename(abs), path: abs, ...(inside ? { relPath: rel.split("\\").join("/") } : {}), size: st.size, mime: mimeOf(abs) };
}

/** A browser's drop: the request body is the file, streamed to disk (never held in memory), then named. */
export async function receiveFile(req: IncomingMessage, workspace: string, name: string) {
  const dir = filesDir(workspace);
  const length = Number(req.headers["content-length"]);
  if (Number.isFinite(length)) checkSpace(dir, length);
  const part = join(dir, `.partial-${randomBytes(6).toString("hex")}`);
  try {
    await pipeline(req, createWriteStream(part));
    if (req.readableAborted || (Number.isFinite(length) && (await stat(part)).size !== length)) throw new BoardError("the upload stopped before the end", 400);
    const final = freeName(dir, safeFileName(name));
    await rename(part, final);
    return final;
  } catch (err) {
    await rm(part, { force: true }).catch(() => {});
    throw err;
  }
}

/** The desktop app's drop, and file_add: copy a file on this machine into the workspace. On APFS (macOS) the copy is
 *  a clone: instant, and it takes no extra space until one of them changes. */
export async function copyIntoWorkspace(workspace: string, src: string) {
  const from = await describeFile(workspace, src);
  const dir = filesDir(workspace);
  checkSpace(dir, from.size);
  const dest = freeName(dir, safeFileName(from.fileName));
  await copyFile(from.path, dest, constants.COPYFILE_FICLONE);
  return dest;
}

/** Headers for showing a file from this server: images, PDF, audio and video open in place; text shows as plain text;
 *  anything else (HTML, SVG, scripts…) downloads, so a dropped file can never run as part of the board. */
export function contentHeaders(fileName: string, mime: string) {
  const inline = /^(image\/(png|jpeg|gif|webp|bmp|x-icon|avif)|application\/pdf|audio\/|video\/)/.test(mime);
  const text = /^text\/|^application\/(json|x-ndjson|xml)$/.test(mime) && mime !== "text/html";
  const type = inline ? mime : text ? "text/plain; charset=utf-8" : "application/octet-stream";
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape);
  return {
    "content-type": type,
    "content-disposition": `${inline || text ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
    "x-content-type-options": "nosniff",
    // No scripts, no forms, its own origin: even if a browser rendered it, it could not touch the board.
    ...(mime === "application/pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'" }),
    "cache-control": "private, max-age=60",
  };
}
