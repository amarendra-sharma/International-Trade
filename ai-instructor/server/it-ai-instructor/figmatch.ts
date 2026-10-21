// Chooses the textbook figure a question is about, on the server, so the picture can be put on the whiteboard BEFORE the model speaks.
// Keywords are hand-written per figure number; a figure is chosen only when it clearly beats the others.
import { FIGURES, lookupFigure, type FigureData } from "./figures.ts";

const KW: Record<string, string[]> = {
  "1.2": ["production possibilit", "ppf", "frontier", "opportunity cost"],
  "1.3": ["comparative advantage", "ricardo"],
  "1.4": ["consume beyond", "gains from trade", "ricardian"],
  "R1": ["consumer's optimum", "consumer optimum", "utility maximi"],
  "2.1": ["relative supply", "relative demand", "world relative"],
  "2.2": ["relative wage", "productivity ratio", "wage lands"],
  "2.4": ["chain of comparative", "continuum", "dornbusch"],
  "2.5": ["dornbusch", "dfs", "ricardian equilibrium", "continuum of goods"],
  "3.1": ["allocation of labor", "specific factors", "specific-factors", "labor allocation", "labor between sectors"],
  "3.2": ["price of manufactures", "price rise", "wage and rent"],
  "3.3": ["gains from trade", "indifference", "ppf and indifference"],
  "4.1": ["factor intensit", "capital intensive", "labor intensive"],
  "4.2": ["heckscher", "ohlin", "h-o", "factor abundan", "capital-abundant", "capital abundant"],
  "4.3": ["stolper", "samuelson", "goods prices determine factor", "magnification"],
  "4.4": ["lerner", "unit isoquant", "factor price equalization", "fpe"],
  "4.5": ["rybczynski"],
  "4.6": ["cone of diversification", "diversification cone"],
  "4.8": ["factor intensity reversal", "factor-intensity reversal", "intensity reversal"],
  "4.9": ["demand reversal"],
  "4.10": ["transport cost"],
  "4.11": ["intra-industry", "intra industry", "imperfect competition"],
  "4.12": ["technology difference", "break factor-price", "factor price equalization fail"],
  "4.13": ["complete specialization", "outside the cone"],
  "5.1": ["terms of trade", "world equilibrium"],
  "5.2": ["improvement in the terms of trade", "terms of trade improve", "terms of trade raise"],
  "5.3": ["decompos", "consumption gain", "production gain", "exchange gain"],
  "5.4": ["differences in tastes", "taste difference", "tastes"],
  "5.5": ["differences in technology", "technology difference", "technological difference"],
  "5.6": ["export-biased", "export biased", "immiserizing", "biased growth"],
  "5.7": ["export-biased growth", "growth on the frontier"],
  "5.8": ["small country tariff", "tariff lowers", "tariff small", "small-country tariff", "small country's welfare"],
  "5.9": ["export subsid"],
  "5.11": ["deriving the offer", "derive the offer", "offer curve derivation", "derive offer"],
  "5.12": ["offer curve", "offer curves", "reciprocal demand"],
  "5.13": ["elasticity of the offer", "offer curve elasticity", "marshall-lerner"],
  "6.1": ["monopolistic", "krugman"],
  "6.2": ["external economies", "head start", "economies of scale"],
  "7.1": ["melitz", "productivity cutoff", "heterogeneous firm", "firm heterogeneity", "profit lines"],
  "8.1": ["tariff", "deadweight", "welfare effects of a tariff", "welfare cost of a tariff"],
  "10.1": ["optimal tariff", "tariff and offer", "offer curves and the optimal", "offer curve tariff", "offer curve and tariff", "tariffs"],
  "11.1": ["trade creation", "trade diversion", "free trade area", "customs union"],
  "12.1": ["j-curve", "j curve"],
  "13.1": ["commodity terms of trade", "commodity price", "prebisch", "singer"],
  "14.1": ["large-country welfare", "large country welfare", "welfare as a function of the tariff"],
  "A.1": ["indifference map", "indifference curve"],
  "A.2": ["budget constraint", "budget line"],
  "A.3": ["consumer's optimum", "consumer optimum"],
  "A.4": ["isoquant"],
  "A.5": ["isocost"],
  "A.6": ["least-cost", "least cost", "cost minimi"],
  "A.7": ["edgeworth", "production box"],
  "A.8": ["contract curve"],
};
const INTENT = /\b(graph|diagram|figure|fig\.?|draw|plot|picture|illustrat|sketch|visual|chart|whiteboard|board|show me|curve)/i;

/** The figure the student is asking about, or null when nothing clearly matches. `strict` requires a drawing word in the request. */
export function matchFigure(text: string): FigureData | null {
  const t = String(text ?? "").toLowerCase().replace(/[’‘]/g, "'");
  if (t.length < 3) return null;
  const explicit = t.match(/\b(?:figure|fig\.?)\s*([a-z]?\.?\d+(?:\.\d+)?)/);
  if (explicit) { const f = lookupFigure(explicit[1]!); if (f) return f; }
  if (!INTENT.test(t)) return null;
  const scored: { f: FigureData; s: number }[] = [];
  for (const f of Object.values(FIGURES)) {
    let s = 0;
    for (const k of KW[f.num] ?? []) if (t.includes(k)) s += k.length >= 10 ? 3 : 2;
    const words = f.title.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 5);
    for (const w of words) if (t.includes(w)) s += 1;
    if (s) scored.push({ f, s });
  }
  if (/offer/.test(t) && /tariff/.test(t)) { const o = scored.find((x) => x.f.num === "10.1"); if (o) o.s += 4; else scored.push({ f: FIGURES["10.1"]!, s: 4 }); }
  scored.sort((a, b) => b.s - a.s);
  const top = scored[0], next = scored[1];
  if (!top || top.s < 2) return null;
  if (next && next.s >= top.s) return null;
  return top.f;
}
