// visuals.ts - validation of what the instructor may ask the student's screen to draw. The model never sends HTML or SVG: only
// numbers and short labels (graphs) or a TeX string (equations), which the client renders with its own trusted code.
import { CalcError, evaluate } from "./econ.ts";
import * as E from "./econ.ts";
import { lookupFigure } from "./figures.ts";

export interface GraphSpec {
  kind: "graph"; title?: string; x_label: string; y_label: string; x_max?: number; y_max?: number;
  series: { label: string; points: [number, number][]; dashed?: boolean; note?: string }[];
  regions?: { label: string; points: [number, number][]; note?: string }[];
  markers: { x: number; y: number; label: string; note?: string }[];
}
export interface EquationSpec { kind: "equation"; tex: string; caption?: string }
/** One of the textbook's own figures. Panels hold the book's SVG pieces grouped into reveal steps; the client sanitises them before drawing. */
export interface FigureSpec { kind: "figure"; num: string; title: string; caption: string; panels: { viewBox: string; steps: { label: string; svg: string }[] }[] }
/** A graded paper (bubble-sheet) exam: the scanned pages (paths in the private paper-scans bucket, which the student's own browser downloads with the student's own session) beside the questions they missed. */
export interface ScanSpec { kind: "scan"; title: string; score: number | null; max_score: number | null; paths: string[]; bucket: "paper-scans"; wrong: { q: string; your: string; correct?: string; earned?: number; points?: number }[]; total_questions: number }
/** The questions a student missed on a graded exam, arena or paper exam, laid out on the whiteboard so they can be gone over one by one. */
export interface MissedItem { q: string; figure?: string; prompt?: string; options?: string[]; your: string; correct?: string; explanation?: string; earned?: number; points?: number }
export interface MissedSpec {
  index?: number; count?: number; kind: "missed"; title: string; score: number | null; max_score: number | null; total_questions: number; items: MissedItem[] }
export type VisualSpec = GraphSpec | EquationSpec | FigureSpec | ScanSpec | MissedSpec | MatrixSpec | TreeSpec | SimplexSpec;

const clean = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u001f<>&"'`]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const LIM = 1e6;
const num = (v: unknown, what: string): number => { if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > LIM) throw new CalcError(`${what} must be a finite number below ${LIM}`); return v; };

