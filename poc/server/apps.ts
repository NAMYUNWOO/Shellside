// App tools: agent-written React code. Compile on the server so the agent gets errors at once.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { transform } from "sucrase";
import { BoardError } from "./board.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_SRC = join(ROOT, "sandbox", "runtime.tsx");
export const RUNTIME_OUT = join(ROOT, "sandbox", "dist", "runtime.js");

const ALLOWED_IMPORTS = new Set(["react", "react/jsx-runtime", "react-dom", "react-dom/client", "board"]);

/** Compile JSX/TSX to a CommonJS factory body the sandbox runtime can run. */
export function compileApp(source: string): string {
  if (/\bimport\s*\(/.test(source)) throw new BoardError("dynamic import() is not available in WorkBoard apps");
  const imports = [...source.matchAll(/(?:^|[\s;])(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] ?? m[2],
  );
  const bad = [...new Set(imports.filter((s) => !ALLOWED_IMPORTS.has(s)))];
  if (bad.length) {
    throw new BoardError(`import not available: ${bad.join(", ")}. WorkBoard apps can import only: react, react-dom, board. Write the logic yourself (no network, no npm packages).`);
  }
  if (!/\bexport\s+default\b/.test(source)) throw new BoardError("the app must `export default` a React component, e.g. export default function App() { ... }");
  try {
    return transform(source, { transforms: ["jsx", "typescript", "imports"], jsxRuntime: "automatic", production: true, filePath: "App.tsx" }).code;
  } catch (err) {
    throw new BoardError(`syntax error in app source: ${(err as Error).message}`);
  }
}

/** Resolve the app source: inline text, or a file inside the workspace (so the agent can edit it with its own tools). */
export function loadSource(workspace: string, input: { source?: string; sourcePath?: string }): { source: string; sourcePath?: string } {
  if (input.sourcePath) {
    // Relative paths are in the board's workspace; absolute paths may be anywhere (Claude can work in another folder).
    const abs = isAbsolute(input.sourcePath) ? resolve(input.sourcePath) : resolve(workspace, input.sourcePath);
    if (!/\.(jsx|tsx|js|ts)$/i.test(abs)) throw new BoardError("sourcePath must be a .jsx, .tsx, .js or .ts file");
    if (!existsSync(abs)) throw new BoardError(`sourcePath not found: ${abs}`, 404);
    if (statSync(abs).size > 300_000) throw new BoardError("app source is larger than 300 KB");
    const rel = relative(workspace, abs);
    return { source: readFileSync(abs, "utf8"), sourcePath: rel.startsWith("..") || isAbsolute(rel) ? abs : rel };
  }
  if (input.source?.trim()) return { source: input.source };
  throw new BoardError("give the app code as source, or sourcePath to a .jsx/.tsx file in the workspace");
}

/** Bundle the sandbox runtime (React + board bridge) when missing or older than its source. */
export function ensureRuntime() {
  const fresh = existsSync(RUNTIME_OUT) && statSync(RUNTIME_OUT).mtimeMs >= statSync(RUNTIME_SRC).mtimeMs;
  if (fresh) return;
  mkdirSync(dirname(RUNTIME_OUT), { recursive: true });
  buildSync({
    entryPoints: [RUNTIME_SRC],
    outfile: RUNTIME_OUT,
    bundle: true,
    format: "iife",
    minify: true,
    jsx: "automatic",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  console.log(`[workboard] built sandbox runtime → ${relative(ROOT, RUNTIME_OUT)}`);
}
