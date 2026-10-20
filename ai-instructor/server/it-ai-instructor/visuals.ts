// visuals.ts - validation of what the instructor may ask the student's screen to draw. The model never sends HTML or SVG: only
// numbers and short labels (graphs) or a TeX string (equations), which the client renders with its own trusted code.
import { CalcError, evaluate } from "./econ.ts";
import { lookupFigure } from "./figures.ts";

export interface GraphSpec {
  kind: "graph"; title?: string; x_label: string; y_label: string; x_max?: number; y_max?: number;
  series: { label: string; points: [number, number][]; dashed?: boolean; note?: string }[];
  markers: { x: number; y: number; label: string; note?: string }[];
}
export interface EquationSpec { kind: "equation"; tex: string; caption?: string }
/** One of the textbook's own figures. Panels hold the book's SVG pieces grouped into reveal steps; the client sanitises them before drawing. */
export interface FigureSpec { kind: "figure"; num: string; title: string; caption: string; panels: { viewBox: string; steps: { label: string; svg: string }[] }[] }
export type VisualSpec = GraphSpec | EquationSpec | FigureSpec;

const clean = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u001f<>&"'`]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const LIM = 1e6;
const num = (v: unknown, what: string): number => { if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > LIM) throw new CalcError(`${what} must be a finite number below ${LIM}`); return v; };

export interface GraphInput {
  title?: string; x_label: string; y_label: string; x_max?: number; y_max?: number;
  series: { label: string; points?: number[][]; expr?: string; x_expr?: string; y_expr?: string; param?: string; from?: number; to?: number; dashed?: boolean; note?: string }[];
  markers?: { x?: number; y?: number; label: string; note?: string; intersect?: number[] }[];
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
  if (!i.series.length) throw new CalcError("1 or more curves");
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
  if (i.title) spec.title = clean(i.title, 80);
  if (i.x_max !== undefined) spec.x_max = num(i.x_max, "x_max");
  if (i.y_max !== undefined) spec.y_max = num(i.y_max, "y_max");
  return spec;
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