export interface GraphInput {
  title?: string; x_label: string; y_label: string; x_max?: number; y_max?: number;
  series: { label: string; points?: number[][]; expr?: string; x_expr?: string; y_expr?: string; param?: string; from?: number; to?: number; dashed?: boolean; note?: string }[];
  markers?: { x?: number; y?: number; label: string; note?: string; intersect?: number[] }[];
  regions?: { label: string; points: number[][]; note?: string }[];
}
const SAMPLES = 60;
/** First crossing of two curves (as drawn), ignoring the trivial crossing at the origin that offer curves share. */
function crossing(a: [number, number][], b: [number, number][], tiny: number): [number, number] | null {
  for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) {
    const [x1, y1] = a[i], [x2, y2] = a[i + 1], [x3, y3] = b[j], [x4, y4] = b[j + 1];
    const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3); if (Math.abs(d) < 1e-12) continue;
    const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d, u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
    if (t < 0 || t > 1 || u < 0 || u > 1) continue;
    const x = x1 + t * (x2 - x1), y = y1 + t * (y2 - y1);
    if (Math.abs(x) <= tiny && Math.abs(y) <= tiny) continue;
    return [Math.round(x * 1e3) / 1e3, Math.round(y * 1e3) / 1e3];
  }
  return null;
}
/** Points of a curve the SERVER computes exactly: y = f(x) over [from, to], or (x(t), y(t)) for a parametric curve such as an offer curve. */
function sampleCurve(s: GraphInput["series"][number], k: number): [number, number][] {
  const lo = num(s.from, "from"), hi = num(s.to, "to");
  if (!(hi > lo)) throw new CalcError(`curve ${k + 1}: "to" must be greater than "from"`);
  const out: [number, number][] = [];
  let bad = 0;
  for (let q = 0; q < SAMPLES; q++) {
    const t = lo + ((hi - lo) * q) / (SAMPLES - 1);
    try {
      let px: number, py: number;
      if (s.expr) { const name = (s.param || "x").toLowerCase(); px = t; py = evaluate(s.expr, { [name]: t }); }
      else { const name = (s.param || "t").toLowerCase(); px = evaluate(s.x_expr as string, { [name]: t }); py = evaluate(s.y_expr as string, { [name]: t }); }
      if (Math.abs(px) <= LIM && Math.abs(py) <= LIM) out.push([Math.round(px * 1e4) / 1e4, Math.round(py * 1e4) / 1e4]); else bad++;
    } catch (e) { if (e instanceof CalcError && q === 0 && !out.length && /unknown name|unexpected|missing|bad call/.test(e.message)) throw e; bad++; }
  }
  if (out.length < 2) throw new CalcError(`curve ${k + 1} ("${clean(s.label, 40)}") could not be computed over ${lo} to ${hi}; check the formula and the range`);
  return out;
}
export function graphSpec(i: GraphInput): GraphSpec {
  if (!i.series.length && !(i.regions ?? []).length) throw new CalcError("1 or more curves, or a shaded region");
  // Oversized input is thinned rather than rejected, so a long point list still draws.
  const thin = <T,>(a: T[], n: number): T[] => { if (a.length <= n) return a; const out: T[] = []; for (let q = 0; q < n; q++) out.push(a[Math.round(q * (a.length - 1) / (n - 1))]); return out; };
  const series = i.series.slice(0, 6).map((s, k) => {
    const formula = !!(s.expr || (s.x_expr && s.y_expr));
    let pts: number[][];
    if (formula) pts = sampleCurve(s, k);
    else {
      if (!s.points || s.points.length < 2) throw new CalcError(`curve ${k + 1} needs points, or a formula (expr, from, to)`);
      pts = thin(s.points, 40);
    }
    const out: GraphSpec["series"][number] = { label: clean(s.label, 40), dashed: !!s.dashed, points: pts.map((p, j) => { if (p.length !== 2) throw new CalcError(`point ${j + 1} of curve ${k + 1} must be [x, y]`); return [num(p[0], "x"), num(p[1], "y")] as [number, number]; }) };
    if (s.note) out.note = clean(s.note, 110);
    return out;
  });
  let ext = 0; for (const s of series) for (const p of s.points) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]));
  const markers = (i.markers ?? []).slice(0, 8).map((m) => {
    let x = m.x, y = m.y;
    if (m.intersect) {
      const [p, q] = m.intersect; const A = series[(p ?? 0) - 1], B = series[(q ?? 0) - 1];
      if (!A || !B || p === q) throw new CalcError(`marker "${clean(m.label, 30)}": intersect needs two different curve numbers between 1 and ${series.length}`);
      const c = crossing(A.points, B.points, ext * 0.02);
      if (!c) throw new CalcError(`marker "${clean(m.label, 30)}": curves ${p} and ${q} do not cross inside the drawn range; widen the range or give the point yourself`);
      [x, y] = c;
    }
    const o: GraphSpec["markers"][number] = { x: num(x, "marker x"), y: num(y, "marker y"), label: clean(m.label, 30) }; if (m.note) o.note = clean(m.note, 110); return o;
  });
  const spec: GraphSpec = { kind: "graph", x_label: clean(i.x_label, 40), y_label: clean(i.y_label, 40), series, markers };
  // shaded regions (feasible sets, bargaining sets, payoff regions): polygons of [x, y] corner points
  const regions = (i.regions ?? []).slice(0, 4).map((r, k) => {
    if (!r.points || r.points.length < 3 || r.points.length > 14) throw new CalcError(`region ${k + 1} needs 3 to 14 corner points [x, y]`);
    const o: NonNullable<GraphSpec["regions"]>[number] = { label: clean(r.label, 40), points: r.points.map((p, j) => { if (p.length !== 2) throw new CalcError(`corner ${j + 1} of region ${k + 1} must be [x, y]`); return [num(p[0], "x"), num(p[1], "y")] as [number, number]; }) };
    if (r.note) o.note = clean(r.note, 110); return o;
  });
  if (regions.length) spec.regions = regions;
  if (i.title) spec.title = clean(i.title, 80);
  if (i.x_max !== undefined) spec.x_max = num(i.x_max, "x_max");
  if (i.y_max !== undefined) spec.y_max = num(i.y_max, "y_max");
  return spec;
}


