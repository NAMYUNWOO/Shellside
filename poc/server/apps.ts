// App tools: agent-written React code. Compile on the server so the agent gets errors at once.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "sucrase";
import { BoardError } from "./board.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_SRC = join(ROOT, "sandbox", "runtime.tsx");
export const RUNTIME_OUT = join(ROOT, "sandbox", "dist", "runtime.js");
const MONACO_SRC = join(ROOT, "sandbox", "monaco.ts");
export const MONACO_OUT = join(ROOT, "sandbox", "dist", "monaco.js");

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

/** Bundle the sandbox runtime (React + board bridge) when missing or older than its source. The desktop app ships it
 *  built and without its source, so there it is always fresh (and esbuild, loaded only to build, is not needed). */
export function ensureRuntime() {
  const fresh = existsSync(RUNTIME_OUT) && (!existsSync(RUNTIME_SRC) || statSync(RUNTIME_OUT).mtimeMs >= statSync(RUNTIME_SRC).mtimeMs);
  if (fresh) return;
  const { buildSync } = createRequire(import.meta.url)("esbuild") as typeof import("esbuild");
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

let monacoBuild: Promise<void> | null = null;
/** Bundle Monaco for apps (sandbox/dist/monaco.js, which an app's CodeEditor loads) when missing or older than its
 *  source, the monaco-editor package or this file: one script, with its CSS and icon font inside (an app's sandbox loads no
 *  stylesheets or font files). The desktop app ships it built. */
export function ensureMonaco(): Promise<void> {
  return (monacoBuild ??= buildMonaco().catch((err) => {
    monacoBuild = null;
    throw err;
  }));
}
async function buildMonaco() {
  const req = createRequire(import.meta.url);
  if (!existsSync(MONACO_SRC)) return; // the desktop app: built already
  const main = req.resolve("monaco-editor/editor/editor.main.js");
  const pkg = resolve(dirname(main), "..", "..", "..", "package.json"); // esm/vs/editor/ → the package (its exports hide package.json)
  const out = existsSync(MONACO_OUT) ? statSync(MONACO_OUT).mtimeMs : 0;
  if ([MONACO_SRC, pkg, fileURLToPath(import.meta.url)].every((f) => statSync(f).mtimeMs <= out)) return; // and this build
  const { build } = req("esbuild") as typeof import("esbuild");
  // Monaco's own list of editor features, less the language services that need web workers (and the LSP client).
  const features = readFileSync(main, "utf8")
    .split("\n")
    .filter((line) => !/languages\/features\/|__src_languages_features_|monaco-lsp-client|\bas lsp\b/.test(line))
    .join("\n");
  const result = await build({
    stdin: { contents: `${features}\nimport ${JSON.stringify(MONACO_SRC.split(sep).join("/"))};\n`, resolveDir: dirname(main), sourcefile: "monaco-for-apps.js", loader: "js" },
    bundle: true,
    format: "iife",
    minify: true,
    target: "es2022",
    write: false,
    outdir: join(dirname(MONACO_OUT), ".monaco"),
    loader: { ".ttf": "dataurl" },
    plugins: [
      {
        // Monaco carries its own copy of DOMPurify, older than the fixed one: use the package (package.json pins it).
        name: "dompurify",
        setup(b) {
          b.onResolve({ filter: /^\.\/dompurify\/dompurify\.js$/ }, (args) => b.resolve("dompurify", { kind: "import-statement", resolveDir: args.resolveDir }));
        },
      },
    ],
    logOverride: { "empty-import-meta": "silent" }, // worker URLs: apps have no workers (Monaco falls back to the page)
    logLevel: "error",
  });
  const js = result.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  const style = `(()=>{const s=document.createElement("style");s.textContent=${JSON.stringify(css)};document.head.appendChild(s)})();\n`;
  mkdirSync(dirname(MONACO_OUT), { recursive: true });
  writeFileSync(`${MONACO_OUT}.partial`, style + js);
  renameSync(`${MONACO_OUT}.partial`, MONACO_OUT);
  console.log(`[workboard] built Monaco for apps → ${relative(ROOT, MONACO_OUT)} (${(statSync(MONACO_OUT).size / 1e6).toFixed(1)} MB)`);
}
