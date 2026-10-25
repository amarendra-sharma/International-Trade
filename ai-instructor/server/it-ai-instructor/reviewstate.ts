// Remembers, per conversation, which graded item the instructor is walking the student through and which questions were missed,
// so a short "yes" / "got it" from the student continues with the NEXT missed question instead of starting the review over.
// Kept in memory with an expiry; if the instance is cold the model still has the numbers it said aloud in the conversation.
export interface ReviewWalk { ref: string; title: string; missed: number[]; solutions: boolean; at: number }
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
/** The directive text for a review in progress. */
export function walkDirective(w: ReviewWalk): string {
  const list = w.missed.map((q) => `Q${q}`).join(", ");
  return `REVIEW IN PROGRESS: the review tools were ALREADY called for this exam earlier in this conversation and the real results were shown; you did not make anything up, so never say you skipped the tools or invent a correction. You are walking the student through "${w.title}" (ref ${w.ref}). The questions they missed, in order, are: ${list}. All of them are already on their whiteboard. From your own earlier messages in this conversation, work out which of these you have already explained; the next one is the first you have not. If the student says yes, ok, got it, makes sense, next, or anything meaning they understood, reply with one short acknowledgement and go straight to the next missed question: say its number, read or restate it, say what they answered, then explain. Do NOT call list_my_graded_work or review_graded_item again just to continue, do NOT reopen the board, and do NOT start over from the beginning. If they say they did not understand, explain the same question another way (a different angle or example) before moving on. Name the question number each time, and when the last one is done, say so and offer a short recap of the patterns in what they missed. Only call review_graded_item again if you need questions beyond the ones already given to you (use its offset).`;
}
