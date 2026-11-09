// diagrams.js - draws the two game-theory diagrams the server validated: a payoff matrix (normal-form game) and a game tree (extensive-form game).
// Like graph-render.js, the model never supplies markup: the spec holds short labels and numbers only, every string is escaped here, and the result
// contains no scripts, links or event handlers. In board mode (Talk) each reveal step is a <g class="wb-step" data-s="n" data-cap="...">; in chat mode all of it shows at once.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = (v) => typeof v === 'number' && isFinite(v) && Math.abs(v) <= 1e6;
const lab = (v) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v == null ? '' : v).slice(0, 12));
const okCell = (c) => Array.isArray(c) && c.length === 2 && c.every((v) => (typeof v === 'number' ? fin(v) : typeof v === 'string' && v.length <= 12));
const BOARD = { ink: '#f3f1e7', row: '#ffd966', col: '#8ed1fc', hi: '#b6f2a0', mute: 0.55, halo: '#15302c', pl: ['#ffd966', '#8ed1fc', '#ff9e9e', '#b6f2a0'] };
const CHAT = { ink: 'currentColor', row: '#c2410c', col: '#1f5fbf', hi: '#15803d', mute: 0.5, halo: 'none', pl: ['#c2410c', '#1f5fbf', '#7e22ce', '#15803d'] };

function group(o, st, n, cap, body) {
  if (o.board) return '<g class="wb-step" data-s="' + n + '" data-cap="' + esc(cap) + '">' + body + '</g>';
  return '<g>' + body + '</g>';
}

