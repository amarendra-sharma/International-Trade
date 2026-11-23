/* mn-selfstudy.js — paid self-study with Asha, shared by the MacroNations course consoles that
   load it (International Trade, Game Theory). Same behaviour as the Financial Derivatives /
   Micro / Macro consoles, where it is built inline.

   Each paying student gets a private section, owned by the administrator, that Asha teaches on
   the schedule the student chooses. Server side: <prefix>_selfstudy_* RPCs.

   The console calls, once its supabase client and State exist:
     MNSelfStudy.init({
       sb, prefix:'it', name:'International Trade', chapters:14, arenas:11,
       state: function(){ return State; },           // .user .role .guest .settings .selfCourseId .payCourseId
       loadSettings: loadPlatformSettings,            // -> Promise, fills State.settings (stripe_link)
       refresh: function(){ ... },                    // -> Promise, after payment/scheduling (reload course state)
       courseTable:'it_courses', examTable:'it_exams',
       proctorTable:'it_proctor_events',              // or an array: exam records and quiz records kept in separate tables
       quizTable:'it_ss_proctor_events',              // where the self-study quiz integrity records go (default: proctorTable)
       consentOnly: false,                            // true: quizGate only runs the camera check-in; the console starts MNProctor itself
       quizExamId: function(ch, cid){ ... },          // integrity-record id of a self-study chapter quiz
       compute: function(courseId, uid){ ... },       // optional -> Promise {comps,total}, same as the student's My progress
       threshold: 0.70,
       openCourse: function(courseId){ ... },         // admin "Open"
       payRef: function(uid, cid){ ... },             // optional: Stripe client_reference_id (default uid + '__' + cid)
       arenaWord: 'labs'                              // optional: what the course calls its arenas
     });
   and then: mountHome(el), mountAdmin(el), bodyLink(m, style)/wireBodies(el), quizGate(...), quizDone(),
   prefetch(cid), isSelfStudyCached(cid), handleSignupParam(fn). */
