// The board window's bridge to the desktop app (a sandboxed preload): where a dropped file is on this machine, so the
// app copies it there instead of sending it through the page; opening a board file with its own app; and the system's
// open dialog, to pick a folder or file for a code editor. The main
// process only opens files inside the board folders (main.mjs).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("shellside", {
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  openPath: (path) => ipcRenderer.invoke("shellside:open-path", String(path)),
  showInFolder: (path) => ipcRenderer.invoke("shellside:show-in-folder", String(path)),
  // The system's open dialog, for picking what a code editor opens. Gives the chosen path, or "" when cancelled.
  pickPath: (opts) => ipcRenderer.invoke("shellside:pick-path", { files: !!opts?.files }),
});
