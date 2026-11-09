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

/** Simplex (three-strategy triangle): corners are the pure strategies; every point inside is a mix. spec: { kind:'simplex', title?, corners[3], points[{label,p[3],note?}], paths[{label,pts[[3]],dashed?,note?}], regions[{label,pts[[3]],note?}] } */
export function simplexSvg(spec, o) {
  o = o || {}; var st = o.board ? BOARD : CHAT;
  if (!spec || spec.kind !== 'simplex' || !Array.isArray(spec.corners) || spec.corners.length !== 3) return null;
  var points = Array.isArray(spec.points) ? spec.points.slice(0, 8) : [], paths = Array.isArray(spec.paths) ? spec.paths.slice(0, 5) : [], regions = Array.isArray(spec.regions) ? spec.regions.slice(0, 4) : [];
  var okP = function (p) { return Array.isArray(p) && p.length === 3 && p.every(function (v) { return fin(v) && v >= -1e-6 && v <= 1 + 1e-6; }); };
  if (points.some(function (q) { return !q || !okP(q.p); }) || paths.some(function (q) { return !q || !Array.isArray(q.pts) || q.pts.length < 2 || q.pts.length > 130 || !q.pts.every(okP); }) || regions.some(function (q) { return !q || !Array.isArray(q.pts) || q.pts.length < 3 || q.pts.length > 12 || !q.pts.every(okP); })) return null;
  if (!points.length && !paths.length && !regions.length) return null;
  var W = 540, H = 480, TY = spec.title ? 78 : 58, BY = H - 62, TXc = W / 2, half = (BY - TY) / Math.sqrt(3);
  var V = [[TXc, TY], [TXc - half, BY], [TXc + half, BY]];
  var pos = function (p) { return [p[0] * V[0][0] + p[1] * V[1][0] + p[2] * V[2][0], p[0] * V[0][1] + p[1] * V[1][1] + p[2] * V[2][1]]; };
  var ink = st.ink, out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(spec.title || 'Strategy simplex') + '" font-family="system-ui,sans-serif" font-size="14" fill="' + ink + '" style="max-width:100%;height:auto">'];
  var step = 0, k, g = [];
  if (spec.title) g.push('<text x="' + W / 2 + '" y="24" text-anchor="middle" font-size="16" font-weight="600">' + esc(spec.title) + '</text>');
  [0.25, 0.5, 0.75].forEach(function (t) {
    [[0, 1, 2], [1, 2, 0], [2, 0, 1]].forEach(function (ax) {
      var a = [0, 0, 0], b = [0, 0, 0]; a[ax[0]] = t; a[ax[1]] = 1 - t; b[ax[0]] = t; b[ax[2]] = 1 - t;
      var A = pos(a), B = pos(b); g.push('<line x1="' + A[0].toFixed(1) + '" y1="' + A[1].toFixed(1) + '" x2="' + B[0].toFixed(1) + '" y2="' + B[1].toFixed(1) + '" stroke="' + ink + '" stroke-opacity=".14"/>');
    });
  });
  g.push('<polygon points="' + V.map(function (v) { return v[0].toFixed(1) + ',' + v[1].toFixed(1); }).join(' ') + '" fill="none" stroke="' + ink + '" stroke-width="2.4"/>');
  g.push('<text x="' + V[0][0] + '" y="' + (V[0][1] - 12) + '" text-anchor="middle" font-weight="700">' + esc(spec.corners[0]) + '</text>');
  g.push('<text x="' + (V[1][0] - 6) + '" y="' + (V[1][1] + 22) + '" text-anchor="middle" font-weight="700">' + esc(spec.corners[1]) + '</text>');
  g.push('<text x="' + (V[2][0] + 6) + '" y="' + (V[2][1] + 22) + '" text-anchor="middle" font-weight="700">' + esc(spec.corners[2]) + '</text>');
  out.push(group(o, st, step++, '<b>The triangle.</b> Each corner is a pure strategy (' + spec.corners.map(esc).join(', ') + '); the closer a point is to a corner, the larger that share. The grid lines mark quarters.', g.join('')));
  regions.forEach(function (r, n) {
    var P = r.pts.map(pos), c = st.pl[n % st.pl.length], cx = P.reduce(function (s, p) { return s + p[0]; }, 0) / P.length, cy = P.reduce(function (s, p) { return s + p[1]; }, 0) / P.length;
    out.push(group(o, st, step++, '<b>' + esc(r.label) + '.</b> ' + esc(r.note || ''), '<polygon points="' + P.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '" fill="' + c + '" fill-opacity=".25" stroke="' + c + '" stroke-width="2.4"/><text x="' + cx.toFixed(1) + '" y="' + cy.toFixed(1) + '" text-anchor="middle" font-weight="700" fill="' + c + '" paint-order="stroke" stroke="' + st.halo + '" stroke-width="3">' + esc(r.label) + '</text>'));
  });
  paths.forEach(function (r, n) {
    var P = r.pts.map(pos), c = st.pl[(n + regions.length) % st.pl.length], d = P.map(function (p, j) { return (j ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' '), e = P[P.length - 1], f = P[Math.max(0, P.length - 3)];
    var ang = Math.atan2(e[1] - f[1], e[0] - f[0]), ah = [[e[0], e[1]], [e[0] - 11 * Math.cos(ang - 0.45), e[1] - 11 * Math.sin(ang - 0.45)], [e[0] - 11 * Math.cos(ang + 0.45), e[1] - 11 * Math.sin(ang + 0.45)]];
    out.push(group(o, st, step++, '<b>' + esc(r.label) + '.</b> ' + esc(r.note || ''), '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"' + (r.dashed ? ' stroke-dasharray="8 6"' : '') + '/><polygon points="' + ah.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '" fill="' + c + '"/><circle cx="' + P[0][0].toFixed(1) + '" cy="' + P[0][1].toFixed(1) + '" r="4" fill="' + c + '"/>'));
  });
  points.forEach(function (q) {
    var P = pos(q.p);
    out.push(group(o, st, step++, '<b>' + esc(q.label) + '.</b> ' + esc(q.note || ''), '<circle cx="' + P[0].toFixed(1) + '" cy="' + P[1].toFixed(1) + '" r="6" fill="' + st.hi + '" stroke="' + ink + '" stroke-width="1.5"/><text x="' + (P[0] + 10).toFixed(1) + '" y="' + (P[1] - 8).toFixed(1) + '" font-weight="700" paint-order="stroke" stroke="' + st.halo + '" stroke-width="3">' + esc(q.label) + '</text>'));
  });
  out.push('</svg>');
  return { svg: out.join(''), steps: step };
}
