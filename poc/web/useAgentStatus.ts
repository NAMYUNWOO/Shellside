// Polls whether Claude is logged in and whether it is running in the terminal.
import { useCallback, useEffect, useState } from "react";
import { api, type AgentStatus } from "./api.ts";

export function useAgentStatus(boardId: string, intervalMs = 3_000) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const refresh = useCallback((force = false) => {
    api.agentStatus(boardId, force).then(setStatus, () => {});
  }, [boardId]);
  useEffect(() => {
    refresh();
    const id = window.setInterval(() => refresh(), intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);
  return { status, refresh };
}
