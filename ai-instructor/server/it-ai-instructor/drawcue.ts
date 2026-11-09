// drawcue.ts - does the student's message ask for a picture? Used on courses that draw with tools (no textbook figure library), where a small
// model otherwise tends to answer a follow-up in words because its earlier turns in the history are plain text.
const EXPLICIT = /\b(draw|graph|diagram|plot|sketch|illustrate|visuali[sz]e|picture|chart|show\s+me|show\s+it|on\s+the\s+(board|whiteboard)|budget\s+line|indifference|tangen\w*|supply\s+and\s+demand|demand\s+curve|supply\s+curve|isoquant|cost\s+curves?|marginal\s+(cost|revenue))\b/i;
const CHANGE = /\b(what\s+(if|happens|would\s+happen)|suppose|assume|if\s+(the\s+)?(price|income|tax|subsidy|cost|demand|supply|wage)|(price|income|tax|subsidy|cost|demand|supply)\s+(rises?|falls?|increases?|decreases?|doubles?|halves|drops?|goes\s+(up|down))|(increase|decrease|raise|lower|cut|shift)s?\b)/i;
const ECON = /\b(budget|indifference|tangen\w*|supply|demand|curve|isoquant|costs?|revenue|prices?|equilibri\w+|surplus|elasticit\w+|tax(es)?|subsid\w+|monopol\w+|oligopol\w+|competiti\w+|utility|income|market|production|firms?|quantity|wage|labor|deadweight|externalit\w+|public\s+goods?|consumer|producer|normal\s+good|inferior|substitutes?|complements?|ppf|frontier|nash|payoff)\b/i;
export type DrawCue = "explicit" | "change" | "follow" | null;
export function drawCue(text: string): DrawCue {
  const t = String(text).slice(0, 600);
  if (!ECON.test(t)) return null;                       // a request to draw something unrelated to economics is never forced
  if (EXPLICIT.test(t)) return "explicit";
  if (CHANGE.test(t)) return "change";
  return null;
}
const FIRST = " Your FIRST sentence is at most 15 words, states no numbers and no results, only says what you are drawing, and the tool call comes immediately after it, BEFORE any explanation, so the picture appears as you begin to speak. Put the numbers and the walk-through after the call.";
export const DRAW_DIRECTIVE: Record<"explicit" | "change" | "follow", string> = {
  follow: "THIS IS A FOLLOW-UP IN A DRAWING CONVERSATION (the student's earlier question was answered with a picture). The board starts empty each turn: redraw the figure in THIS reply with the drawing tool (show_matrix, show_game_tree, show_graph or show_simplex, as before), adding whatever the follow-up needs (the next case, the marked example points, the changed curve, the shaded region), then explain." + FIRST,
  explicit: "THE STUDENT'S LATEST MESSAGE ASKS FOR A PICTURE. In THIS reply you MUST draw it with the drawing tool (show_consumer_choice for budget lines, indifference curves and consumer choice; otherwise show_graph): one short spoken sentence, then the tool call, then narrate the steps. This applies to follow-up questions too: every new question or changed number gets its own fresh drawing, even if an earlier graph is on the board. Never answer a request for a picture in words only and never say it is already on the screen." + FIRST,
  change: "THE STUDENT IS ASKING WHAT HAPPENS WHEN SOMETHING CHANGES. Show it: call the drawing tool (show_consumer_choice with `after` for consumer choice, otherwise show_graph with the before curve dashed and the after curve solid) in THIS reply, even if you drew a graph earlier in the conversation, then explain the movement step by step." + FIRST,
};
