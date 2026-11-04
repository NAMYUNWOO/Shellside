// The code editors on screen, for the desktop app's Edit menu: its Undo, Redo and Select All take ⌘/Ctrl+Z, ⇧⌘Z/Ctrl+Y
// and ⌘/Ctrl+A before the page sees them, and the browser's own undo doesn't reach Monaco's history. So the menu asks
// the board first (BoardPanel's __wbUndo…), and the board hands the command to the editor that has the keys.
interface Editor {
  hasTextFocus(): boolean;
  trigger(source: string, handlerId: string, payload: unknown): void;
}
export const codeEditors = new Set<Editor>();

/** Runs undo, redo or selectAll in the code editor that has the keys; false when none has. */
export function codeCommand(command: "undo" | "redo" | "editor.action.selectAll") {
  for (const ed of codeEditors) {
    if (ed.hasTextFocus()) {
      ed.trigger("menu", command, null);
      return true;
    }
  }
  return false;
}
