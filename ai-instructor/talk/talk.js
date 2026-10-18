// talk.js - "Talk" mode for the AI Instructor widget: the animated instructor plus voice, opened on demand.
//   - Speech recognition (Whisper) runs in the student's browser; nothing is uploaded. It is downloaded the first time the student talks.
//   - The instructor's voice uses only voices built into the student's device (see local-voice.js). Nothing is downloaded for it.
//   - The answers come from the same secure backend as the text chat (the widget's own backend object), so limits, privacy and the
//     course rules are identical. Everything rendered here uses textContent.
import { createInstructor, InstructorStateMachine } from './index.js';
import { createVoice } from './voice/index.js';
import { LocalVoiceAudio, LocalTtsStandIn } from './local-voice.js';

var CSS = [
'.mnai-talk{position:fixed;inset:0;z-index:99995;background:rgba(5,10,18,.86);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:12px}',
'.mnai-talk-box{width:min(1040px,100%);background:#0f1d33;color:#e9eef6;border-radius:14px;border:1px solid #2b3d58;box-shadow:0 20px 60px rgba(0,0,0,.5)}',
'.mnai-talk-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #22344f}',
'.mnai-talk-head h2{margin:0;font:700 17px/1.2 system-ui,sans-serif;flex:1}',
'.mnai-talk-head button,.mnai-talk-bar select{min-height:40px;border-radius:8px;border:1px solid #3a5075;background:#1d3050;color:#e9eef6;padding:0 12px;font:inherit;cursor:pointer}',
'.mnai-talk-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:8px 14px;border-top:1px solid #22344f;font:13px system-ui,sans-serif;color:#9fb0c6}',
'.mnai-talk-bar label{display:flex;gap:6px;align-items:center}',
'.mnai-talk-prog{height:6px;border-radius:3px;background:#2b3d58;overflow:hidden;width:140px}.mnai-talk-prog>i{display:block;height:100%;width:0;background:#d9b86a}'
].join('\n');