(function (global) {
  'use strict';
  var C = null;
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var LAB = { awaiting_payment: 'Awaiting payment', awaiting_setup: 'Paid — choosing schedule', active: 'Active', completed: 'Completed', cancelled: 'Cancelled' };
  var flags = {};      // course id -> is self-study
  var bodies = {};     // material id -> {title, body}

  function $(id) { return document.getElementById(id); }
  function esc(s) { if (s === null || s === undefined) { return ''; } return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function money(cents, cur) {
    var a = (cents || 0) / 100;
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: (cur || 'usd').toUpperCase(), minimumFractionDigits: a % 1 ? 2 : 0 }).format(a); }
    catch (e) { return '$' + a.toFixed(2); }
  }
  function S() { return C.state(); }
  function rpc(name, args) { return C.sb.rpc(C.prefix + '_selfstudy_' + name, args || {}); }
  function fmt(ts, tz) { try { return new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || undefined }); } catch (e) { return new Date(ts).toLocaleString(); } }
  function fmtDate(ts, tz) { try { return new Date(ts).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: tz || undefined }); } catch (e) { return new Date(ts).toLocaleDateString(); } }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function addDays(s, k) { var p = s.split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2] + k); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function msg(el, text, err) { if (!el) { return; } el.className = 'msg' + (err ? ' err' : ''); el.style.display = 'inline-block'; el.textContent = text; }
  function modal(inner, wide) {
    var host = $('modalHost') || document.body;
    var bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal" style="max-width:' + (wide || 760) + 'px;width:94vw;">' + inner + '</div>';
    host.appendChild(bg);
    var close = function () { if (bg.parentNode) { bg.parentNode.removeChild(bg); } };
    bg.addEventListener('click', function (e) { if (e.target === bg) { close(); } });
    return { el: bg, close: close };
  }

  function reason(r, d) {
    var m = {
      not_paid: 'Your payment has not been confirmed yet.',
      already_started: 'Your first class has already taken place, so the schedule can no longer be changed. Ask the administrator if you need a change.',
      bad_weeks: 'Choose one of the durations listed.', bad_minutes: 'Choose a class length between 30 and 120 minutes.',
      bad_tz: 'That time zone was not recognized.', bad_time: 'Enter a valid start time.', bad_days: 'Choose at least one day of the week.',
      bad_start: 'The first day must be between today and 30 days from now.',
      too_few_classes: 'This schedule gives only ' + (d && d.classes != null ? d.classes : 'a few') + ' live classes; at least 12 are needed to cover the ' + C.chapters + ' chapters. Add a day per week or choose a longer duration.',
      too_many_classes: 'This schedule gives more than 120 classes; choose fewer days per week or a shorter duration.',
      disabled: 'Self-study is not open at the moment.', staff: 'Instructor and administrator accounts cannot enroll in self-study; use a student account.',
      no_admin: 'Self-study is not configured yet.', closed: 'This self-study course has ended.'
    };
    return m[r] || ('Something went wrong (' + r + ').');
  }
  function countClasses(weeks, startStr, days, timeStr) {
    if (!startStr || !days.length) { return 0; }
    var p = startStr.split('-'), start = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])), n = 0, now = Date.now(), last = weeks * 7 - 7, i;
    for (i = 0; i <= last; i++) {
      var d = new Date(start.getTime() + i * 86400000);
      if (days.indexOf(d.getUTCDay()) < 0) { continue; }
      if (i === 0) { var hm = (timeStr || '00:00').split(':'); var t = new Date(); t.setHours(+hm[0], +hm[1], 0, 0); if (startStr === today() && t.getTime() < now + 15 * 60000) { continue; } }
      n++;
    }
    return n;
  }
  function payLink(st) {
    var s = S(), base = s.settings ? s.settings.stripe_link : '';
    if (!base || !s.user || !st.course_id) { return ''; }
    var sep = base.indexOf('?') >= 0 ? '&' : '?';
    var ref = C.payRef ? C.payRef(s.user.id, st.course_id) : (s.user.id + '__' + st.course_id);
    return base + sep + 'client_reference_id=' + encodeURIComponent(ref) + '&prefilled_email=' + encodeURIComponent(s.user.email || '');
  }
  function aw() { return C.arenaWord || 'arenas'; }
  function AW() { var w = aw(); return w.charAt(0).toUpperCase() + w.slice(1); }
  function tables() { var t = C.proctorTable; return Array.isArray(t) ? t : [t]; }
  function refresh() { try { return Promise.resolve(C.refresh ? C.refresh() : null); } catch (e) { return Promise.resolve(); } }

  /* ---------------- student Home card ---------------- */
  function mountHome(host) {
    if (!host || !C) { return; }
    var s = S();
    if (s.guest || !s.user || s.role === 'professor' || s.role === 'instructor' || s.role === 'admin') { host.innerHTML = ''; return; }
    rpc('status').then(function (res) {
      var st = res && res.data ? res.data : null;
      if (!st || res.error) { host.innerHTML = ''; return; }
      s.selfStudy = st;
      card(host, st);
    }, function () { host.innerHTML = ''; });
  }
  function card(host, st) {
    var s = S();
    var price = st.price_cents ? money(st.price_cents, st.currency || 'usd') : '';
    var head = '<div class="card" style="margin-bottom:18px;border-left:4px solid var(--violet);">';
    if (st.status === 'none') {
      if (!st.enabled || s.payCourseId) { host.innerHTML = ''; return; }   // already in a professor's course
      host.innerHTML = head + '<div class="c-eyebrow">Self-study</div><h3 style="margin:4px 0 8px;">Take the whole course with Asha, your AI professor</h3>' +
        '<p style="color:var(--text-muted);font-size:14px;margin:0 0 12px;">You choose how many weeks the course lasts and when your live classes meet. Asha then teaches every chapter in live classes on your schedule, sets your quiz and arena deadlines, runs the midterm and final, grades your work, and answers questions at any hour. All ' + C.chapters + ' chapters and ' + C.arenas + ' ' + aw() + ' are included, with proctored quizzes and exams and a MacroNations certificate when you finish' + (price ? ', for ' + esc(price) : '') + '.</p>' +
        '<button class="btn btn-primary" id="ssStart">Start self-study</button> <a class="btn btn-ghost" href="self-study.html" target="_blank" rel="noopener">See everything included</a> <span id="ssMsg" class="msg" style="display:inline-block;margin-left:8px;"></span></div>';
      $('ssStart').addEventListener('click', function () {
        $('ssStart').disabled = true;
        rpc('start').then(function (r) {
          var d = r && r.data ? r.data : {};
          if (r.error || d.ok === false) { $('ssStart').disabled = false; msg($('ssMsg'), r.error ? r.error.message : reason(d.reason, d), true); return; }
          card(host, d);
        });
      });
      return;
    }
    if (st.status === 'awaiting_payment') {
      if (!s.settings || !s.settings.stripe_link) { if (C.loadSettings && !host._loadedSettings) { host._loadedSettings = true; Promise.resolve(C.loadSettings()).then(function () { card(host, st); }); } }
      var link = payLink(st);
      host.innerHTML = head + '<div class="c-eyebrow">Self-study · step 1 of 2</div><h3 style="margin:4px 0 8px;">Pay the course fee</h3>' +
        '<p style="color:var(--text-muted);font-size:14px;margin:0 0 12px;">After payment you will choose your course length and your live-class times. Payments are confirmed automatically, usually within an hour. <a href="self-study.html" target="_blank" rel="noopener" style="color:var(--violet);">What&rsquo;s included</a></p>' +
        (link ? '<a class="btn btn-primary" href="' + esc(link) + '" target="_blank" rel="noopener">Pay ' + esc(price || 'now') + '</a> ' : '<div class="msg err" style="display:block;">The payment link is not configured yet.</div>') +
        '<button class="btn btn-ghost" id="ssCheck">I have paid — check now</button> <span id="ssMsg" class="msg" style="display:inline-block;margin-left:8px;"></span></div>';
      $('ssCheck').addEventListener('click', function () {
        $('ssCheck').disabled = true;
        rpc('check_payment').then(function (r) {
          $('ssCheck').disabled = false;
          var d = r && r.data ? r.data : {};
          if (d.status && d.status !== 'awaiting_payment') { refresh().then(function () { card(host, d); }); return; }
          msg($('ssMsg'), 'Not confirmed yet. Payments usually appear within an hour; this page also checks for you.');
        });
      });
      return;
    }
    if (st.status === 'awaiting_setup' || (st.status === 'active' && host.getAttribute('data-edit') === '1')) { wizard(host, st); return; }
    if (st.status === 'active') {
      var dayNames = (st.days || []).map(function (x) { return DAYS[x]; }).join(', ');
      host.innerHTML = head + '<div class="c-eyebrow">Self-study with Asha</div><h3 style="margin:4px 0 8px;">' + esc(st.weeks + '-week course · ' + st.classes + ' live classes') + '</h3>' +
        '<div style="font-size:14px;line-height:1.7;">' +
        (st.next_at ? '<div><b>Next live class:</b> ' + esc(st.next_title || '') + ' — ' + esc(fmt(st.next_at, st.tz)) + '</div>' : '') +
        '<div><b>Class times:</b> ' + esc(dayNames) + ' at ' + esc(st.start_local) + ' (' + esc(st.tz) + '), ' + esc(String(st.minutes)) + ' minutes</div>' +
        (st.midterm ? '<div><b>Midterm:</b> ' + esc(fmt(st.midterm.opens, st.tz)) + ' – ' + esc(fmt(st.midterm.closes, st.tz)) + '</div>' : '') +
        (st.final ? '<div><b>Final:</b> ' + esc(fmt(st.final.opens, st.tz)) + ' – ' + esc(fmt(st.final.closes, st.tz)) + '</div>' : '') +
        '<div><b>Course ends:</b> ' + esc(fmtDate(st.ends_at, st.tz)) + '</div><div style="font-size:12px;color:var(--text-subtle);">Times are shown in ' + esc(st.tz) + '.</div></div>' +
        '<p style="color:var(--text-muted);font-size:13px;margin:10px 0 0;">Open the AI Instructor at class time to join Asha’s live class. Read each chapter before its class; quizzes and ' + aw() + ' are due three days after the chapter is finished.</p>' +
        (!st.started ? '<button class="btn btn-ghost btn-sm" id="ssEdit" style="margin-top:10px;">Change my schedule</button>' : '') + '</div>';
      if ($('ssEdit')) { $('ssEdit').addEventListener('click', function () { host.setAttribute('data-edit', '1'); card(host, st); }); }
      return;
    }
    host.innerHTML = head + '<div class="c-eyebrow">Self-study with Asha</div><h3 style="margin:4px 0 8px;">Your self-study course has ended</h3><p style="color:var(--text-muted);font-size:14px;margin:0;">Your grades remain available under My progress.</p></div>';
  }
  function wizard(host, st) {
    var tz = st.tz || ((typeof Intl !== 'undefined' && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC');
    var t0 = today(), weeks = st.weeks || 8, days = st.days || [1, 3], startT = st.start_local || '19:00', mins = st.minutes || 60;
    var startD = st.starts_on && st.starts_on >= t0 ? st.starts_on : addDays(t0, 1);
    var wk = [4, 6, 8, 10, 12, 16].map(function (w) { return '<option value="' + w + '"' + (w === weeks ? ' selected' : '') + '>' + w + ' weeks</option>'; }).join('');
    var mn = [30, 45, 60, 75, 90, 120].map(function (m) { return '<option value="' + m + '"' + (m === mins ? ' selected' : '') + '>' + m + ' minutes</option>'; }).join('');
    var dy = DAYS.map(function (n, i) { return '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:14px;cursor:pointer;"><input type="checkbox" class="ssDay" value="' + i + '"' + (days.indexOf(i) >= 0 ? ' checked' : '') + ' style="width:auto;">' + n + '</label>'; }).join('');
    host.innerHTML = '<div class="card" style="margin-bottom:18px;border-left:4px solid var(--violet);"><div class="c-eyebrow">Self-study · step 2 of 2</div>' +
      '<h3 style="margin:4px 0 8px;">Choose your course length and live-class schedule</h3>' +
      '<p style="color:var(--text-muted);font-size:14px;margin:0 0 12px;">Asha spreads the ' + C.chapters + ' chapters over your classes, with the last week kept for the final exam. Classes are live with Asha; you can ask questions during class and at any other time.</p>' +
      '<div class="row2"><div class="field"><label>Course length</label><select id="ssWeeks">' + wk + '</select></div>' +
      '<div class="field"><label>First day</label><input type="date" id="ssStartD" min="' + t0 + '" max="' + addDays(t0, 30) + '" value="' + startD + '"></div></div>' +
      '<div class="field"><label>Class days</label><div>' + dy + '</div></div>' +
      '<div class="row2"><div class="field"><label>Class start time</label><input type="time" id="ssTime" value="' + esc(startT) + '"></div>' +
      '<div class="field"><label>Class length</label><select id="ssMins">' + mn + '</select></div></div>' +
      '<div class="field"><label>Time zone</label><input id="ssTz" value="' + esc(tz) + '" placeholder="e.g. America/New_York"></div>' +
      '<div id="ssPreview" style="font-size:14px;margin:6px 0 12px;"></div>' +
      '<button class="btn btn-primary" id="ssConfirm">Confirm my schedule</button>' +
      (st.status === 'active' ? ' <button class="btn btn-ghost" id="ssCancelEdit">Keep my current schedule</button>' : '') +
      ' <span id="ssMsg" class="msg" style="display:inline-block;margin-left:8px;"></span></div>';
    function chosen() { var out = []; Array.prototype.forEach.call(host.querySelectorAll('.ssDay'), function (c) { if (c.checked) { out.push(+c.value); } }); return out; }
    function preview() {
      var w = +$('ssWeeks').value, n = countClasses(w, $('ssStartD').value, chosen(), $('ssTime').value);
      var ok = n >= 12 && n <= 120;
      $('ssPreview').innerHTML = (ok ? '✅ ' : '⚠️ ') + '<b>' + n + ' live classes</b> of ' + $('ssMins').value + ' minutes over ' + w + ' weeks' +
        (n < 12 ? ' — at least 12 are needed; add a day or choose a longer course.' : (n >= 24 ? ', including a midterm review and a final review.' : '.'));
      $('ssConfirm').disabled = !ok;
    }
    Array.prototype.forEach.call(host.querySelectorAll('select,input'), function (el) { el.addEventListener('change', preview); el.addEventListener('input', preview); });
    preview();
    if ($('ssCancelEdit')) { $('ssCancelEdit').addEventListener('click', function () { host.removeAttribute('data-edit'); card(host, st); }); }
    $('ssConfirm').addEventListener('click', function () {
      $('ssConfirm').disabled = true;
      msg($('ssMsg'), 'Asha is preparing your course…');
      rpc('configure', { p_weeks: +$('ssWeeks').value, p_start_date: $('ssStartD').value, p_days: chosen(), p_start: $('ssTime').value, p_minutes: +$('ssMins').value, p_tz: $('ssTz').value.trim() }).then(function (r) {
        var d = r && r.data ? r.data : {};
        if (r.error || d.ok === false) { $('ssConfirm').disabled = false; msg($('ssMsg'), r.error ? r.error.message : reason(d.reason, d), true); return; }
        host.removeAttribute('data-edit');
        refresh().then(function () { card(host, d); });
      });
    });
  }

  /* ---------------- materials with their own body (the syllabus Asha posts) ---------------- */
  function bodyLink(m, style) {
    if (m && m.body) {
      bodies[m.id] = { title: m.title, body: m.body };
      return '<a href="#" data-matbody="' + esc(m.id) + '" style="' + (style || '') + '">' + esc(m.title) + '</a>';
    }
    return '<a href="' + esc(m.url) + '" target="_blank" rel="noopener" style="' + (style || '') + '">' + esc(m.title) + '</a>';
  }
  function wireBodies(host) {
    if (!host) { return; }
    Array.prototype.forEach.call(host.querySelectorAll('[data-matbody]'), function (a) {
      if (a._ssw) { return; } a._ssw = true;
      a.addEventListener('click', function (ev) { ev.preventDefault(); openBody(a.getAttribute('data-matbody')); });
    });
  }
  function openBody(id) {
    var m = bodies[id]; if (!m) { return; }
    var css = '<style>body{font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2937;margin:22px;}h1{font-size:21px;margin:0 0 8px;}h2{font-size:16px;margin:22px 0 6px;color:#4c3aa8;}' +
      'table{border-collapse:collapse;width:100%;font-size:13px;}th,td{border:1px solid #d6d3e6;padding:5px 8px;text-align:left;vertical-align:top;}th{background:#f3f0ff;}ul{padding-left:20px;}li{margin:3px 0;}' +
      '@media print{body{margin:0;}h2{break-after:avoid;}tr{break-inside:avoid;}}</style>';
    var md = modal('<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;"><h2 style="margin:0;">' + esc(m.title) + '</h2>' +
      '<span class="inline-actions"><button class="btn btn-ghost btn-sm" id="matBodyPrint">Print / save as PDF</button><button class="btn btn-primary btn-sm" id="matBodyClose">Close</button></span></div>' +
      '<iframe id="matBodyFrame" sandbox="allow-same-origin allow-modals" style="width:100%;height:70vh;border:1px solid var(--border);border-radius:8px;background:#fff;"></iframe>', 860);
    var fr = $('matBodyFrame');
    fr.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(m.title) + '</title>' + css + '</head><body>' + m.body + '</body></html>';
    $('matBodyClose').addEventListener('click', md.close);
    $('matBodyPrint').addEventListener('click', function () { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) {} });
  }

  /* ---------------- camera-proctored graded quizzes in self-study sections ---------------- */
  function prefetch(cid) {
    if (!cid || !C || flags[cid] !== undefined) { return; }
    C.sb.from(C.courseTable).select('is_self_study').eq('id', cid).maybeSingle().then(function (r) {
      if (r && !r.error) { flags[cid] = !!(r.data && r.data.is_self_study); }
    }, function () {});
  }
  function isSelfStudyCached(cid) { return flags[cid]; }
  /* Call at the top of the console's graded-quiz start. Returns true when it has taken over
     (self-study section): it shows the camera check-in, starts monitoring, then calls proceed().
     When the flag is not known yet it looks it up first and then either takes over or calls proceed(). */
  function quizGate(area, chapter, cid, proceed) {
    if (!C || !cid) { return false; }
    if (flags[cid] === false) { return false; }
    if (flags[cid] === undefined) {
      if (area) { area.innerHTML = '<div class="card"><span class="spinner"></span> &nbsp;Preparing your quiz…</div>'; }
      C.sb.from(C.courseTable).select('is_self_study').eq('id', cid).maybeSingle().then(function (r) {
        flags[cid] = !!(r && r.data && r.data.is_self_study);
        if (area) { area.innerHTML = ''; }
        if (flags[cid]) { cameraQuiz(area, chapter, cid, proceed); } else { proceed(); }
      }, function () { if (area) { area.innerHTML = ''; } proceed(); });
      return true;
    }
    cameraQuiz(area, chapter, cid, proceed);
    return true;
  }
  function cameraQuiz(area, chapter, cid, proceed) {
    var P = global.MNProctor;
    if (!P || !P.runConsent) {
      if (area) { area.innerHTML = '<div class="card"><div class="msg err" style="display:block;">This quiz is proctored on camera, but the monitoring component failed to load. Please hard-refresh the page; the quiz will not start unmonitored.</div></div>'; }
      return;
    }
    var s = S();
    var cfg = { id: C.quizExamId(chapter, cid), course_id: cid, proctored: true, camera_mode: 'block', sessionLabel: 'quiz' };
    if (C.quizTable) { cfg.table = C.quizTable; }
    global.__mnpUserId = s.user.id;
    P.runConsent(cfg, area, function () {
      if (area) { area.innerHTML = ''; }
      if (C.consentOnly) { proceed(); return; }
      P.onAutoSubmit(function () {
        var sub = null;
        Array.prototype.forEach.call((area || document).querySelectorAll('button'), function (b) { if (/^Submit/i.test((b.textContent || '').trim()) && !b.disabled) { sub = b; } });
        if (sub) { sub.click(); }
      });
      P.start(cfg, s.user);
      proceed();
    }, function () { if (area) { area.innerHTML = ''; } });
  }
  /* Call after a graded quiz has been submitted successfully: saves the integrity record and ends monitoring. */
  function quizDone() { var P = global.MNProctor; if (P && P.isActive && P.isActive()) { return P.finish(); } return Promise.resolve(); }

  /* ---------------- administrator: Platform page ---------------- */
  var adminHost = null;
  function mountAdmin(host) {
    if (!host || !C) { return; }
    adminHost = host;
    host.innerHTML = '<div class="card" style="margin-bottom:18px;"><h3>Self-study students</h3>' +
      '<p style="font-size:12.5px;color:var(--text-muted);margin:0 0 10px;">Each paying student gets a private ' + esc(C.name) + ' section that only administrators can see; Asha teaches it on the schedule the student chose. Professors never see these sections.</p>' +
      '<div id="ssKeyBox" style="margin-bottom:12px;"></div><div id="ssList"><span class="spinner"></span></div></div>';
    keyBox($('ssKeyBox'));
    rpc('admin_list').then(function (r) {
      var box = $('ssList'); if (!box) { return; }
      if (r.error) { box.textContent = r.error.message; return; }
      var rows = r.data || [];
      if (!rows.length) { box.innerHTML = '<div style="color:var(--text-muted);">No self-study students yet.</div>'; return; }
      overview(box, rows);
    }, function () { var b = $('ssList'); if (b) { b.textContent = 'Could not load self-study students.'; } });
  }
  function keyBox(el) {
    if (!el) { return; }
    rpc('key_owner_get').then(function (r) {
      var d = r && r.data ? r.data : {};
      el.innerHTML = '<div style="font-size:13px;">Asha&rsquo;s AI usage for these sections is billed to: <b>' + esc(d.email || 'not set') + '</b>' +
        (d.owner && !d.has_key ? ' <span class="msg err" style="display:inline-block;">that account has no saved AI key</span>' : '') + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:6px;"><input id="ssKeyEmail" placeholder="email of an account with a saved AI key" style="max-width:320px;"><button class="btn btn-ghost btn-sm" id="ssKeySave">Change</button><span id="ssKeyMsg" class="msg"></span></div>';
      $('ssKeySave').addEventListener('click', function () {
        rpc('key_owner_set', { p_email: $('ssKeyEmail').value }).then(function (x) {
          var dd = x && x.data ? x.data : {};
          if (x.error || dd.ok === false) { msg($('ssKeyMsg'), x.error ? x.error.message : (dd.reason === 'no_key' ? 'That account has no saved AI key.' : 'No account with that email.'), true); return; }
          keyBox(el);
        });
      });
    }, function () { el.innerHTML = ''; });
  }
  function overview(host, rows) {
    var started = rows.filter(function (x) { return x.status === 'active' || x.status === 'completed'; });
    var stripe = rows.filter(function (x) { return x.paid_by && x.paid_by !== 'admin' && x.paid_by !== 'waiver'; }).length;
    var st = S(), price = st.settings && st.settings.price_cents ? st.settings.price_cents : 0;
    var thr = C.threshold || 0.7;
    var tile = function (id, label, val) { return '<div style="flex:1;min-width:120px;border:1px solid var(--border);border-radius:10px;padding:10px 12px;"><div style="font-size:11px;color:var(--text-subtle);text-transform:uppercase;letter-spacing:1px;">' + label + '</div><div id="' + id + '" style="font-size:22px;color:var(--text-bright, inherit);">' + val + '</div></div>'; };
    host.innerHTML =
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">' +
      tile('ssTStudents', 'Students', rows.length) +
      tile('ssTActive', 'Active', rows.filter(function (x) { return x.status === 'active'; }).length) +
      tile('ssTPending', 'Not started', rows.filter(function (x) { return x.status === 'awaiting_payment' || x.status === 'awaiting_setup'; }).length) +
      tile('ssTAvg', 'Average total', C.compute ? '…' : '—') +
      tile('ssTCert', 'At certificate level', C.compute ? '…' : '—') +
      tile('ssTRev', 'Paid via Stripe', stripe + (price ? ' <span style="font-size:13px;color:var(--text-muted);">≈ ' + esc(money(stripe * price, (st.settings && st.settings.currency) || 'usd')) + '</span>' : '')) +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:10px;flex-wrap:wrap;">' +
      '<div style="font-size:12px;color:var(--text-muted);">Totals use the course weights with untaken exams counted as 0, exactly as the student sees them. The certificate needs ' + Math.round(thr * 100) + '%.</div>' +
      '<button class="btn btn-ghost btn-sm" id="ssCsv">Download CSV</button></div>' +
      '<div style="overflow-x:auto;"><table class="tbl" style="width:100%;font-size:12.5px;"><tr><th align="left">Student</th><th align="left">Status</th><th>Classes</th><th>Reading</th><th>Quizzes</th><th>' + AW() + '</th><th>Attend.</th><th>Midterm</th><th>Final</th><th>Total</th><th>Flags</th><th align="left">Ends</th><th></th></tr>' +
      rows.map(function (x) {
        var live = x.status === 'active' || x.status === 'completed';
        var cell = function (k) { return '<td align="center" data-ssc="' + x.course_id + ':' + k + '">' + (live ? '<span style="color:var(--text-subtle);">…</span>' : '—') + '</td>'; };
        return '<tr><td>' + esc(x.name || x.email || x.student_id) + (x.email && x.name ? '<div style="font-size:11px;color:var(--text-subtle);">' + esc(x.email) + '</div>' : '') + '</td>' +
          '<td>' + esc(LAB[x.status] || x.status) + (x.paid_by ? '<div style="font-size:11px;color:var(--text-subtle);">' + esc(x.paid_by === 'admin' ? 'comped' : (x.paid_by === 'waiver' ? 'fee waived' : 'Stripe')) + '</div>' : '') +
          (x.weeks ? '<div style="font-size:11px;color:var(--text-subtle);">' + x.weeks + ' weeks</div>' : '') + '</td>' +
          '<td align="center">' + (x.classes ? (x.held + ' / ' + x.classes) : '—') + (x.next_at ? '<div style="font-size:10.5px;color:var(--text-subtle);">' + esc(new Date(x.next_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</div>' : '') + '</td>' +
          cell('reading') + cell('quizzes') + cell('arenas') + cell('attendance') + cell('midterm') + cell('final') + cell('total') + cell('flags') +
          '<td>' + (x.ends_at ? esc(new Date(x.ends_at).toLocaleDateString()) : '—') + '</td>' +
          '<td style="white-space:nowrap;">' + (x.status === 'awaiting_payment' ? '<button class="btn btn-ghost btn-sm" data-sscomp="' + x.course_id + '">Comp (free)</button> ' : '') +
          (x.status === 'active' && !x.held ? '<button class="btn btn-ghost btn-sm" data-ssreset="' + x.course_id + '">Let student reschedule</button> ' : '') +
          (live ? '<button class="btn btn-ghost btn-sm" data-ssintg="' + x.course_id + '">Integrity</button> ' : '') +
          (C.openCourse ? '<button class="btn btn-ghost btn-sm" data-ssopen="' + x.course_id + '">Open</button>' : '') + '</td></tr>';
      }).join('') + '</table></div>';
    var on = function (sel, fn) { Array.prototype.forEach.call(host.querySelectorAll('[' + sel + ']'), function (b) { b.addEventListener('click', function (ev) { ev.preventDefault(); fn(b.getAttribute(sel)); }); }); };
    on('data-sscomp', function (id) { rpc('admin_comp', { p_course: id }).then(function () { mountAdmin(adminHost); }); });
    on('data-ssreset', function (id) { rpc('admin_reset', { p_course: id }).then(function () { mountAdmin(adminHost); }); });
    on('data-ssintg', integrity);
    on('data-ssopen', function (id) { C.openCourse(id); });

    var stats = {};
    var put = function (cid, k, html) { var td = host.querySelector('[data-ssc="' + cid + ':' + k + '"]'); if (td) { td.innerHTML = html; } };
    var pct = function (v) { return (v === null || v === undefined) ? '—' : Math.round(v * 100) + '%'; };
    var ids = started.map(function (x) { return x.course_id; });
    var flagsP = ids.length ? Promise.all(tables().map(function (t) { return C.sb.from(t).select('course_id,violations').in('course_id', ids); })).then(function (rs) {
      var f = {}; rs.forEach(function (r) { (r.data || []).forEach(function (e) { f[e.course_id] = (f[e.course_id] || 0) + (e.violations || 0); }); });
      ids.forEach(function (cid) {
        var n = f[cid] || 0; (stats[cid] = stats[cid] || {}).flags = n;
        put(cid, 'flags', n ? '<a href="#" data-ssflag="' + cid + '" style="color:var(--amber, #f59e0b);font-weight:600;">' + n + '</a>' : '<span style="color:var(--text-subtle);">0</span>');
      });
      on('data-ssflag', integrity);
    }, function () {}) : Promise.resolve();
    var gradeP = Promise.all(started.map(function (x) {
      if (!C.compute) { ['reading', 'quizzes', 'arenas', 'attendance', 'midterm', 'final', 'total'].forEach(function (k) { put(x.course_id, k, '—'); }); return null; }
      return Promise.resolve(C.compute(x.course_id, x.student_id)).then(function (res) {
        var s2 = stats[x.course_id] = stats[x.course_id] || {};
        if (!res) { ['reading', 'quizzes', 'arenas', 'attendance', 'midterm', 'final', 'total'].forEach(function (k) { put(x.course_id, k, '—'); }); return; }
        (res.comps || []).forEach(function (c) {
          var label = String(c[0] || ''), isExam = (c[3] === true || c[3] === false);
          var k = label === 'Reading' ? 'reading' : label === 'Quizzes' ? 'quizzes' : (label === 'Arenas' || label === 'Labs') ? 'arenas' : label === 'Attendance' ? 'attendance' :
            (isExam && /final/i.test(label)) ? 'final' : (isExam ? 'midterm' : null);
          if (!k) { return; }
          s2[k] = c[3] === true ? null : c[1];
          put(x.course_id, k, c[3] === true ? '<span style="color:var(--text-subtle);" title="Not taken yet">—</span>' : pct(c[1]));
        });
        ['reading', 'quizzes', 'arenas', 'attendance', 'midterm', 'final'].forEach(function (k) { if (!(k in s2)) { put(x.course_id, k, '<span style="color:var(--text-subtle);">—</span>'); } });
        s2.total = res.total;
        var ok = res.total >= thr;
        put(x.course_id, 'total', '<b style="color:' + (ok ? 'var(--green, #34d399)' : 'inherit') + ';">' + pct(res.total) + '</b>' + (ok ? '<div style="font-size:10.5px;color:var(--green, #34d399);">certificate</div>' : ''));
      }, function () { put(x.course_id, 'total', '?'); });
    }));
    Promise.all([gradeP, flagsP]).then(function () {
      if (!C.compute) { return; }
      var totals = started.map(function (x) { return stats[x.course_id] && stats[x.course_id].total; }).filter(function (v) { return typeof v === 'number'; });
      var avg = totals.length ? totals.reduce(function (a, b) { return a + b; }, 0) / totals.length : null;
      if ($('ssTAvg')) { $('ssTAvg').textContent = avg === null ? '—' : Math.round(avg * 100) + '%'; }
      if ($('ssTCert')) { $('ssTCert').textContent = totals.filter(function (v) { return v >= thr; }).length + ' of ' + started.length; }
    });
    $('ssCsv').addEventListener('click', function () {
      var head = ['Student', 'Email', 'Status', 'Paid by', 'Weeks', 'Starts', 'Ends', 'Classes held', 'Classes total', 'Reading %', 'Quizzes %', AW() + ' %', 'Attendance %', 'Midterm %', 'Final %', 'Total %', 'Certificate', 'Integrity flags'];
      var q = function (v) { v = (v === null || v === undefined) ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var p = function (v) { return (typeof v === 'number') ? Math.round(v * 1000) / 10 : ''; };
      var lines = [head.join(',')].concat(rows.map(function (x) {
        var s3 = stats[x.course_id] || {};
        return [x.name || '', x.email || '', LAB[x.status] || x.status, x.paid_by || '', x.weeks || '', x.starts_on || '', x.ends_at ? String(x.ends_at).slice(0, 10) : '', x.held || 0, x.classes || '',
          p(s3.reading), p(s3.quizzes), p(s3.arenas), p(s3.attendance), p(s3.midterm), p(s3.final), p(s3.total), (typeof s3.total === 'number' && s3.total >= thr) ? 'yes' : 'no', s3.flags || 0].map(q).join(',');
      }));
      var blob = new Blob([lines.join('\n')], { type: 'text/csv' }); var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'self-study-students-' + new Date().toISOString().slice(0, 10) + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    });
  }
  function integrity(courseId) {
    var md = modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><h2 style="margin:0;">Integrity log</h2><button class="btn btn-primary btn-sm" id="ssIntgClose">Close</button></div>' +
      '<div id="ssIntgList"><span class="spinner"></span></div><div id="ssIntgBody" style="margin-top:12px;max-height:55vh;overflow:auto;"></div>');
    $('ssIntgClose').addEventListener('click', md.close);
    var tl = tables();
    Promise.all([C.sb.from(C.examTable).select('id,title').eq('course_id', courseId)].concat(tl.map(function (t) {
      return C.sb.from(t).select('exam_id,violations,updated_at').eq('course_id', courseId);
    }))).then(function (rs) {
      var list = $('ssIntgList'); if (!list) { return; }
      var rows = [], titles = {}, err = null;
      (rs[0].data || []).forEach(function (e) { titles[e.id] = e.title; });
      rs.slice(1).forEach(function (r, i) { if (r.error) { err = r.error.message; return; } (r.data || []).forEach(function (x) { x._t = tl[i]; rows.push(x); }); });
      if (err && !rows.length) { list.textContent = err; return; }
      rows.sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
      if (!rows.length) { list.innerHTML = '<div style="color:var(--text-muted);">No proctored quizzes or exams taken yet.</div>'; return; }
      list.innerHTML = '<table class="tbl" style="width:100%;"><tr><th align="left">Session</th><th>Flags</th><th align="left">Last activity</th><th></th></tr>' + rows.map(function (r) {
        var ch = C.quizChapterOf ? C.quizChapterOf(r.exam_id, courseId) : null;
        var label = ch ? ('Chapter ' + ch + ' quiz') : (titles[r.exam_id] || r.exam_id);
        return '<tr><td>' + esc(label) + '</td><td align="center">' + (r.violations || 0) + '</td><td>' + esc(new Date(r.updated_at).toLocaleString()) + '</td>' +
          '<td><button class="btn btn-ghost btn-sm" data-intgx="' + esc(r.exam_id) + '" data-intgt="' + esc(r._t) + '">View</button></td></tr>';
      }).join('') + '</table>';
      Array.prototype.forEach.call(list.querySelectorAll('[data-intgx]'), function (b) {
        b.addEventListener('click', function () { if (global.MNProctor && global.MNProctor.renderIntegrityLog) { global.MNProctor.renderIntegrityLog(b.getAttribute('data-intgx'), $('ssIntgBody'), b.getAttribute('data-intgt')); } });
      });
    }, function () { var l = $('ssIntgList'); if (l) { l.textContent = 'Could not load the integrity log.'; } });
  }

  /* ---------------- sign-up arriving from self-study.html (?selfstudy=1) ---------------- */
  function handleSignupParam(toSignup, setNote) {
    var q = null; try { q = new URLSearchParams(global.location.search).get('selfstudy'); } catch (e) {}
    if (q !== '1') { return false; }
    try { toSignup(); } catch (e) {}
    try { setNote('Create your student account (leave the join code blank). Your Home page will then walk you through paying and choosing your schedule. Already registered? Sign in instead.'); } catch (e) {}
    return true;
  }

  global.MNSelfStudy = {
    init: function (cfg) { C = cfg; },
    mountHome: mountHome, mountAdmin: mountAdmin,
    bodyLink: bodyLink, wireBodies: wireBodies,
    prefetch: prefetch, isSelfStudyCached: isSelfStudyCached, quizGate: quizGate, quizDone: quizDone,
    handleSignupParam: handleSignupParam
  };
})(window);
