/* ============================================================================
 * mn-reading.js — cheat-resistant reading verification for the MacroNations
 * textbook. Reading credit (it_chapter_progress.reading_done) is earned only by
 * genuine, attentive reading, not by scrolling, idling, or automation.
 *
 * How credit is gated (all must hold):
 *   1) ACTIVE DWELL per section. Each block of the chapter must be on-screen and
 *      read for a minimum time proportional to its length. Time accrues ONLY when
 *      the tab is visible, the window is focused, AND the reader has been active
 *      (scroll / pointer / key) within the last few seconds. => idling, background
 *      tabs, and blast-scrolling accrue nothing.
 *   2) REACHED THE END. The last block of the chapter must be dwelled on.
 *   3) COMPREHENSION CHECKPOINTS. Short questions embedded through the chapter must
 *      be answered correctly. => skimmers and agents that don't read can't pass.
 *
 * Only when 1–3 are all satisfied is reading_done written for that chapter.
 * Fail-open: if not signed in, or the DB is unreachable, the reader still works;
 * it just shows that credit could not be recorded.
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__mnReading) { return; }
  window.__mnReading = true;

  var SUPABASE_URL = 'https://rtaiivegcqqmdchpguzn.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_KCPCMiKYQoEUgG45DVF5uA_ke-UxQKm';

  // ---- comprehension checkpoints, per chapter (chapter 1 authored) ----
  // Each: {q, options:[...], answer: index, at: fraction 0..1 of the way through}.
  // Add more chapters here; a chapter with no checkpoints still requires dwell+end.
  var CHECKPOINTS = {
    1: [
      { at: 0.30, q: 'A country has a comparative advantage in the good for which it has the lower…',
        options: ['absolute cost', 'opportunity cost', 'wage', 'tariff'], answer: 1 },
      { at: 0.55, q: 'Home’s opportunity cost of one bolt of cloth is ½ cask of wine. To make one more bolt, Home must give up…',
        options: ['2 casks of wine', '1 cask of wine', '½ cask of wine', 'nothing'], answer: 2 },
      { at: 0.80, q: 'After specializing and trading, a country can reach a consumption point that lies…',
        options: ['inside its production frontier', 'exactly on its frontier', 'beyond (outside) its own frontier', 'below the origin'], answer: 2 },
      { at: 0.95, q: 'The “pauper-labor” fallacy is wrong because a country’s low wages mainly reflect its low…',
        options: ['tariffs', 'productivity', 'population', 'exchange rate'], answer: 1 }
    ]
  };

  var READ_WPM = 300;          // generous pace: you don't need to read every word slowly
  var MIN_MS_PER_BLOCK = 1400; // even short blocks need a moment of attention
  var ACTIVITY_WINDOW = 7000;  // ms since last human action to count as "active"
  var COMPLETE_FRAC = 0.95;    // dwell fraction required (plus end + checkpoints)

  var sbc = null, user = null, courseId = null;
  var chapter = null, blocks = [], reqTotal = 0, done = false, writing = false;
  var lastActivity = Date.now();
  var checkpointState = {};    // idx -> 'pending'|'passed'
  var chip = null;

  function ready(fn) { if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', fn); } else { fn(); } }
  function nowSec() { return Math.floor(Date.now() / 1000); }

  ['scroll', 'pointermove', 'wheel', 'keydown', 'pointerdown', 'touchmove'].forEach(function (ev) {
    window.addEventListener(ev, function (e) { if (!e || e.isTrusted !== false) { lastActivity = Date.now(); } }, { passive: true });
  });

  function visibleChapterSection() {
    var secs = document.querySelectorAll('section.chapter.page, section.chapter');
    for (var i = 0; i < secs.length; i++) {
      var s = secs[i];
      if (s.offsetParent !== null && !s.classList.contains('hidden')) { return s; }
    }
    return secs.length ? secs[0] : null;
  }
  function chapterNumberOf(sec) {
    if (!sec) { return null; }
    var m = (sec.id || '').match(/chapter-(\d+)/);
    if (m) { return Number(m[1]); }
    var d = sec.querySelector('[data-chapter]');
    return d ? Number(d.getAttribute('data-chapter')) : null;
  }

  function buildBlocks(sec) {
    // read units: substantive text/figure blocks, in document order.
    // Prefer direct children; if a chapter wraps its body, fall back to nested
    // blocks (excluding any block nested inside another selected block).
    var direct = ':scope > p, :scope > h3, :scope > h2, :scope > ul, :scope > ol, :scope > figure, :scope > div.box, :scope > blockquote, :scope > table';
    var nodes = sec.querySelectorAll(direct);
    if (nodes.length < 6) {
      var all = sec.querySelectorAll('p, h3, h2, ul, ol, figure, div.box, blockquote, table');
      nodes = Array.prototype.filter.call(all, function (n) {
        var p = n.parentElement;
        while (p && p !== sec) {
          if (p.matches && p.matches('p, ul, ol, figure, div.box, blockquote, table')) { return false; }
          p = p.parentElement;
        }
        return true;
      });
    }
    var out = [];
    Array.prototype.forEach.call(nodes, function (n) {
      var words = (n.innerText || n.textContent || '').trim().split(/\s+/).filter(Boolean).length;
      if (words < 3 && n.tagName !== 'FIGURE') { return; }   // skip tiny fragments
      var req = Math.max(MIN_MS_PER_BLOCK, Math.round(words / READ_WPM * 60000));
      out.push({ el: n, req: req, acc: 0, inView: false });
    });
    return out;
  }

  function insertCheckpoints() {
    var cps = CHECKPOINTS[chapter] || [];
    if (!cps.length || !blocks.length) { return; }
    cps.forEach(function (cp, idx) {
      checkpointState[idx] = 'pending';
      var pos = Math.min(blocks.length - 1, Math.max(0, Math.round(cp.at * (blocks.length - 1))));
      var anchor = blocks[pos].el;
      var box = document.createElement('div');
      box.className = 'mn-read-cp';
      box.setAttribute('data-cp', idx);
      box.style.cssText = 'border:1px solid var(--violet,#8b7cf6);border-left:4px solid var(--violet,#8b7cf6);border-radius:10px;padding:14px 16px;margin:18px 0;background:rgba(139,124,246,.06);';
      var opts = cp.options.map(function (o, k) {
        return '<button class="mn-cp-opt" data-k="' + k + '" style="display:block;width:100%;text-align:left;margin:6px 0;padding:9px 12px;border:1px solid var(--line2,#3a3f52);border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit;">' + o + '</button>';
      }).join('');
      box.innerHTML = '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--violet2,#a596ff);margin-bottom:6px;">Reading check ' + (idx + 1) + '</div>'
        + '<div style="font-weight:600;margin-bottom:8px;">' + cp.q + '</div>'
        + '<div class="mn-cp-opts">' + opts + '</div>'
        + '<div class="mn-cp-msg" style="font-size:13px;margin-top:6px;min-height:18px;"></div>';
      anchor.parentNode.insertBefore(box, anchor.nextSibling);
      box.querySelectorAll('.mn-cp-opt').forEach(function (b) {
        b.addEventListener('click', function () {
          if (checkpointState[idx] === 'passed') { return; }
          var k = Number(b.getAttribute('data-k'));
          var msg = box.querySelector('.mn-cp-msg');
          if (k === cp.answer) {
            checkpointState[idx] = 'passed';
            b.style.borderColor = 'var(--green,#39c07f)'; b.style.background = 'rgba(57,192,127,.14)';
            msg.style.color = 'var(--green,#39c07f)'; msg.textContent = 'Correct ✓';
            box.querySelectorAll('.mn-cp-opt').forEach(function (x) { x.disabled = true; x.style.cursor = 'default'; });
            update();
          } else {
            b.style.borderColor = 'var(--rose,#e5626b)';
            msg.style.color = 'var(--rose,#e5626b)'; msg.textContent = 'Not quite — re-read this section and try again.';
          }
        });
      });
    });
  }

  function allCheckpointsPassed() {
    var cps = CHECKPOINTS[chapter] || [];
    for (var i = 0; i < cps.length; i++) { if (checkpointState[i] !== 'passed') { return false; } }
    return true;
  }
  function endReached() {
    if (!blocks.length) { return false; }
    var last = blocks[blocks.length - 1];
    return last.acc >= Math.min(last.req, MIN_MS_PER_BLOCK);
  }
  function dwellFrac() {
    if (!reqTotal) { return 0; }
    var got = 0; blocks.forEach(function (b) { got += Math.min(b.acc, b.req); });
    return got / reqTotal;
  }

  function makeChip() {
    chip = document.createElement('div');
    chip.id = 'mn-read-chip';
    chip.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99997;background:var(--panel,#161b26);border:1px solid var(--line2,#3a3f52);border-radius:10px;padding:8px 12px;font-family:var(--sans,sans-serif);font-size:12.5px;color:var(--bright,#f4f7ff);box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:260px;';
    document.body.appendChild(chip);
  }
  function renderChip() {
    if (!chip) { return; }
    if (!user) { chip.innerHTML = '📖 Reading tracked — <a href="#" id="mnSignInHint" style="color:var(--violet2,#a596ff);">sign in</a> to earn credit'; return; }
    var pct = Math.round(dwellFrac() * 100);
    var cps = CHECKPOINTS[chapter] || [];
    var passed = cps.filter(function (_, i) { return checkpointState[i] === 'passed'; }).length;
    if (done) {
      chip.innerHTML = '✅ <b>Reading verified</b> — credit recorded for Chapter ' + chapter;
      return;
    }
    var cpline = cps.length ? (' · checks ' + passed + '/' + cps.length) : '';
    chip.innerHTML = '📖 Chapter ' + chapter + ' — read <b>' + pct + '%</b>' + cpline
      + '<div style="height:5px;background:var(--line,#2a2f3e);border-radius:3px;margin-top:5px;overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:var(--green,#39c07f);"></div></div>';
  }

  function update() {
    renderChip();
    if (done || !user || !courseId) { return; }
    if (dwellFrac() >= COMPLETE_FRAC && endReached() && allCheckpointsPassed()) {
      writeDone();
    }
  }

  function writeDone() {
    if (done || writing || !sbc || !user || !courseId) { return; }
    writing = true;
    var row = { student_id: user.id, course_id: courseId, chapter: chapter, reading_done: true, updated_at: new Date().toISOString() };
    sbc.from('it_chapter_progress').upsert(row, { onConflict: 'student_id,course_id,chapter' }).then(function (res) {
      writing = false;
      if (!res.error) { done = true; renderChip(); }
    }, function () { writing = false; });
  }

  // ---- per-chapter engine (re)start when the visible chapter changes ----
  var io = null, ticker = null, watch = null;
  function startChapter(sec) {
    chapter = chapterNumberOf(sec);
    if (!chapter) { return; }
    // reset
    if (io) { io.disconnect(); }
    document.querySelectorAll('.mn-read-cp').forEach(function (n) { n.remove(); });
    blocks = buildBlocks(sec);
    reqTotal = blocks.reduce(function (s, b) { return s + b.req; }, 0);
    checkpointState = {}; done = false;
    insertCheckpoints();
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var blk = blocks.filter(function (b) { return b.el === en.target; })[0];
        if (blk) { blk.inView = en.isIntersecting && en.intersectionRatio >= 0.4; }
      });
    }, { threshold: [0, 0.4, 1] });
    blocks.forEach(function (b) { io.observe(b.el); });
    // pre-mark this chapter done if the DB already says so
    if (sbc && user && courseId) {
      sbc.from('it_chapter_progress').select('reading_done').eq('student_id', user.id).eq('course_id', courseId).eq('chapter', chapter).maybeSingle().then(function (r) {
        if (r && r.data && r.data.reading_done) { done = true; }
        renderChip();
      }, function () {});
    }
    renderChip();
  }

  function tick() {
    if (!blocks.length) { return; }
    var active = (document.visibilityState === 'visible') && document.hasFocus() && (Date.now() - lastActivity < ACTIVITY_WINDOW);
    if (active) {
      blocks.forEach(function (b) { if (b.inView && b.acc < b.req) { b.acc += 500; } });
      update();
    }
  }

  function boot() {
    if (!(window.supabase && window.supabase.createClient)) { return; }
    try { sbc = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); } catch (e) { sbc = null; }
    makeChip();
    var sec = visibleChapterSection();
    if (sec) { startChapter(sec); }
    // resolve identity + course, then re-render
    if (sbc) {
      sbc.auth.getUser().then(function (res) {
        user = (res && res.data) ? res.data.user : null;
        if (!user) { renderChip(); return; }
        sbc.from('it_enrollments').select('course_id, it_courses(owner_id)').eq('student_id', user.id).eq('status', 'active').then(function (er) {
          var rows = (er && er.data) ? er.data : [];
          var prof = null, any = null;
          rows.forEach(function (r) { any = any || r; var o = r.it_courses ? r.it_courses.owner_id : null; if (o && o !== user.id && !prof) { prof = r; } });
          var chosen = prof || any;
          courseId = chosen ? chosen.course_id : null;
          if (sec) { startChapter(sec); }
          update();
        }, function () { renderChip(); });
      }, function () { renderChip(); });
    }
    // watch for chapter change (pagination shows/hides sections)
    watch = setInterval(function () {
      var s = visibleChapterSection();
      var n = chapterNumberOf(s);
      if (s && n && n !== chapter) { startChapter(s); update(); }
    }, 1200);
    ticker = setInterval(tick, 500);
  }

  ready(boot);
})();