// ---- consumer choice (budget line + indifference curve) --------------------------------------------------------------------------
// Computed exactly on the server so the tangency is true by construction; the model gives only the numbers of the problem.
export interface ChoiceSituation { income?: number; px?: number; py?: number }
export interface ChoiceInput { utility: "cobb_douglas" | "perfect_substitutes" | "perfect_complements"; a?: number; b?: number; income: number; px: number; py: number; x_label?: string; y_label?: string; after?: ChoiceSituation; title?: string }
export interface ChoiceResult { spec: GraphSpec; before: { x: number; y: number; utility: number }; after?: { x: number; y: number; utility: number }; note: string }
const r3 = (v: number) => Math.round(v * 1e3) / 1e3;
function optimum(u: ChoiceInput["utility"], a: number, b: number, m: number, px: number, py: number): { x: number; y: number; U: number; tie?: boolean } {
  if (u === "cobb_douglas") { const x = a * m / px, y = (1 - a) * m / py; return { x, y, U: Math.pow(x, a) * Math.pow(y, 1 - a) }; }
  if (u === "perfect_substitutes") {
    const rx = a / px, ry = b / py;
    if (Math.abs(rx - ry) < 1e-12 * Math.max(rx, ry)) return { x: m / (2 * px), y: m / (2 * py), U: a * m / (2 * px) + b * m / (2 * py), tie: true };
    return rx > ry ? { x: m / px, y: 0, U: a * m / px } : { x: 0, y: m / py, U: b * m / py };
  }
  const t = m / (a * px + b * py); return { x: a * t, y: b * t, U: t };          // fixed proportions: U = min(x/a, y/b)
}
export function consumerChoice(i: ChoiceInput): ChoiceResult {
  const kind = i.utility;
  if (!["cobb_douglas", "perfect_substitutes", "perfect_complements"].includes(kind)) throw new CalcError("utility must be cobb_douglas, perfect_substitutes or perfect_complements");
  let a = i.a, b = i.b;
  if (kind === "cobb_douglas") { a = a ?? 0.5; if (!(a > 0 && a < 1)) throw new CalcError("for cobb_douglas, a is the exponent on good X in U = X^a * Y^(1-a) and must be between 0 and 1 (for example 0.5)"); b = 1 - a; }
  else { a = a ?? 1; b = b ?? 1; if (!(a > 0 && b > 0)) throw new CalcError("a and b must be positive"); }
  const sit = (s: ChoiceSituation | undefined) => ({ m: s?.income ?? i.income, px: s?.px ?? i.px, py: s?.py ?? i.py });
  const sits = [sit(undefined), ...(i.after ? [sit(i.after)] : [])];
  for (const s of sits) { num(s.m, "income"); num(s.px, "price of X"); num(s.py, "price of Y"); if (!(s.m > 0 && s.px > 0 && s.py > 0)) throw new CalcError("income and both prices must be positive"); }
  const opts = sits.map((s) => ({ ...s, o: optimum(kind, a as number, b as number, s.m, s.px, s.py) }));
  const xmax = r3(Math.max(...opts.map((s) => s.m / s.px)) * 1.2), ymax = r3(Math.max(...opts.map((s) => s.m / s.py)) * 1.2);
  const series: GraphSpec["series"] = []; const markers: GraphSpec["markers"] = [];
  const multi = opts.length > 1;
  opts.forEach((s, k) => {
    const tag = multi ? (k === 0 ? "before" : "after") : "";
    const dashed = multi && k === 0;
    series.push({ label: clean(`Budget line${tag ? " (" + tag + ")" : ""}`, 40), dashed, points: [[0, r3(s.m / s.py)], [r3(s.m / s.px), 0]], note: clean(`all bundles that cost exactly ${r3(s.m)}: X costs ${r3(s.px)}, Y costs ${r3(s.py)}`, 110) });
    const pts: [number, number][] = [];
    const U = s.o.U;
    if (kind === "cobb_douglas") {
      const A = a as number, lo = Math.max(1e-6, Math.pow(U / Math.pow(ymax, 1 - A), 1 / A));
      for (let q = 0; q < 80; q++) { const x = lo + ((xmax - lo) * q) / 79; if (x <= 0 || x > xmax) continue; const y = Math.pow(U / Math.pow(x, A), 1 / (1 - A)); if (y >= 0 && y <= ymax) pts.push([r3(x), r3(y)]); }
    } else if (kind === "perfect_substitutes") {
      const A = a as number, B = b as number;
      for (const x of [0, U / A]) { const y = (U - A * x) / B; pts.push([r3(x), r3(y)]); }
      if (pts[0][1] > ymax) { pts[0] = [r3((U - B * ymax) / A), r3(ymax)]; }
      if (pts[1][0] > xmax) { pts[1] = [r3(xmax), r3((U - A * xmax) / B)]; }
    } else {
      pts.push([r3(s.o.x), r3(ymax)], [r3(s.o.x), r3(s.o.y)], [r3(xmax), r3(s.o.y)]);
    }
    if (pts.length < 2) throw new CalcError("the indifference curve falls outside the drawn range; use more ordinary numbers");
    series.push({ label: clean(`Indifference curve${tag ? " (" + tag + ")" : ""}`, 40), dashed, points: pts, note: clean(`bundles giving the same satisfaction (utility ${r3(U)})`, 110) });
    markers.push({ x: r3(s.o.x), y: r3(s.o.y), label: multi ? (k === 0 ? "E0" : "E1") : "E", note: clean(`best affordable bundle: ${r3(s.o.x)} of X and ${r3(s.o.y)} of Y`, 110) });
  });
  const unit = (n: number) => r3(n);
  const o0 = opts[0].o, o1 = opts[1]?.o;
  const note = kind === "cobb_douglas"
    ? "At the optimum the indifference curve just touches the budget line (tangency): the marginal rate of substitution equals the price ratio Px/Py = " + unit(opts[opts.length - 1].px / opts[opts.length - 1].py) + "."
    : kind === "perfect_substitutes" ? "With perfect substitutes the indifference curves are straight lines, so the best bundle is a corner (all of the good with the larger utility per dollar), or any affordable mix on the budget line if the two are equal."
    : "With perfect complements the indifference curves are L-shaped, so the best bundle sits at the corner where the goods are used in fixed proportions.";
  const spec: GraphSpec = { kind: "graph", x_label: clean(i.x_label ?? "Good X", 40), y_label: clean(i.y_label ?? "Good Y", 40), x_max: xmax, y_max: ymax, series, markers };
  spec.title = clean(i.title ?? (multi ? "Consumer choice: before and after" : "Consumer choice: budget line and indifference curve"), 80);
  return { spec, before: { x: r3(o0.x), y: r3(o0.y), utility: r3(o0.U) }, ...(o1 ? { after: { x: r3(o1.x), y: r3(o1.y), utility: r3(o1.U) } } : {}), note };
}

