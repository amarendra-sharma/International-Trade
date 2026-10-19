// session-machine.ts - server-side session state machine.
//   listening -> processing -> generating -> speaking -> listening ...      (normal turn)
//   any active state -> interrupted -> listening|processing                 (student cuts in)
//   any state -> ended (terminal)
// "speaking" and "listening" are reported by the client (the server cannot hear the speaker); the rest are server-driven.
import type { SessionState } from "./schemas.ts";

const NEXT: Record<SessionState, SessionState[]> = {
  listening: ["processing", "interrupted", "ended", "listening", "speaking"],
  processing: ["generating", "listening", "interrupted", "ended"],
  generating: ["speaking", "listening", "interrupted", "ended"],
  speaking: ["listening", "processing", "interrupted", "ended"],
  interrupted: ["listening", "processing", "ended"],
  ended: [],
};
export const canTransition = (from: SessionState, to: SessionState) => from === to || NEXT[from].includes(to);
export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) throw new Error(`illegal session transition ${from} -> ${to}`);
}
export const isActive = (s: SessionState) => s !== "ended";
