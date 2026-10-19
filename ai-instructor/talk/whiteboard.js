// whiteboard.js - the instructor's blackboard. It sits between the instructor and the chat in Talk mode, draws what the server validated (a graph
// spec or an equation spec) and reveals it ONE STEP AT A TIME, in step with what the instructor is saying: axes first, then each curve drawn on,
// then each marked point. Every string is escaped and every number re-checked here; the model never supplies markup.
var CSS = [
'.mnai-board{order:1;display:flex;flex-direction:column;min-width:0;background:#15302c;color:#f3f1e7;border:7px solid #7b5b3a;border-radius:12px;box-shadow:inset 0 0 40px rgba(0,0,0,.45),0 6px 20px rgba(0,0,0,.4);padding:8px 10px 10px}',
'.mnai-board[hidden]{display:none}',
'.mnai-board-head{display:flex;align-items:center;gap:8px;font:600 13px system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#cfd8c6;opacity:.85;margin-bottom:6px}',
'.mnai-board-head span{flex:1}.mnai-board-head button{min-height:28px;border-radius:6px;border:1px solid #6f8a80;background:transparent;color:#cfd8c6;font:inherit;text-transform:none;letter-spacing:0;padding:0 8px;cursor:pointer}',
'.mnai-board-body{flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px;align-items:stretch}',
'.mnai-board svg{width:100%;height:auto;max-height:56vh;display:block}',
'.wb-step{opacity:0;transition:opacity .45s ease}.wb-step.on{opacity:1}',
'.wb-draw{stroke-dasharray:1;stroke-dashoffset:1;transition:stroke-dashoffset 1.4s ease-in-out}.wb-step.on .wb-draw{stroke-dashoffset:0}',
'.wb-lab{opacity:0;transition:opacity .5s ease 1.1s}.wb-step.on .wb-lab{opacity:1}',
'.wb-pop circle{transform-box:fill-box;transform-origin:center;transform:scale(0);transition:transform .45s cubic-bezier(.3,1.7,.5,1) .35s}.wb-step.on .wb-pop circle{transform:scale(1)}',
'.wb-guide{stroke-dasharray:1;stroke-dashoffset:1;transition:stroke-dashoffset .6s ease}.wb-step.on .wb-guide{stroke-dashoffset:0}',
'.wb-eq{opacity:0;transform:translateY(8px);transition:opacity .5s ease,transform .5s ease;font-size:1.25em;text-align:center;padding:6px 4px;overflow-x:auto}.wb-eq.on{opacity:1;transform:none}',
'.wb-eq .eq-caption{font-size:.62em;color:#cfd8c6;margin-top:4px}',
'@media (prefers-reduced-motion:reduce){.wb-step,.wb-draw,.wb-lab,.wb-pop circle,.wb-guide,.wb-eq{transition:none!important}}',
'@media (min-width:860px){.mnai.mnai-has-board{grid-template-columns:minmax(0,.8fr) minmax(0,1.35fr) minmax(0,.95fr)}.mnai.mnai-has-board>.mnai-stage{grid-column:1}.mnai.mnai-has-board>.mnai-board{grid-column:2;grid-row:1/span 4}.mnai.mnai-has-board>:not(.mnai-stage):not(.mnai-board){grid-column:3}}'
].join('\n');
var CHALK = ['#ffd966', '#8ed1fc', '#ff9e9e', '#b6f2a0', '#d9b3ff', '#ffc58a'];
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var fin = function (v) { return typeof v === 'number' && isFinite(v) && Math.abs(v) <= 1e6; };
function niceStep(range, target) { var raw = range / Math.max(1, target), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; }
var fmt = function (v) { return String(Math.round(v * 100) / 100); };

