// econ.ts - deterministic calculators the instructor calls instead of doing arithmetic "in its head".
// Every function is pure and exhaustively tested against hand-derived answers (tests/econ.test.ts). The model decides WHICH calculation to
// run and explains the result; the numbers come from here. No eval, no Function(): expressions go through the small parser below.

const SIG = 10;
export const round = (x: number, d = 6): number => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
const fmt = (x: number): number => (Number.isFinite(x) ? Number(x.toPrecision(SIG)) : x);
export class CalcError extends Error { constructor(m: string) { super(m); this.name = "CalcError"; } }

// ---- safe arithmetic expression evaluator -----------------------------------------------------------------------------------------------------
// numbers (incl. 1e-3), + - * / ^ (right-associative, binds tighter than unary minus: -2^2 = -4), parentheses, constants pi and e,
// functions sqrt ln log10 exp abs min max pow round floor ceil. Max length 300, max nesting 40.
type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };
function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = src.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
    if (num) { out.push({ t: "num", v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const id = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (id) { out.push({ t: "id", v: id[0].toLowerCase() }); i += id[0].length; continue; }
    if ("+-*/^(),".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    if (c === "×" || c === "·") { out.push({ t: "op", v: "*" }); i++; continue; }
    if (c === "−") { out.push({ t: "op", v: "-" }); i++; continue; }
    throw new CalcError(`unexpected character "${c}"`);
  }
  return out;
}
const FN1: Record<string, (x: number) => number> = { sqrt: Math.sqrt, ln: Math.log, log10: Math.log10, exp: Math.exp, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil };
export function evaluate(src: string): number {
  if (src.length > 300) throw new CalcError("expression too long");
  const toks = tokenize(src); let p = 0, depth = 0;
  const peek = () => toks[p], eat = () => toks[p++];
  const isOp = (v: string) => { const t = peek(); return !!t && t.t === "op" && t.v === v; };
  function expr(): number { let v = term(); while (isOp("+") || isOp("-")) { const o = (eat() as { v: string }).v; const r = term(); v = o === "+" ? v + r : v - r; } return v; }
  function term(): number { let v = unary(); while (isOp("*") || isOp("/")) { const o = (eat() as { v: string }).v; const r = unary(); if (o === "/" && r === 0) throw new CalcError("division by zero"); v = o === "*" ? v * r : v / r; } return v; }
  function unary(): number { if (isOp("-")) { eat(); return -unary(); } if (isOp("+")) { eat(); return unary(); } return power(); }
  function power(): number { const b = atom(); if (isOp("^")) { eat(); const e = unary(); return b ** e; } return b; }
  function atom(): number {
    if (++depth > 40) throw new CalcError("nested too deeply");
    try {
      const t = eat(); if (!t) throw new CalcError("unexpected end");
      if (t.t === "num") return t.v;
      if (t.t === "op" && t.v === "(") { const v = expr(); if (!isOp(")")) throw new CalcError("missing )"); eat(); return v; }
      if (t.t === "id") {
        if (t.v === "pi") return Math.PI; if (t.v === "e") return Math.E;
        if (!isOp("(")) throw new CalcError(`unknown name "${t.v}"`);
        eat(); const args: number[] = [];
        if (!isOp(")")) { args.push(expr()); while (isOp(",")) { eat(); args.push(expr()); } }
        if (!isOp(")")) throw new CalcError("missing )"); eat();
        if (t.v in FN1 && args.length === 1) return FN1[t.v](args[0]);
        if (t.v === "min" && args.length >= 1) return Math.min(...args);
        if (t.v === "max" && args.length >= 1) return Math.max(...args);
        if (t.v === "pow" && args.length === 2) return args[0] ** args[1];
        throw new CalcError(`bad call to ${t.v}`);
      }
      throw new CalcError(`unexpected "${(t as { v: string }).v}"`);
    } finally { depth--; }
  }
  const v = expr();
  if (p < toks.length) throw new CalcError(`unexpected "${(peek() as { v: unknown }).v}"`);
  if (!Number.isFinite(v)) throw new CalcError("result is not a finite number");
  return v;
}

// ---- elasticity -------------------------------------------------------------------------------------------------------------------------------------
/** Midpoint (arc) elasticity between two points on a demand or supply curve: [(Q1-Q0)/avg(Q)] / [(P1-P0)/avg(P)]. */
export function midpointElasticity(p0: number, q0: number, p1: number, q1: number) {
  if (p0 + p1 === 0 || q0 + q1 === 0) throw new CalcError("midpoints must be non-zero");
  if (p1 === p0) throw new CalcError("the price did not change");
  const pctQ = (q1 - q0) / ((q0 + q1) / 2), pctP = (p1 - p0) / ((p0 + p1) / 2), e = pctQ / pctP;
  return { elasticity: fmt(e), abs_elasticity: fmt(Math.abs(e)), pct_change_quantity: fmt(pctQ * 100), pct_change_price: fmt(pctP * 100), category: category(e), method: "midpoint" };
}
/** Point elasticity from the slope dQ/dP at (P, Q): (dQ/dP) * P / Q. */
export function pointElasticity(price: number, quantity: number, slopeDQdP: number) {
  if (quantity === 0) throw new CalcError("quantity must be non-zero");
  const e = (slopeDQdP * price) / quantity;
  return { elasticity: fmt(e), abs_elasticity: fmt(Math.abs(e)), category: category(e), method: "point" };
}
function category(e: number): string { const a = Math.abs(e); return a > 1 + 1e-12 ? "elastic" : a < 1 - 1e-12 ? "inelastic" : "unit elastic"; }

// ---- linear supply and demand -----------------------------------------------------------------------------------------------------------------------
/** Demand Qd = a - b*P, supply Qs = c + d*P. Equilibrium, consumer and producer surplus. */
export function linearEquilibrium(a: number, b: number, c: number, d: number) {
  if (b <= 0) throw new CalcError("demand slope b must be positive (Qd = a - bP)");
  if (b + d === 0) throw new CalcError("no unique equilibrium: curves are parallel");
  const p = (a - c) / (b + d), q = a - b * p;
  if (p < 0 || q < 0) throw new CalcError("no positive equilibrium for these parameters");
  const cs = 0.5 * (a / b - p) * q;
  const ps = c >= 0 ? c * p + (d * p * p) / 2 : 0.5 * (p - -c / d) * q;
  return { price: fmt(p), quantity: fmt(q), consumer_surplus: fmt(cs), producer_surplus: fmt(ps), total_surplus: fmt(cs + ps), demand_choke_price: fmt(a / b) };
}

/** Small-country tariff in partial equilibrium: world price Pw, per-unit tariff t, Qd = a - bP, Qs = c + dP. */
export function smallCountryTariff(a: number, b: number, c: number, d: number, pw: number, t: number) {
  if (b <= 0 || d <= 0) throw new CalcError("slopes b and d must be positive");
  if (pw <= 0 || t < 0) throw new CalcError("world price must be positive and the tariff non-negative");
  const at = (p: number) => ({ qd: a - b * p, qs: c + d * p });
  const f = at(pw), g = at(pw + t);
  if (f.qd < 0 || f.qs < 0 || g.qd < 0 || g.qs < 0) throw new CalcError("these parameters give negative quantities");
  const importsFree = f.qd - f.qs, importsTariff = g.qd - g.qs;
  if (importsFree < 0) throw new CalcError("the country exports at the world price; use an export model");
  if (importsTariff < 0) throw new CalcError("the tariff is prohibitive (imports would be negative); the answer is autarky");
  const pt = pw + t;
  const dCS = -(0.5 * (f.qd + g.qd) * t);                                // loss of consumer surplus: trapezoid between the two prices under demand
  const dPS = 0.5 * (f.qs + g.qs) * t;                                   // gain of producer surplus: trapezoid under supply
  const revenue = t * importsTariff;
  const dwlProduction = 0.5 * t * (g.qs - f.qs), dwlConsumption = 0.5 * t * (f.qd - g.qd);
  return {
    domestic_price_with_tariff: fmt(pt), consumption_free: fmt(f.qd), production_free: fmt(f.qs), imports_free: fmt(importsFree),
    consumption_tariff: fmt(g.qd), production_tariff: fmt(g.qs), imports_tariff: fmt(importsTariff),
    change_consumer_surplus: fmt(dCS), change_producer_surplus: fmt(dPS), tariff_revenue: fmt(revenue),
    deadweight_loss_production: fmt(dwlProduction), deadweight_loss_consumption: fmt(dwlConsumption), deadweight_loss_total: fmt(dwlProduction + dwlConsumption),
    net_welfare_change: fmt(dCS + dPS + revenue),
  };
}

// ---- Cournot competition ----------------------------------------------------------------------------------------------------------------------------
/** Linear inverse demand P = a - b*Q, constant marginal costs c_i, no fixed costs. Firms whose interior quantity would be negative exit (q = 0). */
export function cournotLinear(a: number, b: number, costs: number[]) {
  if (b <= 0) throw new CalcError("slope b must be positive (P = a - bQ)");
  if (costs.length < 1 || costs.length > 10) throw new CalcError("between 1 and 10 firms");
  let active = costs.map((_, i) => i);
  for (let guard = 0; guard <= costs.length; guard++) {
    const n = active.length; if (n === 0) break;
    const sumC = active.reduce((s, i) => s + costs[i], 0), Q = (n * a - sumC) / (b * (n + 1));
    const q = costs.map(() => 0); let neg = false;
    for (const i of active) { q[i] = (a - costs[i] - b * Q) / b; if (q[i] < -1e-12) neg = true; }
    if (!neg) {
      const price = a - b * Q, profits = costs.map((c, i) => (price - c) * q[i]);
      if (price < 0) throw new CalcError("price would be negative; demand is too weak for these costs");
      return { firms: costs.length, quantities: q.map(fmt), total_quantity: fmt(Q), price: fmt(price), profits: profits.map(fmt), total_profit: fmt(profits.reduce((s, x) => s + x, 0)), consumer_surplus: fmt((Q * (a - price)) / 2), active_firms: n };
    }
    const worst = active.reduce((w, i) => (costs[i] > costs[w] ? i : w), active[0]);   // drop the highest-cost firm and re-solve
    active = active.filter((i) => i !== worst);
  }
  throw new CalcError("no Cournot equilibrium found");
}

// ---- game theory ------------------------------------------------------------------------------------------------------------------------------------
/** Pure-strategy Nash equilibria of an n x m bimatrix game. payoffs[i][j] = [row payoff, column payoff]. */
export function pureNash(payoffs: number[][][]) {
  const n = payoffs.length, m = payoffs[0]?.length ?? 0;
  if (n < 2 || n > 5 || m < 2 || m > 5 || payoffs.some((r) => r.length !== m || r.some((c) => c.length !== 2))) throw new CalcError("payoffs must be an n x m grid of [row, column] pairs with 2 to 5 strategies each");
  const eq: { row: number; col: number; payoffs: number[] }[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const rowBest = payoffs[i][j][0] >= Math.max(...payoffs.map((r) => r[j][0])), colBest = payoffs[i][j][1] >= Math.max(...payoffs[i].map((c) => c[1]));
    if (rowBest && colBest) eq.push({ row: i + 1, col: j + 1, payoffs: payoffs[i][j] });
  }
  const strictlyDominated = (player: 0 | 1) => {
    const out: number[] = []; const k = player === 0 ? n : m, l = player === 0 ? m : n;
    const u = (s: number, o: number) => (player === 0 ? payoffs[s][o][0] : payoffs[o][s][1]);
    for (let s = 0; s < k; s++) for (let t = 0; t < k; t++) if (s !== t && Array.from({ length: l }, (_, o) => u(t, o) > u(s, o)).every(Boolean)) { out.push(s + 1); break; }
    return out;
  };
  return { pure_nash_equilibria: eq, strictly_dominated_row_strategies: strictlyDominated(0), strictly_dominated_column_strategies: strictlyDominated(1), numbering: "strategies are numbered from 1 in the order given" };
}
/** Mixed-strategy equilibrium of a 2x2 game (interior, if one exists). p = P(row plays 1), q = P(column plays 1). */
export function mixed2x2(payoffs: number[][][]) {
  if (payoffs.length !== 2 || payoffs.some((r) => r.length !== 2)) throw new CalcError("mixed-strategy solver needs a 2x2 game");
  const A = (i: number, j: number) => payoffs[i][j][0], B = (i: number, j: number) => payoffs[i][j][1];
  const dq = A(0, 0) - A(0, 1) - A(1, 0) + A(1, 1), dp = B(0, 0) - B(1, 0) - B(0, 1) + B(1, 1);
  if (dq === 0 || dp === 0) return { interior_mixed_equilibrium: null, reason: "a player is never indifferent in a way that pins down a mixture" };
  const q = (A(1, 1) - A(0, 1)) / dq, p = (B(1, 1) - B(1, 0)) / dp;
  if (!(q > 0 && q < 1 && p > 0 && p < 1)) return { interior_mixed_equilibrium: null, reason: "the indifference mixtures fall outside (0,1), so there is no fully mixed equilibrium" };
  const vRow = q * A(0, 0) + (1 - q) * A(0, 1), vCol = p * B(0, 0) + (1 - p) * B(1, 0);
  return { interior_mixed_equilibrium: { row_prob_strategy_1: fmt(p), column_prob_strategy_1: fmt(q), expected_payoff_row: fmt(vRow), expected_payoff_column: fmt(vCol) } };
}
export function nash(payoffs: number[][][]) { return { ...pureNash(payoffs), ...(payoffs.length === 2 && payoffs[0].length === 2 ? mixed2x2(payoffs) : {}) }; }
