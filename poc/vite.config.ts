import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Monaco bundles code from other projects (DOMPurify, marked…): their notices go into the notices file too. */
const monacoNotices = (): Plugin => ({
  name: "monaco-notices",
  apply: "build",
  writeBundle(options) {
    const file = join(options.dir ?? "dist", "third-party-licenses.md");
    const notices = join("node_modules", "monaco-editor", "ThirdPartyNotices.txt");
    if (!existsSync(file) || !existsSync(notices)) return;
    appendFileSync(file, `\n\n## Code inside monaco-editor\n\nMonaco includes code from other projects. Their notices, from its ThirdPartyNotices.txt:\n\n\`\`\`\n${readFileSync(notices, "utf8").trim()}\n\`\`\`\n`);
  },
});

const target = `http://127.0.0.1:${process.env.WB_PORT ?? 4100}`;

export default defineConfig({
  plugins: [react(), monacoNotices()],
  resolve: {
    // Monaco carries its own copy of DOMPurify, older than the fixed one: use the package (package.json pins it).
    alias: [{ find: /^\.\/dompurify\/dompurify\.js$/, replacement: "dompurify" }],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Runtime folders: the board browser's profile (Chrome, and extensions an organization's policy installs, write
    // .html files there) and the agent's workspaces. A change there must not reload the board.
    watch: { ignored: ["**/data/**", "**/workspaces/**", "**/workspace/**", "**/desktop/**"] },
    // No other site may frame the board (it could trick a click into an approval or the terminal).
    headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" },
    proxy: {
      "/api": { target },
      "/ws": { target, ws: true },
      "/sandbox": { target },
      "/third-party-licenses.md": { target },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Every package bundled into the board UI, with its license text (MIT, ISC, BSD and Apache-2.0 ask for it).
    // The server serves it at /third-party-licenses.md; the boards panel links to it.
    license: { fileName: "third-party-licenses.md" },
  },
});
