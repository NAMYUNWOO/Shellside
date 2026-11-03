// Stages the Shellside desktop app in desktop/stage for electron-builder (electron-builder.config.cjs): the board UI, the app
// sandbox runtime, the server bundled into one file with its open source notices, the wb CLI, and node-pty (native,
// so it ships as its package, with the prebuilt binaries for this platform only). Run on the platform you build for.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const DESKTOP = dirname(fileURLToPath(import.meta.url));
const POC = join(DESKTOP, "..");
const STAGE = join(DESKTOP, "stage");
const desktopPkg = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
const run = (cmd, cwd = POC) => execSync(cmd, { cwd, stdio: "inherit" });

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// The board UI, with its third-party notices (dist/third-party-licenses.md).
run("npm run build");
cpSync(join(POC, "dist"), join(STAGE, "dist"), { recursive: true });

// The sandbox runtime app iframes load. A checkout builds it on first start; the app ships it built.
run(`npx tsx --eval "import('./server/apps.ts').then((m) => m.ensureRuntime())"`);
cpSync(join(POC, "sandbox", "dist", "runtime.js"), join(STAGE, "sandbox", "dist", "runtime.js"));

// The server, as one ES module. node-pty is native and stays a package; esbuild is only needed to rebuild the
// runtime, which the app never does. CommonJS dependencies (ws) need `require`, which ES modules lack.
const result = await build({
  absWorkingDir: POC, // the metafile's paths are relative to it (serverNotices)
  entryPoints: [join(POC, "server", "index.ts")],
  outfile: join(STAGE, "server", "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node-pty", "esbuild", "bufferutil", "utf-8-validate"],
  banner: { js: 'import { createRequire as __wbCreateRequire } from "node:module"; const require = __wbCreateRequire(import.meta.url);' },
  metafile: true,
  legalComments: "none",
  logLevel: "warning",
});
cpSync(join(POC, "server", "browser-inpage.js"), join(STAGE, "server", "browser-inpage.js"));
writeFileSync(join(STAGE, "server", "third-party-licenses.md"), serverNotices(result.metafile));

// The wb CLI (board terminals put bin/ on PATH).
for (const f of ["wb", "wb.cmd", "wb.mjs"]) cpSync(join(POC, "bin", f), join(STAGE, "bin", f));

// node-pty: its JavaScript and this platform's prebuilt binaries (no debug symbols, no sources).
const ptySrc = join(POC, "node_modules", "node-pty");
const ptyDst = join(STAGE, "node_modules", "node-pty");
const ptyPkg = JSON.parse(readFileSync(join(ptySrc, "package.json"), "utf8"));
for (const f of ["lib", "LICENSE"]) cpSync(join(ptySrc, f), join(ptyDst, f), { recursive: true });
for (const dir of readdirSync(join(ptySrc, "prebuilds")).filter((d) => d.startsWith(`${process.platform}-`)))
  cpSync(join(ptySrc, "prebuilds", dir), join(ptyDst, "prebuilds", dir), { recursive: true, filter: (src) => !src.endsWith(".pdb") });
// Its only dependency (node-addon-api) is for compiling, which the prebuilt binaries make unnecessary.
writeFileSync(join(ptyDst, "package.json"), JSON.stringify({ name: ptyPkg.name, version: ptyPkg.version, license: ptyPkg.license, main: ptyPkg.main }, null, 2) + "\n");

// The app itself.
for (const f of ["main.mjs", "updates.mjs"]) cpSync(join(DESKTOP, f), join(STAGE, f));
cpSync(join(POC, "..", "LICENSE"), join(STAGE, "LICENSE"));
writeFileSync(
  join(STAGE, "package.json"),
  JSON.stringify(
    {
      name: "shellside",
      productName: "Shellside",
      version: desktopPkg.version,
      description: desktopPkg.description,
      author: desktopPkg.author,
      license: "MIT",
      type: "module",
      main: "main.mjs",
      dependencies: { "node-pty": ptyPkg.version },
    },
    null,
    2,
  ) + "\n",
);
console.log(`[desktop] staged ${relative(POC, STAGE)} (${Math.round(size(STAGE) / 1e6)} MB)`);

/** The licenses of every package bundled into the server, like dist/third-party-licenses.md for the UI. */
function serverNotices(metafile) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const m = /^(?:.*\/)?node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (m) roots.add(input.slice(0, m.index + m[0].length - 1));
  }
  const parts = ["# Third-party software in the Shellside server\n", "The server (server/index.mjs) bundles these packages.\n"];
  for (const root of [...roots].sort()) {
    const dir = join(POC, root);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    parts.push(`## ${pkg.name} ${pkg.version}\n\nLicense: ${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license)}\n`);
    if (file) parts.push("```\n" + readFileSync(join(dir, file), "utf8").trim() + "\n```\n");
  }
  return parts.join("\n");
}

function size(p) {
  const st = statSync(p);
  return st.isDirectory() ? readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0) : st.size;
}
