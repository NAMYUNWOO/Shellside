// Keyboard shortcuts the way each system writes them: "mod" is ⌘ on macOS and Ctrl on Windows and Linux.
// Letter shortcuts match the physical key (e.code), so they work with a Korean (or any) input method on.

// userAgentData says "macOS", navigator.platform "MacIntel": match either way.
export const IS_MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent);

/** ⌘/Ctrl held: the "mod" of every shortcut. */
export const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => (IS_MAC ? e.metaKey : e.ctrlKey);

const MAC: Record<string, string> = { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↵", backspace: "⌫", delete: "⌫", escape: "Esc", space: "Space", up: "↑", down: "↓", left: "←", right: "→", plus: "+", minus: "−" };
const PC: Record<string, string> = { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl", enter: "Enter", backspace: "Backspace", delete: "Delete", escape: "Esc", space: "Space", up: "↑", down: "↓", left: "←", right: "→", plus: "+", minus: "-" };

/** "mod+shift+d" → "⇧⌘D" on macOS, "Ctrl+Shift+D" elsewhere. */
export function kbd(spec: string) {
  const parts = spec.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const names = IS_MAC ? MAC : PC;
  const label = (p: string) => names[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1));
  if (!IS_MAC) return parts.map(label).join("+");
  // macOS order: ⌃⌥⇧⌘ then the key.
  const order = ["ctrl", "alt", "shift", "mod"];
  const mods = order.filter((m) => parts.includes(m)).map(label).join("");
  return mods + parts.filter((p) => !order.includes(p)).map(label).join("");
}
