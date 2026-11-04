// Code editors on the board (kind "code"): list a folder, read and save files, all under the editor's root and never
// outside it (no "..", no symlink out). The person edits there; the agent edits the same files with its own tools.
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BoardError } from "./board.ts";

/** Biggest file the editor opens (a log or a data dump is no code). */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 3000;
/** Never worth listing. */
const SKIP = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** What a code tool records about its root, read from the disk. */
export async function describeRoot(path: string) {
  const root = resolve(String(path ?? ""));
  let st;
  try {
    st = await stat(root);
  } catch {
    throw new BoardError(`nothing at ${root}`, 404);
  }
  if (!st.isDirectory() && !st.isFile()) throw new BoardError(`${root} is neither a folder nor a file`, 400);
  return { root, single: st.isFile() };
}

const within = (root: string, abs: string) => {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The absolute path of `rel` under the root, refused if it leads outside it (also through a symlink). */
async function under(root: string, single: boolean, rel: string) {
  if (single) {
    if (rel && rel !== ".") throw new BoardError("this editor has one file", 400);
    return root;
  }
  const abs = resolve(root, String(rel ?? "").replace(/^[\\/]+/, ""));
  if (!within(root, abs)) throw new BoardError("that path is outside this editor's folder", 403);
  // The deepest part that exists must also resolve inside the root (a symlink can point anywhere).
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!within(await realpath(root), real)) throw new BoardError("that path leads outside this editor's folder", 403);
      break;
    } catch (err) {
      if (err instanceof BoardError) throw err;
      const up = dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  }
  return abs;
}

/** One level of a folder: folders first, then files, by name. */
export async function listDir(root: string, single: boolean, rel: string) {
  if (single) return { entries: [], truncated: false };
  const dir = await under(root, single, rel);
  const names = (await readdir(dir).catch(() => {
    throw new BoardError("can't read that folder", 404);
  })).filter((n) => !SKIP.has(n));
  const entries: { name: string; dir: boolean; size: number }[] = [];
  for (const name of names.slice(0, MAX_ENTRIES)) {
    try {
      const st = await lstat(join(dir, name));
      const isDir = st.isDirectory() || (st.isSymbolicLink() && (await stat(join(dir, name)).catch(() => null))?.isDirectory() === true);
      entries.push({ name, dir: isDir, size: isDir ? 0 : st.size });
    } catch {}
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { entries, truncated: names.length > MAX_ENTRIES };
}

export async function statFile(root: string, single: boolean, rel: string) {
  const abs = await under(root, single, rel);
  const st = await stat(abs).catch(() => null);
  return st ? { exists: true, mtime: st.mtimeMs, size: st.size } : { exists: false, mtime: 0, size: 0 };
}

/** A text file for the editor: refused when too big or not text. */
export async function readText(root: string, single: boolean, rel: string) {
  const abs = await under(root, single, rel);
  const st = await stat(abs).catch(() => {
    throw new BoardError("no such file", 404);
  });
  if (st.isDirectory()) throw new BoardError("that is a folder", 400);
  if (st.size > MAX_EDIT_BYTES) throw new BoardError(`the file is ${Math.round(st.size / 1e6)} MB; the editor opens files up to ${MAX_EDIT_BYTES / 1024 / 1024} MB`, 413);
  const buf = await readFile(abs);
  if (buf.subarray(0, 8192).includes(0)) throw new BoardError("not a text file", 415);
  return { text: buf.toString("utf8"), mtime: st.mtimeMs, size: st.size };
}

/** Save. baseMtime: when the person's copy was read; a file changed on disk since (by Claude, say) is not overwritten. */
export async function writeText(root: string, single: boolean, rel: string, text: string, baseMtime?: number, force = false) {
  const abs = await under(root, single, rel);
  if (typeof text !== "string") throw new BoardError("text must be a string", 400);
  const now = await stat(abs).catch(() => null);
  if (now?.isDirectory()) throw new BoardError("that is a folder", 400);
  if (now && !force && typeof baseMtime === "number" && Math.abs(now.mtimeMs - baseMtime) > 1)
    throw new BoardError("the file changed on disk since you opened it", 409, { reason: "changed", mtime: now.mtimeMs });
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text);
  return { mtime: (await stat(abs)).mtimeMs };
}

/** A new empty file or folder in the editor's folder. */
export async function createEntry(root: string, single: boolean, rel: string, dir: boolean) {
  if (single) throw new BoardError("this editor has one file", 400);
  const clean = String(rel ?? "").trim();
  if (!clean || /(^|[\\/])\.\.([\\/]|$)/.test(clean)) throw new BoardError("give a name inside this folder", 400);
  const abs = await under(root, single, clean);
  if (await stat(abs).catch(() => null)) throw new BoardError(`${clean} is there already`, 409);
  if (dir) await mkdir(abs, { recursive: true });
  else {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, "");
  }
  return { path: relative(root, abs).split(sep).join("/") };
}