/** Builds the SVG string for a graph spec. Each reveal step is a <g class="wb-step" data-s="n">. Returns { svg, steps } or null. */
export function graphBoardSvg(spec, uid) {
  if (!spec || spec.kind !== 'graph' || !Array.isArray(spec.series) || !spec.series.length || spec.series.length > 6) return null;
  var W = 520, H = 360, L = 58, R = 20, T = spec.title ? 38 : 18, B = 52, pw = W - L - R, ph = H - T - B, xs = [0], ys = [0], i, j;
  for (i = 0; i < spec.series.length; i++) {
    var pts = spec.series[i].points; if (!Array.isArray(pts) || pts.length < 2 || pts.length > 80) return null;
    for (j = 0; j < pts.length; j++) { if (!Array.isArray(pts[j]) || !fin(pts[j][0]) || !fin(pts[j][1])) return null; xs.push(pts[j][0]); ys.push(pts[j][1]); }
  }
  var markers = (spec.markers || []).filter(function (m) { return m && fin(m.x) && fin(m.y); }).slice(0, 8);
  markers.forEach(function (m) { xs.push(m.x); ys.push(m.y); });
  var xmax = fin(spec.x_max) && spec.x_max > 0 ? spec.x_max : Math.max.apply(null, xs), ymax = fin(spec.y_max) && spec.y_max > 0 ? spec.y_max : Math.max.apply(null, ys);
  var xmin = Math.min(0, Math.min.apply(null, xs)), ymin = Math.min(0, Math.min.apply(null, ys));
  if (xmax <= xmin) xmax = xmin + 1; if (ymax <= ymin) ymax = ymin + 1;
  var sx = function (x) { return L + ((x - xmin) / (xmax - xmin)) * pw; }, sy = function (y) { return T + ph - ((y - ymin) / (ymax - ymin)) * ph; };
  var ink = '#f3f1e7', n = 0, o = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(spec.title || (spec.y_label + ' versus ' + spec.x_label)) + '" font-family="system-ui,sans-serif" font-size="13" fill="' + ink + '">'];
  o.push('<defs><clipPath id="wbc' + uid + '"><rect x="' + L + '" y="' + T + '" width="' + pw + '" height="' + ph + '"/></clipPath></defs>');
  // step 0: the axes, grid, title and axis names
  o.push('<g class="wb-step" data-s="' + (n++) + '">');
  if (spec.title) o.push('<text x="' + W / 2 + '" y="22" text-anchor="middle" font-size="16" font-weight="600">' + esc(spec.title) + '</text>');
  var xt = niceStep(xmax - xmin, 6), yt = niceStep(ymax - ymin, 5), v;
  for (v = Math.ceil(xmin / xt) * xt; v <= xmax + 1e-9; v += xt) o.push('<line x1="' + sx(v).toFixed(1) + '" y1="' + T + '" x2="' + sx(v).toFixed(1) + '" y2="' + (T + ph) + '" stroke="' + ink + '" stroke-opacity=".12"/><text x="' + sx(v).toFixed(1) + '" y="' + (T + ph + 18) + '" text-anchor="middle" fill-opacity=".8">' + fmt(v) + '</text>');
  for (v = Math.ceil(ymin / yt) * yt; v <= ymax + 1e-9; v += yt) o.push('<line x1="' + L + '" y1="' + sy(v).toFixed(1) + '" x2="' + (L + pw) + '" y2="' + sy(v).toFixed(1) + '" stroke="' + ink + '" stroke-opacity=".12"/><text x="' + (L - 8) + '" y="' + (sy(v) + 4).toFixed(1) + '" text-anchor="end" fill-opacity=".8">' + fmt(v) + '</text>');
  o.push('<path d="M' + L + ' ' + T + ' L' + L + ' ' + (T + ph) + ' L' + (L + pw) + ' ' + (T + ph) + '" fill="none" stroke="' + ink + '" stroke-width="2"/>');
  o.push('<text x="' + (L + pw / 2) + '" y="' + (H - 10) + '" text-anchor="middle" font-weight="600">' + esc(spec.x_label) + '</text>');
  o.push('<text transform="rotate(-90)" x="' + -(T + ph / 2) + '" y="16" text-anchor="middle" font-weight="600">' + esc(spec.y_label) + '</text></g>');
  // one step per curve: drawn on, then its name fades in
  spec.series.forEach(function (s, k) {
    var d = s.points.map(function (p, m) { return (m ? 'L' : 'M') + sx(p[0]).toFixed(1) + ' ' + sy(p[1]).toFixed(1); }).join(' '), c = CHALK[k % CHALK.length], last = s.points[s.points.length - 1];
    o.push('<g class="wb-step" data-s="' + (n++) + '"><path class="wb-draw" pathLength="1" d="' + d + '" fill="none" stroke="' + c + '" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#wbc' + uid + ')"' + (s.dashed ? ' stroke-dasharray="none"' : '') + '/>');
    o.push('<text class="wb-lab" x="' + Math.min(L + pw - 2, sx(last[0]) + 6).toFixed(1) + '" y="' + Math.max(T + 14, sy(last[1]) - 6).toFixed(1) + '" text-anchor="' + (sx(last[0]) > L + pw - 70 ? 'end' : 'start') + '" fill="' + c + '" font-weight="700" font-size="14">' + esc(s.label) + '</text></g>');
  });
  // one step per marked point: guide lines, then the dot pops in
  markers.forEach(function (m) {
    o.push('<g class="wb-step" data-s="' + (n++) + '"><line class="wb-guide" pathLength="1" x1="' + sx(m.x).toFixed(1) + '" y1="' + sy(m.y).toFixed(1) + '" x2="' + sx(m.x).toFixed(1) + '" y2="' + (T + ph) + '" stroke="' + ink + '" stroke-opacity=".7" stroke-dasharray="1"/>');
    o.push('<line class="wb-guide" pathLength="1" x1="' + L + '" y1="' + sy(m.y).toFixed(1) + '" x2="' + sx(m.x).toFixed(1) + '" y2="' + sy(m.y).toFixed(1) + '" stroke="' + ink + '" stroke-opacity=".7"/>');
    o.push('<g class="wb-pop"><circle cx="' + sx(m.x).toFixed(1) + '" cy="' + sy(m.y).toFixed(1) + '" r="6" fill="#fff5b0"/></g><text class="wb-lab" x="' + (sx(m.x) + 10).toFixed(1) + '" y="' + (sy(m.y) - 10).toFixed(1) + '" fill="#fff5b0" font-weight="700" font-size="14">' + esc(m.label) + '</text></g>');
  });
  o.push('</svg>');
  return { svg: o.join(''), steps: n };
}

