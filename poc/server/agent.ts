// The agent in the terminal: is Claude logged in, is it running, and how to hand it a request.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Tool } from "../shared/catalog.ts";
import type { Board } from "./board.ts";

export interface ClaudeAuth {
  installed: boolean;
  loggedIn: boolean;
  method?: string;
}

/**
 * The environment for anything that runs Claude on a board: this process's env minus the variables a parent
 * Claude Code session leaves behind (CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_MESSAGING_SOCKET, …).
 * Inherited, they make the board's Claude act as a child of that session (wrong auth, wrong messaging socket).
 */
export function cleanEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT" || k.startsWith("CLAUDE_CODE_")) continue;
    out[k] = v;
  }
  return out;
}

/** The first folder on PATH that has this file, or null. */
export function onPath(file: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) if (dir && existsSync(join(dir, file))) return join(dir, file);
  return null;
}

let cache: { at: number; value: ClaudeAuth } | null = null;
let inflight: Promise<ClaudeAuth> | null = null;

/** `claude auth status` (cached 15 s). Uses the same login the terminal's Claude Code uses. */
export function claudeAuth(force = false): Promise<ClaudeAuth> {
  if (!force && cache && Date.now() - cache.at < 15_000) return Promise.resolve(cache.value);
  inflight ??= new Promise<ClaudeAuth>((resolve) => {
    // Windows: an npm install of Claude Code is claude.cmd, which only a shell can start (the native one is claude.exe).
    const viaShell = process.platform === "win32" && !onPath("claude.exe") && !!onPath("claude.cmd");
    execFile("claude", ["auth", "status"], { timeout: 10_000, env: cleanEnv(), shell: viaShell, windowsHide: true }, (err, stdout) => {
      let value: ClaudeAuth;
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") value = { installed: false, loggedIn: false };
      else {
        try {
          const j = JSON.parse(stdout);
          value = { installed: true, loggedIn: Boolean(j.loggedIn), method: j.authMethod };
        } catch {
          value = { installed: true, loggedIn: false };
        }
      }
      cache = { at: Date.now(), value };
      inflight = null;
      resolve(value);
    });
  });
  return inflight;
}

/** What Claude in a board's terminal is doing, from Claude Code hooks. */
export type AgentState = "none" | "starting" | "idle" | "busy" | "permission";

/** Map a Claude Code hook event to the state it leaves Claude in (undefined = no change). */
export function stateAfterHook(event: string, info: { notificationType?: string; message?: string }): AgentState | undefined {
  switch (event) {
    case "SessionStart":
    case "Stop":
    case "StopFailure": // an API error ends the turn without Stop
      return "idle";
    case "UserPromptSubmit":
    case "PostToolUse":
      return "busy";
    case "SessionEnd":
      return "starting";
    case "Notification": {
      const t = info.notificationType ?? "";
      const m = info.message ?? "";
      // Any dialog in Claude's terminal counts as "permission": Enter typed into it would answer it.
      if (["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"].includes(t)) return "permission";
      if (t === "elicitation_complete" || t === "elicitation_response") return "busy";
      if (t === "idle_prompt") return "idle"; // fires ~60 s after a reply; also heals a stale state after Esc
      if (!t && /needs your permission/i.test(m)) return "permission"; // older versions without notification_type
      return undefined;
    }
  }
  return undefined;
}

/** Claude Code output that means "you must sign in". Matched against the board terminal's recent output. */
const LOGIN_NEEDED = /(Please run \/login|Select login method|Not logged in|Invalid API key|Invalid bearer token|OAuth token (?:has )?expired|authentication_error)/i;
const LOGIN_DONE = /Login successful/i;

/** Scan terminal output for sign-in prompts and successes. Returns the new state, or undefined if nothing matched. */
export function loginSignal(text: string): { needed: boolean; hint?: string } | undefined {
  const done = text.search(LOGIN_DONE);
  const need = text.search(LOGIN_NEEDED);
  if (need < 0 && done < 0) return undefined;
  if (done > need) return { needed: false }; // the latest signal wins
  return { needed: true, hint: LOGIN_NEEDED.exec(text)?.[1] };
}

/** The program's name without its folder or (Windows) .exe: "/bin/zsh" → "zsh", "C:\…\claude.exe" → "claude". */
export const programName = (fg: string) => fg.split(/[\\/]/).pop()!.replace(/\.exe$/i, "");
// The native installer links `claude` to ~/.local/share/claude/versions/<version>, so the terminal reports the
// program as its version number (e.g. "2.1.312") instead of "claude".
export const isClaude = (fg: string) => /^(claude|\d+\.\d+\.\d+[\w.+-]*)$/i.test(programName(fg));
export const isShell = (fg: string) => /^-?(bash|zsh|sh|dash|powershell|pwsh)$/i.test(programName(fg));

/** The request as Claude will read it: which board tools it is about, then what to do. */
/**
 * The tools a request is about: the ones picked on the board, plus any it names ("@research"; an @word that is no
 * tool's name is just text), and the links that touch them, readable ("@note1 → @browser1").
 */
export function requestTools(board: Board, prompt: string, toolIds: string[], sectionIds: string[] = []) {
  const ids = new Set(toolIds.map((id) => board.getTool(id).id));
  const known = new Set(board.listTools().map((t) => t.id));
  const sections = new Map(sectionIds.map((id) => [board.getSection(id).id, board.getSection(id)]));
  for (const m of prompt.matchAll(/@([\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu)) {
    // "@notes." at the end of a sentence: try the word without its trailing dots too.
    const refs = [m[1], m[1].replace(/[._-]+$/, "")];
    const id = refs.map((ref) => board.resolveToolId(ref)).find((x) => known.has(x));
    if (id) ids.add(id);
    else
      for (const ref of refs) {
        const sec = board.listSections().find((x) => x.name.toLowerCase() === ref.toLowerCase());
        if (sec) sections.set(sec.id, sec);
      }
  }
  // A section stands for the tools in it.
  for (const sec of sections.values()) for (const t of board.toolsIn(sec.id)) ids.add(t.id);
  return {
    tools: [...ids].map((id) => board.getTool(id)),
    links: board.listLinks().filter((l) => ids.has(l.from) || ids.has(l.to)).map((l) => board.describeLink(l)),
    sections: [...sections.values()].map((sec) => `@${sec.name} "${sec.title}": ${board.toolsIn(sec.id).map((t) => `@${t.name}`).join(", ") || "empty"}`),
  };
}

/** links: how these tools are linked on the board, already readable ("@note1 → @browser1"); sections: the sections
 *  the request is about, with the tools in them. */
export function composeRequest(prompt: string, tools: Tool[], links: string[] = [], sections: string[] = []): string {
  if (!tools.length && !sections.length) return prompt.trim();
  const refs = tools.map((t) => `- @${t.name ?? t.id} "${t.title}" (${t.kind}, id: ${t.id})`).join("\n");
  const linked = links.length ? `\nLinks:\n${links.map((l) => `- ${l}`).join("\n")}\n` : "";
  const grouped = sections.length ? `\nSections:\n${sections.map((x) => `- ${x}`).join("\n")}\n` : "";
  return `[WorkBoard] A request about tools on the board (selected, or named with @). Read them with the workboard MCP (tool_read, app_snapshot, browser_snapshot).\nTools:\n${refs || "- (none)"}\n${linked}${grouped}\nRequest: ${prompt.trim()}`;
}

/** ANSI-C quoting ($'…') keeps newlines on one typed line in bash/zsh. */
export const shellQuote = (s: string) => `$'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "")}'`;