// ---- graded-work review: every question, not only the first few ------------------------------------------------------------------
export interface ReviewRow extends MissedItem { wrong: boolean }
const firstOf = (i: Record<string, unknown>, ...keys: string[]): unknown => { for (const k of keys) if (i[k] !== undefined && i[k] !== null && i[k] !== "") return i[k]; return undefined; };
const optText = (o: unknown): string => typeof o === "string" ? o : o && typeof o === "object" ? String((o as Record<string, unknown>).text ?? (o as Record<string, unknown>).label ?? "") : String(o ?? "");
/** One row per question from any of the review shapes (online exam, paper exam, arena), correct answers and explanations only when `solutions` is true. */
export function reviewRows(items: Record<string, unknown>[], solutions: boolean): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const i of items) {
    if (!i || typeof i !== "object") continue;
    const qv = firstOf(i, "q", "n"); if (qv === undefined) continue;
    const earnedV = firstOf(i, "points_earned", "earned"), pointsV = firstOf(i, "points_possible", "points");
    const earned = typeof earnedV === "number" ? earnedV : undefined, points = typeof pointsV === "number" ? pointsV : undefined;
    const flag = firstOf(i, "marked_correct", "correct_flag");
    const wrong = flag === false || (flag !== true && earned !== undefined && points !== undefined && earned < points);
    const promptV = firstOf(i, "prompt", "question"), optsV = i.options;
    const yourV = firstOf(i, "student_choice", "your", "student_answer");
    const corrV = solutions ? firstOf(i, "correct_choice", "correct", "correct_value") : undefined;
    const expV = solutions ? firstOf(i, "explanation", "rationale") : undefined;
    const row: ReviewRow = { q: clean(qv, 8), your: clean(yourV, 160) || "blank", wrong };
    if (promptV !== undefined) row.prompt = clean(promptV, 700);
    if (Array.isArray(optsV) && optsV.length) row.options = optsV.slice(0, 8).map((o) => clean(optText(o), 160)).filter(Boolean);
    if (corrV !== undefined) row.correct = clean(corrV, 160);
    if (expV !== undefined) row.explanation = clean(expV, 700);
    // The question's own graph (an SVG drawn by the instructor's item bank). Only a plain SVG string is kept; the browser re-checks it before drawing.
    const figV = i.figure as { svg?: unknown } | undefined;
    if (figV && typeof figV === "object" && typeof figV.svg === "string" && figV.svg.startsWith("<svg") && figV.svg.length <= 24000) row.figure = figV.svg;
    if (earned !== undefined) row.earned = earned; if (points !== undefined) row.points = points;
    rows.push(row);
  }
  return rows;
}
export function missedSpec(a: { title: string; score: number | null; maxScore: number | null; rows: ReviewRow[] }, withFigures = false): MissedSpec | null {
  const items = a.rows.filter((r) => r.wrong).slice(0, 60).map(({ wrong: _w, figure, ...rest }) => (withFigures && figure ? { ...rest, figure } : rest));
  if (!items.length) return null;
  return { kind: "missed", title: clean(a.title, 120), score: a.score, max_score: a.maxScore, total_questions: a.rows.length, items };
}
/** The next page of missed questions for the model, sized to fit the tool-output limit so nothing is cut off mid-question. */
export function reviewPage(missed: ReviewRow[], offset: number, budgetChars = 3600): { entries: Record<string, unknown>[]; next_offset: number | null } {
  const entries: Record<string, unknown>[] = []; let used = 0, k = Math.max(0, offset);
  for (; k < missed.length; k++) {
    const m = missed[k];
    const e: Record<string, unknown> = { q: m.q, ...(m.prompt ? { question: m.prompt.slice(0, 450) } : {}), ...(m.options ? { options: m.options.slice(0, 6).map((o) => o.slice(0, 90)) } : {}), student_answer: m.your,
      ...(m.correct !== undefined ? { correct_answer: m.correct } : {}), ...(m.explanation ? { explanation: m.explanation.slice(0, 350) } : {}), ...(m.earned !== undefined && m.points !== undefined ? { points: `${m.earned} of ${m.points}` } : {}) };
    const size = JSON.stringify(e).length;
    if (entries.length && used + size > budgetChars) break;
    entries.push(e); used += size;
  }
  return { entries, next_offset: k < missed.length ? k : null };
}