export function Whiteboard(doc, opts) {
  opts = opts || {};
  this.doc = doc; this.uid = 0; this.steps = []; this.next = 0; this.baseline = 0; this.armed = false; this.onVisibility = opts.onVisibility || function () {};
  if (!doc.getElementById('mnai-board-styles')) { var st = doc.createElement('style'); st.id = 'mnai-board-styles'; st.textContent = CSS; doc.head.appendChild(st); }
  var el = this.el = doc.createElement('div'); el.className = 'mnai-board'; el.hidden = true; el.setAttribute('aria-label', 'Whiteboard'); el.setAttribute('role', 'region');
  var head = doc.createElement('div'); head.className = 'mnai-board-head';
  var title = doc.createElement('span'); title.textContent = 'Whiteboard';
  var hide = doc.createElement('button'); hide.type = 'button'; hide.textContent = 'Hide'; var self = this; hide.addEventListener('click', function () { self._show(false); });
  head.append(title, hide);
  this.body = doc.createElement('div'); this.body.className = 'mnai-board-body';
  el.append(head, this.body);
}
Whiteboard.prototype._show = function (on) { this.el.hidden = !on; this.onVisibility(on); };
/** New student question: wipe the board. */
Whiteboard.prototype.reset = function () { if (this._fb) (this.doc.defaultView || window).clearTimeout(this._fb); this.body.textContent = ''; this.steps = []; this.next = 0; this.armed = false; this.baseline = 0; this._show(false); };
/**
 * A drawing arrived from the server. `baseline` is how many sentences had already been queued for speech (they come BEFORE the drawing);
 * the board then advances one step for each LATER sentence the instructor starts to say.
 */
Whiteboard.prototype.add = function (spec, katex, baseline) {
  var d = this.doc, ok = false;
  if (spec && spec.kind === 'graph') {
    var g = graphBoardSvg(spec, ++this.uid);
    if (g) {
      var holder = d.createElement('div'); holder.innerHTML = g.svg;           // built only from escaped strings and checked numbers
      var base = this.steps.length;
      holder.querySelectorAll('[data-s]').forEach(function (n) { this.steps.push(n); }, this);
      this.body.appendChild(holder); ok = this.steps.length > base;
    }
  } else if (spec && spec.kind === 'equation' && typeof spec.tex === 'string' && spec.tex.length <= 300) {
    var box = d.createElement('div'); box.className = 'wb-eq';
    try { if (!katex) throw new Error('no katex'); katex.render(spec.tex, box, { trust: false, throwOnError: true, displayMode: true, strict: 'error', maxSize: 20, maxExpand: 200 }); } catch (e) { box.textContent = spec.tex; }
    if (spec.caption) { var c = d.createElement('div'); c.className = 'eq-caption'; c.textContent = spec.caption; box.appendChild(c); }
    this.steps.push(box); this.body.appendChild(box); ok = true;
  }
  if (!ok) return false;
  if (!this.armed) {
    this.armed = true; this.baseline = baseline || 0; this._saw = false; this._show(true);
    var self = this, w = this.doc.defaultView || window;
    if (this._fb) w.clearTimeout(this._fb);
    this._fb = w.setTimeout(function () { if (!self._saw) self.finish(); }, 12000);     // no voice (muted device, text only): never leave the board half drawn
  }      // the board opens blank, like a teacher stepping up to it; the first sentence she says after that draws the first step
  return true;
};
Whiteboard.prototype.advance = function () {
  var s = this.steps[this.next]; if (!s) return false;
  this.next++;
  var self = this; (this.doc.defaultView || window).requestAnimationFrame(function () { s.classList.add('on'); try { s.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ok */ } void self; });
  return true;
};
/** The instructor has just started saying sentence number `index` (1-based within this answer). */
Whiteboard.prototype.onSentence = function (index) { if (this.armed && index > this.baseline) { this._saw = true; this.advance(); } };
/** The instructor has finished: show whatever is left so the board is always complete. */
Whiteboard.prototype.finish = function () { while (this.advance()) { /* reveal the rest */ } };
