// A review walkthrough, remembered per conversation: the missed questions themselves and how far through them the instructor is.
// The server (not the model's memory of earlier turns) hands the instructor the NEXT question when the student says yes,
// and puts that one question on the whiteboard. Held in memory for speed and in the database so it survives a cold start.
import type { MissedItem } from "./visuals.ts";
export interface ReviewWalk { ref: string; title: string; items: MissedItem[]; pos: number; solutions: boolean; score: number | null; maxScore: number | null; at: number }
const TTL_MS = 60 * 60 * 1000, MAX = 500;
const walks = new Map<string, ReviewWalk>();
export function setWalk(sessionId: string | null | undefined, w: Omit<ReviewWalk, "at">): void {
  if (!sessionId) return;
  if (walks.size >= MAX) { const old = walks.keys().next().value; if (old) walks.delete(old); }
  walks.set(sessionId, { ...w, at: Date.now() });
}
export function getWalk(sessionId: string | null | undefined, now = Date.now()): ReviewWalk | null {
  if (!sessionId) return null;
  const w = walks.get(sessionId);
  if (!w) return null;
  if (now - w.at > TTL_MS) { walks.delete(sessionId); return null; }
  return w;
}
export const clearWalk = (sessionId: string | null | undefined): void => { if (sessionId) walks.delete(sessionId); };

/** A short reply that means "I understood, go on". Anything longer or different is treated as a real question. */
const GO_ON = /^\s*(yes|yeah|yep|yup|ya|sure|ok|okay|k|got it|i get it|i see|makes sense|that makes sense|clear|understood|i understand|next|next one|next question|go on|go ahead|continue|move on|let'?s go|please|alright|right|fine|good|thanks|thank you|yes please|ok next|okay next)\b[\s.,!]*(.{0,25})?$/i;
export function wantsNext(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  if (/\b(not|don'?t|no|confus|why|how|what|wait|again|explain|repeat)\b/i.test(t)) return false;
  return GO_ON.test(t);
}

const BREVITY = "BE BRIEF. Per question use at most five short sentences: say the number, restate the question in one sentence (the full wording is on the board), say what the student chose versus the correct answer, give the reason in one or two sentences, then ask one short check like \"Clear?\". No long introduction, no repeating the score, no re-explaining earlier questions, no apologies.";
const entry = (m: MissedItem) => JSON.stringify({ q: m.q, ...(m.prompt ? { question: m.prompt } : {}), ...(m.options ? { options: m.options } : {}), student_answer: m.your, ...(m.correct !== undefined ? { correct_answer: m.correct } : {}), ...(m.explanation ? { explanation: m.explanation } : {}) });

/** The directive for this turn, and the position after it. `advance` is true when the student asked to continue. */
export function walkTurn(w: ReviewWalk, text: string): { directive: string; showNext: MissedItem | null; pos: number } {
  const n = w.items.length, go = wantsNext(text);
  const head = `REVIEW IN PROGRESS for "${w.title}". The review tools were already run and the real record is below, so never say you skipped the tools, never invent a correction, and never open the exam again. ${BREVITY}`;
  if (go && w.pos < n) {
    const next = w.items[w.pos];
    return { showNext: next, pos: w.pos + 1, directive: `${head}\nThe student understood and wants to continue. The NEXT missed question (${w.pos + 1} of ${n}) is now on their whiteboard. Give one short acknowledgement, then teach exactly this question from this record only: ${entry(next)}${w.pos + 1 >= n ? "\nThis is the LAST missed question: after it, say so and offer a two-sentence recap of what to study." : ""}` };
  }
  if (go && w.pos >= n) return { showNext: null, pos: w.pos, directive: `${head}\nEvery missed question has now been covered. Say so in one sentence and give a two-sentence recap of what to study. Do not start another question.` };
  const prev = w.items[Math.max(0, w.pos - 1)];
  return { showNext: null, pos: w.pos, directive: `${head}\nThe last question you explained was: ${prev ? entry(prev) : "none yet"}. ${w.pos < n ? `${n - w.pos} missed question(s) remain; the student will say when to continue, and the server then gives you the next one. Do not move on by yourself.` : "That was the last one."} If the student asks about it or says they did not understand, explain it another way, briefly. If they ask something else, answer briefly.` };
}
