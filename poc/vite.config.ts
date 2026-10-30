import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = `http://127.0.0.1:${process.env.WB_PORT ?? 4100}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
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