/** Payoff matrix. spec: { kind:'matrix', title?, row_player, col_player, row_labels[], col_labels[], cells[i][j]=[row,col], br_row[i][j], br_col[i][j], nash:[[i,j]], note? } */
export function matrixSvg(spec, o) {
  o = o || {}; var st = o.board ? BOARD : CHAT;
  if (!spec || spec.kind !== 'matrix' || !Array.isArray(spec.cells)) return null;
  var n = spec.cells.length, m = n ? spec.cells[0].length : 0;
  if (n < 2 || n > 5 || m < 2 || m > 5 || !Array.isArray(spec.row_labels) || !Array.isArray(spec.col_labels) || spec.row_labels.length !== n || spec.col_labels.length !== m) return null;
  var i, j;
  for (i = 0; i < n; i++) { if (!Array.isArray(spec.cells[i]) || spec.cells[i].length !== m) return null; for (j = 0; j < m; j++) if (!okCell(spec.cells[i][j])) return null; }
  var CW = 124, CH = 70, LW = 130, TH = 92, W = LW + CW * m + 20, H = TH + CH * n + (spec.note ? 52 : 28) + (spec.title ? 26 : 0), Y0 = TH + (spec.title ? 26 : 0);
  var ink = st.ink, out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(spec.title || 'Payoff matrix') + '" font-family="system-ui,sans-serif" font-size="14" fill="' + ink + '" style="max-width:100%;height:auto">'];
  var step = 0, rp = esc(spec.row_player || 'Row'), cp = esc(spec.col_player || 'Column');
  // 1: the grid, the players and their strategies
  var g = [];
  if (spec.title) g.push('<text x="' + W / 2 + '" y="20" text-anchor="middle" font-size="16" font-weight="600">' + esc(spec.title) + '</text>');
  g.push('<text x="' + (LW + CW * m / 2) + '" y="' + (Y0 - 62) + '" text-anchor="middle" font-weight="700" fill="' + st.col + '">' + cp + ' (columns)</text>');
  g.push('<text transform="rotate(-90)" x="' + -(Y0 + CH * n / 2) + '" y="18" text-anchor="middle" font-weight="700" fill="' + st.row + '">' + rp + ' (rows)</text>');
  for (j = 0; j < m; j++) g.push('<text x="' + (LW + CW * j + CW / 2) + '" y="' + (Y0 - 14) + '" text-anchor="middle" font-weight="600">' + esc(spec.col_labels[j]) + '</text>');
  for (i = 0; i < n; i++) g.push('<text x="' + (LW - 10) + '" y="' + (Y0 + CH * i + CH / 2 + 5) + '" text-anchor="end" font-weight="600">' + esc(spec.row_labels[i]) + '</text>');
  for (i = 0; i <= n; i++) g.push('<line x1="' + LW + '" y1="' + (Y0 + CH * i) + '" x2="' + (LW + CW * m) + '" y2="' + (Y0 + CH * i) + '" stroke="' + ink + '" stroke-width="2"/>');
  for (j = 0; j <= m; j++) g.push('<line x1="' + (LW + CW * j) + '" y1="' + Y0 + '" x2="' + (LW + CW * j) + '" y2="' + (Y0 + CH * n) + '" stroke="' + ink + '" stroke-width="2"/>');
  out.push(group(o, st, step++, '<b>The game.</b> ' + rp + ' chooses a row, ' + cp + ' chooses a column, and they choose at the same time.', g.join('')));
  // 2: the payoffs  (first number: row player, second: column player)
  var p = [];
  for (i = 0; i < n; i++) for (j = 0; j < m; j++) {
    var cx = LW + CW * j + CW / 2, cy = Y0 + CH * i + CH / 2 + 6, c = spec.cells[i][j];
    p.push('<text x="' + (cx - 24) + '" y="' + cy + '" text-anchor="middle" font-size="19" font-weight="700" fill="' + st.row + '">' + esc(lab(c[0])) + '</text><text x="' + cx + '" y="' + cy + '" text-anchor="middle" font-size="19">,</text><text x="' + (cx + 24) + '" y="' + cy + '" text-anchor="middle" font-size="19" font-weight="700" fill="' + st.col + '">' + esc(lab(c[1])) + '</text>');
  }
  out.push(group(o, st, step++, '<b>The payoffs.</b> In each cell the first number is ' + rp + '\'s payoff and the second is ' + cp + '\'s.', p.join('')));
  // 3 and 4: best responses (a ring around the payoff that is best given what the other player does)
  var hasBr = Array.isArray(spec.br_row) && Array.isArray(spec.br_col);
  if (hasBr) {
    var r = [], q = [];
    for (i = 0; i < n; i++) for (j = 0; j < m; j++) {
      var x = LW + CW * j + CW / 2, y = Y0 + CH * i + CH / 2;
      if (spec.br_row[i] && spec.br_row[i][j]) r.push('<ellipse cx="' + (x - 24) + '" cy="' + (y + 1) + '" rx="19" ry="15" fill="none" stroke="' + st.row + '" stroke-width="2.6"/>');
      if (spec.br_col[i] && spec.br_col[i][j]) q.push('<ellipse cx="' + (x + 24) + '" cy="' + (y + 1) + '" rx="19" ry="15" fill="none" stroke="' + st.col + '" stroke-width="2.6"/>');
    }
    out.push(group(o, st, step++, '<b>' + rp + '\'s best responses.</b> Within each column, the circled payoff is the best ' + rp + ' can do against that column.', r.join('')));
    out.push(group(o, st, step++, '<b>' + cp + '\'s best responses.</b> Within each row, the circled payoff is the best ' + cp + ' can do against that row.', q.join('')));
  }
  // 5: Nash equilibria = cells where both payoffs are circled
  var ne = (Array.isArray(spec.nash) ? spec.nash : []).filter(function (c) { return Array.isArray(c) && c[0] >= 0 && c[0] < n && c[1] >= 0 && c[1] < m; });
  if (hasBr) {
    var h = [];
    ne.forEach(function (c) { h.push('<rect x="' + (LW + CW * c[1] + 4) + '" y="' + (Y0 + CH * c[0] + 4) + '" width="' + (CW - 8) + '" height="' + (CH - 8) + '" rx="8" fill="' + st.hi + '" fill-opacity=".22" stroke="' + st.hi + '" stroke-width="3"/><text x="' + (LW + CW * c[1] + CW - 10) + '" y="' + (Y0 + CH * c[0] + 18) + '" text-anchor="end" font-size="12" font-weight="800" fill="' + st.hi + '">NE</text>'); });
    out.push(group(o, st, step++, ne.length ? '<b>Nash equilibrium.</b> The highlighted cell' + (ne.length > 1 ? 's are' : ' is') + ' where both payoffs are circled: neither player gains by switching alone.' : '<b>No pure-strategy Nash equilibrium.</b> No cell has both payoffs circled, so the equilibrium (if any) uses mixed strategies.', h.join('')));
  }
  if (spec.note) out.push('<text x="' + W / 2 + '" y="' + (H - 12) + '" text-anchor="middle" font-size="13" fill-opacity=".85">' + esc(spec.note) + '</text>');
  out.push('</svg>');
  return { svg: out.join(''), steps: step };
}