function el(doc, tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

// o: { backend, getMode, baseUrl, modelFile, hooks:{studentSaid, assistantDelta, turnDone}, onClose, doc, glossary, dev }
export function openTalk(o) {
  var doc = o.doc || document, base = new URL(o.baseUrl, doc.baseURI || location.href).href, closed = false;
  if (!doc.getElementById('mnai-talk-styles')) { var st = el(doc, 'style'); st.id = 'mnai-talk-styles'; st.textContent = CSS; doc.head.appendChild(st); }

  var scrim = el(doc, 'div', 'mnai-talk'), box = el(doc, 'div', 'mnai-talk-box');
  scrim.setAttribute('role', 'dialog'); scrim.setAttribute('aria-modal', 'true'); scrim.setAttribute('aria-label', 'Talk with the AI Instructor');
  var head = el(doc, 'div', 'mnai-talk-head'), title = el(doc, 'h2', '', 'Talk with your AI Instructor');
  var closeBtn = el(doc, 'button', '', 'Back to chat'); closeBtn.type = 'button';
  head.append(title, closeBtn);
  var root = el(doc, 'div');
  var bar = el(doc, 'div', 'mnai-talk-bar'), voiceLab = el(doc, 'label', '', 'Voice '), voiceSel = el(doc, 'select'); voiceSel.setAttribute('aria-label', 'Instructor voice'); voiceLab.appendChild(voiceSel);
  var asrNote = el(doc, 'span', '', ''), prog = el(doc, 'div', 'mnai-talk-prog'), progFill = el(doc, 'i'); prog.appendChild(progFill); prog.hidden = true;
  var tips = el(doc, 'span', '', 'Hold the Talk button while you speak. Headphones work best. Speech is recognised on your own device; your voice is never uploaded.');
  bar.append(voiceLab, asrNote, prog, tips);
  box.append(head, root, bar); scrim.appendChild(box); doc.body.appendChild(scrim);

  var audio = new LocalVoiceAudio({ preferredVoiceUri: safeGet('mnai-voice') });
  var voiceP = null, voice = null, inst = null, held = false, handles = {}, asrLoaded = false, asrLoading = null;

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  var origin = new URL(base).origin;
  inst = createInstructor(root, {
    // Production: absolute https URL under our own folder only. o.dev (local testing over http) allows a page-relative path instead.
    modelUrl: o.dev ? new URL(o.modelFile || 'assets/instructor.glb', base).pathname : new URL(o.modelFile || 'assets/instructor.glb', base).href,
    approvedOrigins: [base], allowRelativeDev: !!o.dev,
    audio: audio,
    lipsync: { jawMax: 0.4 },        // this model's jaw shape looks stretched past ~40%
    threeDepsUrl: new URL('three-deps.bundle.js', base).href,
    privacyNote: o.privacyNote || 'AI-generated and can be wrong. Your voice is turned into text on your own device and the audio is discarded. The text of your questions is handled exactly like the typed chat.',
    onUserText: function (t) { getVoice().then(function (v) { v.submitText(t); }, fail); },
    onPushToTalk: function (down) { held = down; if (down) startTalking(); else stopTalking(); },
    onInterrupt: function () { if (voice) voice.controller.interrupt('user'); }
  });
  var panel = inst.panel;

  audio.unlock().then(function () {
    var vs = audio.voices();
    if (!vs.length) { asrNote.textContent = 'This device has no built-in voice available, so answers will appear as text only.'; voiceLab.hidden = true; return; }
    vs.forEach(function (v) { var op = el(doc, 'option', '', v.name + ' (' + v.lang + ')'); op.value = v.voiceURI; voiceSel.appendChild(op); });
    if (audio.voice) voiceSel.value = audio.voice.voiceURI;
  });
  voiceSel.addEventListener('change', function () { audio.setVoice(voiceSel.value); safeSet('mnai-voice', voiceSel.value); });

  function fail(e) { panel.showError((e && e.message) ? e.message : 'Something went wrong. You can type your question instead.'); }

  function getVoice() {
    if (voiceP) return voiceP;
    voiceP = inst.ready.catch(function () { return null; }).then(function (avatar) {
      var state = avatar ? avatar.machine : new InstructorStateMachine();
      var backend = { respond: function (r) { return o.backend.respond({ text: r.text, inputMode: 'voice', mode: (o.getMode && o.getMode()) || undefined, signal: r.signal }); } };
      return createVoice({
        config: { base: base }, pageUrl: base, state: state, audio: audio, backend: backend,
        tts: LocalTtsStandIn, toAudioBuffer: function (w) { return w; }, glossary: o.glossary || null
      });
    }).then(function (v) {
      voice = v; wire(v.controller);
      if (closed) { v.dispose(); }
      return v;
    });
    return voiceP;
  }

  function wire(ctrl) {
    ctrl.on('transcript', function (e) {
      if (e.source === 'voice') panel.addMessage('student', e.text);
      handles[e.turnId] = panel.addMessage('instructor', '');
      if (o.hooks && o.hooks.studentSaid) o.hooks.studentSaid(e.text, e.source);
    });
    ctrl.on('assistant-text', function (e) { var h = handles[e.turnId]; if (h) h.append(e.delta); if (o.hooks && o.hooks.assistantDelta) o.hooks.assistantDelta(e.delta); });
    ctrl.on('assistant-complete', function (e) { delete handles[e.turnId]; if (o.hooks && o.hooks.turnDone) o.hooks.turnDone(); });
    ctrl.on('ignored', function () { panel.showError('I didn’t catch that. Please try again, or type your question.'); });
    ctrl.on('error', function (e) {
      var m = e.stage === 'asr' ? 'Speech recognition had a problem. Please try again, or type your question.' : (e.error && e.error.message) || 'The instructor could not answer just now.';
      if (e.stage !== 'tts') panel.showError(m);
      if (o.hooks && o.hooks.turnDone) o.hooks.turnDone();
    });
  }

  function loadAsr(v) {
    if (asrLoaded) return Promise.resolve();
    if (asrLoading) return asrLoading;
    asrNote.textContent = 'Preparing speech recognition (first time only, about 80 MB)…'; prog.hidden = false;
    asrLoading = v.loadModels(function (ev) {
      if (ev && ev.kind === 'progress' && ev.info && typeof ev.info.progress === 'number') progFill.style.width = Math.round(ev.info.progress) + '%';
    }).then(function () { asrLoaded = true; asrNote.textContent = 'Speech recognition ready.'; prog.hidden = true; },
      function (e) { asrLoading = null; prog.hidden = true; asrNote.textContent = 'Speech recognition could not load. You can still type.'; throw e; });
    return asrLoading;
  }
  function startTalking() {
    getVoice().then(function (v) { return loadAsr(v).then(function () { if (held && !closed) return v.startListening(); }); })
      .catch(function (e) { fail(new Error('Speech recognition is not available right now. You can type your question instead.')); });
  }
  function stopTalking() { if (voice) voice.stopListening(); }

  function close() {
    if (closed) return; closed = true;
    try { if (voice) voice.dispose(); } catch (e) { /* ignore */ }
    try { inst.dispose(); } catch (e) { /* ignore */ }
    try { audio.dispose(); } catch (e) { /* ignore */ }
    if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
    if (o.onClose) o.onClose();
  }
  closeBtn.addEventListener('click', close);
  scrim.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  closeBtn.focus();
  return { close: close, ready: inst.ready, get audio() { return audio; }, get instructor() { return inst; }, getVoice: getVoice };
}
