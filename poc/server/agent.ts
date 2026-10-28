// The agent in the terminal: is Claude logged in, is it running, and how to hand it a request.
import { execFile } from "node:child_process";
import type { Tool } from "../shared/catalog.ts";

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

let cache: { at: number; value: ClaudeAuth } | null = null;
let inflight: Promise<ClaudeAuth> | null = null;

/** `claude auth status` (cached 15 s). Uses the same login the terminal's Claude Code uses. */
export function claudeAuth(force = false): Promise<ClaudeAuth> {
  if (!force && cache && Date.now() - cache.at < 15_000) return Promise.resolve(cache.value);
  inflight ??= new Promise<ClaudeAuth>((resolve) => {
    execFile("claude", ["auth", "status"], { timeout: 10_000, env: cleanEnv() }, (err, stdout) => {
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

// The native installer links `claude` to ~/.local/share/claude/versions/<version>, so the terminal reports the
// program as its version number (e.g. "2.1.312") instead of "claude".
export const isClaude = (fg: string) => /(^|\/)(claude|\d+\.\d+\.\d+[\w.+-]*)$/.test(fg);
export const isShell = (fg: string) => /(^|\/)-?(bash|zsh|sh|dash)$/.test(fg);

/** The request as Claude will read it: which board tools it is about, then what to do. */
export function composeRequest(prompt: string, tools: Tool[]): string {
  if (!tools.length) return prompt.trim();
  const refs = tools.map((t) => `- "${t.title}" (${t.kind}, id: ${t.id})`).join("\n");
  return `[WorkBoard] A request about tools selected on the board. Read them with the workboard MCP (tool_read, app_snapshot).\nTools:\n${refs}\n\nRequest: ${prompt.trim()}`;
}

/** ANSI-C quoting ($'…') keeps newlines on one typed line in bash/zsh. */
export const shellQuote = (s: string) => `$'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "")}'`;