// TeX that could reach outside math rendering is refused. The client also renders with KaTeX `trust: false`.
const TEX_DENY = /\\(input|include|write|read|def|edef|gdef|let|newcommand|renewcommand|href|url|includegraphics|catcode|csname|expandafter|openin|openout|immediate|special|verb|style|class|htmlClass|htmlId|htmlStyle|htmlData)\b/i;
export function equationSpec(i: { tex: string; caption?: string }): EquationSpec {
  const tex = i.tex.replace(/\s+/g, " ").trim();
  if (!tex || tex.length > 300) throw new CalcError("equation must be 1 to 300 characters");
  if (TEX_DENY.test(tex) || /[\u0000-\u001f]/.test(tex)) throw new CalcError("that TeX command is not allowed");
  if (((tex.match(/\{/g) ?? []).length) !== ((tex.match(/\}/g) ?? []).length)) throw new CalcError("unbalanced braces");
  const spec: EquationSpec = { kind: "equation", tex };
  if (i.caption) spec.caption = clean(i.caption, 120);
  return spec;
}

/** The book's figure `q` as a spec for the whiteboard, or an error naming what is available. */
export function figureSpec(q: string): FigureSpec {
  const f = lookupFigure(q);
  if (!f) throw new CalcError(`There is no redrawable textbook figure "${clean(q, 30)}". Check the figure numbers in the tool description, or draw a graph with show_graph.`);
  return { kind: "figure", num: f.num, title: f.title, caption: f.caption, panels: f.panels };
}

const SCAN_PATH = /^[A-Za-z0-9][A-Za-z0-9_\-./]{0,200}$/;
const short = (v: unknown, n: number) => clean(v, n);
/** Builds the whiteboard picture for a student's own graded paper exam from the database's review result. Paths must look like storage paths (no "..", no scheme); nothing else from the model is trusted. */
export function scanSpec(a: { title: string; score: number | null; maxScore: number | null; paths: string[]; items: Record<string, unknown>[]; solutions: boolean }): ScanSpec | null {
  const paths = a.paths.filter((p) => typeof p === "string" && SCAN_PATH.test(p) && !p.includes("..") && !p.startsWith("/")).slice(0, 12);
  if (!paths.length) return null;
  const wrong = a.items.filter((i) => i && (i.correct_flag === false || (typeof i.earned === "number" && typeof i.points === "number" && i.earned < i.points)))
    .slice(0, 60).map((i) => ({
      q: short(i.q, 8), your: short(i.your, 40) || "blank",
      ...(a.solutions && i.correct !== undefined && i.correct !== null ? { correct: short(i.correct, 40) } : {}),
      ...(typeof i.earned === "number" ? { earned: i.earned } : {}), ...(typeof i.points === "number" ? { points: i.points } : {}),
    }));
  return { kind: "scan", title: short(a.title, 120), score: a.score, max_score: a.maxScore, paths, bucket: "paper-scans", wrong, total_questions: a.items.length };
}

// ---- game theory diagrams: payoff matrix and game tree ---------------------------------------------------------------------------------
// The model gives labels and payoffs (as short strings, so a payoff may be a number such as "-1" or a symbol such as "T"); the server checks them,
// works out the best responses, Nash equilibria and the backward-induction path exactly, and the client draws the result.
export interface MatrixSpec { kind: "matrix"; title?: string; row_player: string; col_player: string; row_labels: string[]; col_labels: string[]; cells: (number | string)[][][];
  br_row?: boolean[][]; br_col?: boolean[][]; nash?: [number, number][]; note?: string }