/** Game tree. spec: { kind:'tree', title?, players[], nodes:[{id, parent, edge, prob?, player?, payoff?, info?, spne?}] }  (nodes listed parents-first; the first node is the root) */
export function treeSvg(spec, o) {
  o = o || {}; var st = o.board ? BOARD : CHAT;
  if (!spec || spec.kind !== 'tree' || !Array.isArray(spec.nodes) || spec.nodes.length < 2 || spec.nodes.length > 40 || !Array.isArray(spec.players)) return null;
  var byId = {}, kids = {}, i;
  for (i = 0; i < spec.nodes.length; i++) { var nd = spec.nodes[i]; if (!nd || typeof nd.id !== 'string' || byId[nd.id]) return null; byId[nd.id] = nd; kids[nd.id] = []; }
  var root = spec.nodes[0];
  for (i = 1; i < spec.nodes.length; i++) { var c = spec.nodes[i]; if (!byId[c.parent]) return null; kids[c.parent].push(c); }
  var depthOf = {}, maxD = 0, leafN = 0, X = {};
  (function walk(nd, d) { depthOf[nd.id] = d; if (d > maxD) maxD = d; if (d > 7) return; var ks = kids[nd.id]; if (!ks.length) { X[nd.id] = leafN++; return; } ks.forEach(function (k) { walk(k, d + 1); }); var s = 0; ks.forEach(function (k) { s += X[k.id]; }); X[nd.id] = s / ks.length; })(root, 0);
  if (maxD > 7) return null;
  var DX = leafN > 8 ? 92 : 128, DY = 96, L = 40, T = spec.title ? 62 : 40, W = Math.max(360, L * 2 + DX * Math.max(1, leafN - 1) + 80), H = T + DY * maxD + 82;
  var px = function (id) { return L + 40 + X[id] * DX; }, py = function (id) { return T + depthOf[id] * DY; };
  var ink = st.ink, out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(spec.title || 'Game tree') + '" font-family="system-ui,sans-serif" font-size="14" fill="' + ink + '" style="max-width:100%;height:auto">'];
  if (spec.title) out.push('<text x="' + W / 2 + '" y="22" text-anchor="middle" font-size="16" font-weight="600">' + esc(spec.title) + '</text>');
  var pcol = function (name) { var k = spec.players.indexOf(name); return k < 0 ? st.ink : st.pl[k % st.pl.length]; };
  var step = 0, hasSpne = spec.nodes.some(function (nd) { return nd.spne; });
  // one reveal step per level: the decision nodes at that level, their moves, and where the moves lead
  for (var d = 0; d <= maxD; d++) {
    var body = [], caps = [];
    spec.nodes.forEach(function (nd) {
      if (depthOf[nd.id] !== d) return;
      var ks = kids[nd.id];
      if (d > 0) {                                  // the edge that arrives here, drawn from the parent
        var par = byId[nd.parent], x1 = px(par.id), y1 = py(par.id), x2 = px(nd.id), y2 = py(nd.id);
        body.push('<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + ink + '" stroke-width="2.4"/>');
        var lx = (x1 + x2) / 2, ly = (y1 + y2) / 2 - 4, left = x2 < x1 - 1, right = x2 > x1 + 1, anchor = left ? 'end' : right ? 'start' : 'middle';
        body.push('<text x="' + (lx + (left ? -6 : right ? 6 : 8)).toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="' + anchor + '" font-size="13" font-weight="700" paint-order="stroke" stroke="' + st.halo + '" stroke-width="3">' + esc(nd.edge || '') + (typeof nd.prob === 'number' ? ' (' + lab(nd.prob) + ')' : '') + '</text>');
      }
      if (ks.length) {
        var col = pcol(nd.player);
        body.push('<circle cx="' + px(nd.id).toFixed(1) + '" cy="' + py(nd.id).toFixed(1) + '" r="12" fill="' + col + '" stroke="' + ink + '" stroke-width="2"/><text x="' + px(nd.id).toFixed(1) + '" y="' + (py(nd.id) - 18).toFixed(1) + '" text-anchor="middle" font-size="13" font-weight="800" fill="' + col + '" paint-order="stroke" stroke="' + st.halo + '" stroke-width="3">' + esc(nd.player || '') + '</text>');
        caps.push('<b>' + esc(nd.player || 'Nature') + '</b> ' + (nd.player === 'Nature' ? 'moves by chance' : 'chooses') + ': ' + ks.map(function (k) { return esc(k.edge || ''); }).join(' or ') + '.');
      } else {
        var pay = Array.isArray(nd.payoff) ? nd.payoff : [], t = [];
        t.push('<circle cx="' + px(nd.id).toFixed(1) + '" cy="' + py(nd.id).toFixed(1) + '" r="4.5" fill="' + ink + '"/>');
        var yy = py(nd.id) + 24;
        pay.forEach(function (v, k) { t.push('<text x="' + px(nd.id).toFixed(1) + '" y="' + (yy + k * 17).toFixed(1) + '" text-anchor="middle" font-size="15" font-weight="700" fill="' + st.pl[k % st.pl.length] + '">' + esc(lab(v)) + '</text>'); });
        body.push(t.join(''));
        caps.push('The game ends with payoffs ' + pay.map(function (v) { return esc(lab(v)); }).join(', ') + '.');
      }
    });
    if (body.length) out.push(group(o, st, step++, d === 0 ? caps.join(' ') : '<b>Next.</b> ' + caps.slice(0, 3).join(' '), body.join('')));
  }
  // information sets: dashed bar joining decision nodes the player cannot tell apart
  var sets = {}; spec.nodes.forEach(function (nd) { if (nd.info && kids[nd.id].length) (sets[nd.info] = sets[nd.info] || []).push(nd); });
  var isb = [];
  Object.keys(sets).forEach(function (k) { var a = sets[k]; if (a.length < 2) return; var xs = a.map(function (nd) { return px(nd.id); }), y = py(a[0].id); isb.push('<line x1="' + (Math.min.apply(null, xs) - 6).toFixed(1) + '" y1="' + y.toFixed(1) + '" x2="' + (Math.max.apply(null, xs) + 6).toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="' + st.hi + '" stroke-width="4" stroke-dasharray="7 5" stroke-linecap="round" stroke-opacity=".85"/>'); });
  if (isb.length) out.push(group(o, st, step++, '<b>Information set.</b> The dashed bar joins decision points the player cannot tell apart: they must choose the same way at both.', isb.join('')));
  // backward induction: the path the equilibrium follows
  if (hasSpne) {
    var sp = [];
    spec.nodes.forEach(function (nd, k) { if (k > 0 && nd.spne) { var par = byId[nd.parent]; sp.push('<line x1="' + px(par.id).toFixed(1) + '" y1="' + py(par.id).toFixed(1) + '" x2="' + px(nd.id).toFixed(1) + '" y2="' + py(nd.id).toFixed(1) + '" stroke="' + st.hi + '" stroke-width="6" stroke-linecap="round" stroke-opacity=".5"/>'); } });
    out.push(group(o, st, step++, '<b>Backward induction.</b> Working from the end of the game, the highlighted moves are the optimal choice at every decision point; together they trace the equilibrium path.', sp.join('')));
  }
  out.push('<text x="' + W / 2 + '" y="' + (H - 10) + '" text-anchor="middle" font-size="12" fill-opacity=".8">Payoffs listed top to bottom: ' + spec.players.map(function (p) { return esc(p); }).join(', ') + '</text></svg>');
  return { svg: out.join(''), steps: step };
}
