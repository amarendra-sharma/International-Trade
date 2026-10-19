// visuals.ts - validation of what the instructor may ask the student's screen to draw. The model never sends HTML or SVG: only
// numbers and short labels (graphs) or a TeX string (equations), which the client renders with its own trusted code.
import { CalcError } from "./econ.ts";

export interface GraphSpec {
  kind: "graph"; title?: string; x_label: string; y_label: string; x_max?: number; y_max?: number;
  series: { label: string; points: [number, number][]; dashed?: boolean }[];
  markers: { x: number; y: number; label: string }[];
}
export interface EquationSpec { kind: "equation"; tex: string; caption?: string }
export type VisualSpec = GraphSpec | EquationSpec;

const clean = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u001f<>&"'`]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const LIM = 1e6;
const num = (v: unknown, what: string): number => { if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > LIM) throw new CalcError(`${what} must be a finite number below ${LIM}`); return v; };

export function graphSpec(i: { title?: string; x_label: string; y_label: string; x_max?: number; y_max?: number; series: { label: string; points: number[][]; dashed?: boolean }[]; markers?: { x: number; y: number; label: string }[] }): GraphSpec {
  if (!i.series.length) throw new CalcError("1 or more curves");
  // Oversized input is thinned rather than rejected, so a long point list still draws.
  const thin = <T,>(a: T[], n: number): T[] => { if (a.length <= n) return a; const out: T[] = []; for (let q = 0; q < n; q++) out.push(a[Math.round(q * (a.length - 1) / (n - 1))]); return out; };
  const series = i.series.slice(0, 6).map((s, k) => {
    if (s.points.length < 2) throw new CalcError(`curve ${k + 1} needs at least 2 points`);
    return { label: clean(s.label, 40), dashed: !!s.dashed, points: thin(s.points, 40).map((p, j) => { if (p.length !== 2) throw new CalcError(`point ${j + 1} of curve ${k + 1} must be [x, y]`); return [num(p[0], "x"), num(p[1], "y")] as [number, number]; }) };
  });
  const markers = (i.markers ?? []).slice(0, 8).map((m) => ({ x: num(m.x, "marker x"), y: num(m.y, "marker y"), label: clean(m.label, 30) }));
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