export interface TreeNode { id: string; parent?: string; edge?: string; prob?: number; player?: string; info?: string; payoff?: (number | string)[]; spne?: boolean }
export interface TreeSpec { kind: "tree"; title?: string; players: string[]; nodes: TreeNode[] }
export interface MatrixInput { title?: string; row_player?: string; col_player?: string; row_labels: string[]; col_labels: string[]; payoffs: string[][][]; note?: string }
export interface TreeInput { title?: string; players: string[]; nodes: { id: string; parent?: string; move?: string; prob?: number; player?: string; info?: string; payoffs?: string[] }[] }
const val = (s: string): number | string => { const t = String(s).trim(); if (t !== "" && Number.isFinite(Number(t)) && Math.abs(Number(t)) <= LIM) return Number(t); return clean(t, 12) || "?"; };

export function matrixSpec(i: MatrixInput): { spec: MatrixSpec; facts: Record<string, unknown> } {
  const n = i.payoffs.length, m = i.payoffs[0]?.length ?? 0;
  if (n < 2 || n > 5 || m < 2 || m > 5) throw new CalcError("a payoff matrix needs 2 to 5 strategies for each player");
  if (i.row_labels.length !== n || i.col_labels.length !== m) throw new CalcError(`row_labels must have ${n} entries and col_labels ${m}, matching the payoffs grid (rows first)`);
  const cells = i.payoffs.map((r, a) => { if (r.length !== m) throw new CalcError("every row of payoffs must have the same number of cells"); return r.map((c, b) => { if (c.length !== 2) throw new CalcError(`cell (${a + 1},${b + 1}) must be [row player payoff, column player payoff]`); return [val(c[0]), val(c[1])]; }); });
  const spec: MatrixSpec = { kind: "matrix", row_player: clean(i.row_player ?? "Row", 24), col_player: clean(i.col_player ?? "Column", 24), row_labels: i.row_labels.map((s) => clean(s, 20)), col_labels: i.col_labels.map((s) => clean(s, 20)), cells };
  if (i.title) spec.title = clean(i.title, 80); if (i.note) spec.note = clean(i.note, 110);
  const numeric = cells.every((r) => r.every((c) => typeof c[0] === "number" && typeof c[1] === "number"));
  const facts: Record<string, unknown> = { numeric };
  if (numeric) {
    const A = (a: number, b: number) => cells[a][b][0] as number, B = (a: number, b: number) => cells[a][b][1] as number;
    spec.br_row = cells.map((r, a) => r.map((_, b) => A(a, b) >= Math.max(...cells.map((_, k) => A(k, b)))));
    spec.br_col = cells.map((r, a) => r.map((_, b) => B(a, b) >= Math.max(...r.map((_, k) => B(a, k)))));
    spec.nash = [];
    for (let a = 0; a < n; a++) for (let b = 0; b < m; b++) if (spec.br_row[a][b] && spec.br_col[a][b]) spec.nash.push([a, b]);
    Object.assign(facts, E.nash(cells as unknown as number[][][]));
    facts.pure_nash_cells = spec.nash.map(([a, b]) => `${spec.row_labels[a]} / ${spec.col_labels[b]}`);
  }
  return { spec, facts };
}

export function treeSpec(i: TreeInput): { spec: TreeSpec; facts: Record<string, unknown> } {
  const players = i.players.map((p) => clean(p, 16)); if (players.length < 2 || players.length > 4 || new Set(players).size !== players.length) throw new CalcError("players: 2 to 4 different names");
  if (i.nodes.length < 3 || i.nodes.length > 31) throw new CalcError("a game tree needs 3 to 31 nodes");
  const ids = new Set<string>(), kids = new Map<string, string[]>(), nodes: TreeNode[] = [], depth = new Map<string, number>();
  i.nodes.forEach((nd, k) => {
    const id = clean(nd.id, 12).replace(/\s/g, ""); if (!id || ids.has(id)) throw new CalcError(`node ${k + 1}: id must be unique and non-empty`);
    const out: TreeNode = { id };
    if (k === 0) { if (nd.parent) throw new CalcError("the first node is the root and has no parent"); depth.set(id, 0); }
    else { const p = clean(nd.parent ?? "", 12).replace(/\s/g, ""); if (!ids.has(p)) throw new CalcError(`node "${id}": parent "${p}" must be listed BEFORE it`); out.parent = p; out.edge = clean(nd.move ?? "", 20); if (!out.edge) throw new CalcError(`node "${id}": give the move (edge label) that leads to it`);
      if (nd.prob !== undefined) { if (!(nd.prob >= 0 && nd.prob <= 1)) throw new CalcError(`node "${id}": prob must be between 0 and 1`); out.prob = nd.prob; }
      kids.get(p)!.push(id); const d = (depth.get(p) ?? 0) + 1; if (d > 6) throw new CalcError("the tree is too deep (at most 6 moves)"); depth.set(id, d); }
    if (nd.player) out.player = clean(nd.player, 16); if (nd.info) out.info = clean(nd.info, 12);
    if (nd.payoffs) out.payoff = nd.payoffs.map(val);
    ids.add(id); kids.set(id, []); nodes.push(out);
  });
  // checks: decision nodes have a mover and 2+ moves; terminal nodes have one payoff per player
  for (const nd of nodes) {
    const ks = kids.get(nd.id)!;
    if (ks.length) {
      if (ks.length < 2) throw new CalcError(`node "${nd.id}" has only one move; a decision point needs at least two`);
      if (!nd.player) throw new CalcError(`node "${nd.id}" has moves but no player; give player (one of the players, or "Nature")`);
      if (nd.player !== "Nature" && !players.includes(nd.player)) throw new CalcError(`node "${nd.id}": player "${nd.player}" is not in players (use "Nature" for chance moves)`);
      if (nd.player === "Nature") { const s = ks.reduce((a, k) => a + (nodes.find((x) => x.id === k)!.prob ?? NaN), 0); if (!(Math.abs(s - 1) < 1e-6)) throw new CalcError(`node "${nd.id}": Nature's move probabilities (prob on each child) must add to 1`); }
      if (nd.payoff) throw new CalcError(`node "${nd.id}" has moves, so it cannot have payoffs`);
    } else if (!nd.payoff || nd.payoff.length !== players.length) throw new CalcError(`terminal node "${nd.id}" needs payoffs: one per player, in the order of players`);
  }
  const facts: Record<string, unknown> = {}, byId = new Map(nodes.map((n) => [n.id, n]));
  const perfect = !nodes.some((n) => n.info) && nodes.every((n) => (kids.get(n.id)!.length ? true : (n.payoff ?? []).every((v) => typeof v === "number")));
  if (perfect) {
    const value = (id: string): number[] => {
      const nd = byId.get(id)!, ks = kids.get(id)!;
      if (!ks.length) return nd.payoff as number[];
      const vs = ks.map(value);
      if (nd.player === "Nature") return players.map((_, p) => ks.reduce((a, k, q) => a + (byId.get(k)!.prob as number) * vs[q][p], 0));
      const pi = players.indexOf(nd.player as string); let best = 0; vs.forEach((v, q) => { if (v[pi] > vs[best][pi] + 1e-12) best = q; });
      ks.forEach((k, q) => { if (q === best) byId.get(k)!.spne = true; });
      return vs[best];
    };
    const root = value(nodes[0].id).map((v) => Math.round(v * 1e4) / 1e4);
    const path: string[] = []; let cur = nodes[0].id;
    for (let g = 0; g < 8; g++) { const ks = kids.get(cur)!; if (!ks.length) break; const nd = byId.get(cur)!; const nxt = nd.player === "Nature" ? null : ks.find((k) => byId.get(k)!.spne); if (!nxt) { path.push(`Nature moves`); break; } path.push(`${nd.player} plays ${byId.get(nxt)!.edge}`); cur = nxt; }
    facts.backward_induction = { equilibrium_path: path, payoffs_at_root: Object.fromEntries(players.map((p, k) => [p, root[k]])), note: "highlighted on the board; ties are broken toward the earlier-listed move" };
  } else facts.backward_induction = "not computed (information sets, symbolic payoffs): explain the equilibrium in words";
  const spec: TreeSpec = { kind: "tree", players, nodes };
  if (i.title) spec.title = clean(i.title, 80);
  return { spec, facts };
}

// ---- simplex (three-strategy triangle): population mixes, rock-paper-scissors flow, allocations among three players -----------------------
export interface SimplexSpec { kind: "simplex"; title?: string; corners: [string, string, string];
  points: { label: string; p: [number, number, number]; note?: string }[];
  paths: { label: string; pts: [number, number, number][]; dashed?: boolean; note?: string }[];
  regions: { label: string; pts: [number, number, number][]; note?: string }[] }
export interface SimplexInput { title?: string; corners: string[];
  points?: { label: string; p: number[]; note?: string }[];
  regions?: { label: string; pts: number[][]; note?: string }[];
  paths?: { label: string; pts: number[][]; dashed?: boolean; note?: string }[];
  flow?: { payoffs: string[][]; starts: number[][]; label?: string } }
const bary = (p: number[], what: string): [number, number, number] => {
  if (p.length !== 3 || p.some((v) => !Number.isFinite(v) || v < -1e-9)) throw new CalcError(`${what}: needs three non-negative shares [a, b, c]`);
  const s = p[0] + p[1] + p[2]; if (!(s > 0)) throw new CalcError(`${what}: shares must not all be zero`);
  return [r3(p[0] / s), r3(p[1] / s), r3(p[2] / s)];
};
export function simplexSpec(i: SimplexInput): { spec: SimplexSpec; facts: Record<string, unknown> } {
  if (i.corners.length !== 3) throw new CalcError("corners: exactly three labels (top, bottom-left, bottom-right)");
  const spec: SimplexSpec = { kind: "simplex", corners: [clean(i.corners[0], 24), clean(i.corners[1], 24), clean(i.corners[2], 24)], points: [], paths: [], regions: [] };
  if (i.title) spec.title = clean(i.title, 80);
  const facts: Record<string, unknown> = {};
  for (const r of (i.regions ?? []).slice(0, 4)) { if (r.pts.length < 3 || r.pts.length > 12) throw new CalcError(`region "${clean(r.label, 20)}" needs 3 to 12 corner points`); spec.regions.push({ label: clean(r.label, 30), pts: r.pts.map((p, k) => bary(p, `region point ${k + 1}`)), ...(r.note ? { note: clean(r.note, 110) } : {}) }); }
  for (const r of (i.paths ?? []).slice(0, 5)) { if (r.pts.length < 2 || r.pts.length > 120) throw new CalcError(`path "${clean(r.label, 20)}" needs 2 to 120 points`); spec.paths.push({ label: clean(r.label, 30), pts: r.pts.map((p, k) => bary(p, `path point ${k + 1}`)), dashed: !!r.dashed, ...(r.note ? { note: clean(r.note, 110) } : {}) }); }
  if (i.flow) {
    const A = i.flow.payoffs.map((row) => row.map((s) => { const v = Number(String(s).trim()); if (!Number.isFinite(v)) throw new CalcError("flow payoffs must be numbers"); return v; }));
    if (A.length !== 3 || A.some((r) => r.length !== 3)) throw new CalcError("flow.payoffs must be a 3x3 matrix: payoffs[i][j] = payoff to strategy i against strategy j");
    for (const st of i.flow.starts.slice(0, 5)) {
      let x = bary(st, "flow start") as number[]; const pts: [number, number, number][] = [[x[0], x[1], x[2]]];
      const f = (y: number[]) => { const u = [0, 1, 2].map((a) => A[a][0] * y[0] + A[a][1] * y[1] + A[a][2] * y[2]); const avg = y[0] * u[0] + y[1] * u[1] + y[2] * u[2]; return y.map((v, a) => v * (u[a] - avg)); };
      for (let s = 0; s < 400; s++) {
        const h = 0.04, k1 = f(x), k2 = f(x.map((v, a) => v + h / 2 * k1[a])), k3 = f(x.map((v, a) => v + h / 2 * k2[a])), k4 = f(x.map((v, a) => v + h * k3[a]));
        x = x.map((v, a) => Math.max(0, v + h / 6 * (k1[a] + 2 * k2[a] + 2 * k3[a] + k4[a]))); const t = x[0] + x[1] + x[2]; x = x.map((v) => v / t);
        if (s % 5 === 4) pts.push([r3(x[0]), r3(x[1]), r3(x[2])]);
      }
      spec.paths.push({ label: clean(i.flow.label ?? "Population path", 30), pts, note: "replicator dynamics computed by the server" });
    }
    const end = spec.paths[spec.paths.length - 1].pts.slice(-1)[0];
    facts.flow = `replicator dynamics from ${i.flow.starts.length} starting mix(es); the last path ends at (${end.join(", ")}) after the simulated time. Describe whether paths spiral in, spiral out or cycle from what the picture shows.`;
  }
  for (const p of (i.points ?? []).slice(0, 8)) spec.points.push({ label: clean(p.label, 30), p: bary(p.p, `point "${clean(p.label, 20)}"`), ...(p.note ? { note: clean(p.note, 110) } : {}) });
  if (!spec.points.length && !spec.paths.length && !spec.regions.length) throw new CalcError("draw something inside the triangle: points, regions, paths or a flow");
  return { spec, facts };
}
