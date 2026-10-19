// actions.ts - the non-streaming actions: sessions, interrupts, history, key and settings management.
import { LIMITS, MODELS, PROVIDERS, isProviderId, resolveBaseURL } from "./config.ts";
import { reviewSolutionsAllowed, toolDefinitionsForModel } from "./tools.ts";
import { buildSystem } from "./prompt.ts";
import { decryptKey, encryptKey, last4, looksLikeKeyFor } from "./vault.ts";
import { errBody, keyOwnerOf, type Caller, type Deps } from "./converse.ts";
import { ProviderError } from "./provider.ts";
import type { ErrorBody } from "./schemas.ts";
import { DEFAULT_CONTROL, isMode } from "./resilience.ts";
import type { CourseSettings, IngestChunk, SessionMetrics } from "./store.ts";
import { MODES, MODE_LABELS, effectiveMode, masteryEstimate, type Mode } from "./teaching.ts";

export type Result = { status: number; body: unknown };
const err = (status: number, b: ErrorBody): Result => ({ status, body: b });
const ok = (body: unknown = { ok: true }): Result => ({ status: 200, body });

async function canManage(deps: Deps, c: Caller, courseId: string): Promise<{ yes: boolean; ownerId?: string }> {
  const a = await deps.store.getCourseAccess(c.userId, courseId, (deps.now ?? (() => new Date()))());
  const role = await deps.store.getRole(c.userId);
  if (a.reason === "not_found") return { yes: false };
  return { yes: role === "admin" || a.ownerId === c.userId, ownerId: a.ownerId };
}

export async function startSession(deps: Deps, c: Caller, courseId: string): Promise<Result> {
  const now = (deps.now ?? (() => new Date()))();
  const a = await deps.store.getCourseAccess(c.userId, courseId, now);
  if (!a.allowed) return err(403, errBody("not_enrolled", "You do not have access to this course's AI instructor.", false));
  if (!a.settings.enabled && !a.isStaff) return err(403, errBody("course_disabled", "The AI instructor is not turned on for this course.", false));
  const kOwner = keyOwnerOf(deps, a);
  if (!kOwner || !(await deps.store.getStoredKey(kOwner))) return err(409, errBody("no_instructor_key", "The AI instructor isn't set up yet. Please tell your instructor.", false));
  // operator switch and admission control: refuse BEFORE creating any row
  const ctl = deps.control ? await deps.control.get() : DEFAULT_CONTROL;
  if (ctl.mode === "paused") return err(503, errBody("paused", ctl.message ?? "The AI instructor is paused for maintenance. Please try again later.", true, 60));
  if (ctl.maxActiveSessions !== null && deps.store.countActiveSessions) {
    let active = 0; try { active = await deps.store.countActiveSessions(LIMITS.activeSessionWindowS); } catch { /* if the count fails, do not block students */ }
    if (active >= ctl.maxActiveSessions) {
      deps.log("warn", "session_waiting", { code: "capacity", course_id: courseId });
      // a controlled waiting state: the client shows "waiting for a free seat" and retries with jitter; text-only tutoring is offered meanwhile
      return err(503, { ...errBody("capacity", "The AI instructor is at capacity right now. You are in the waiting room; we'll retry automatically.", true, 15 + Math.floor((deps.rand ?? Math.random)() * 15)), ...({ text_only_available: true } as object) });
    }
  }
  const r = await deps.store.createSession(c.userId, courseId, a.settings.retentionDays, now);
  if (!r.ok) return err(429, errBody("rate_limited", "Too many sessions today.", true, 3600));
  deps.log("info", "session_start", { session_id: r.session.id, course_id: courseId, user: await deps.userHash(c.userId) });
  return ok({
    session_id: r.session.id, state: r.session.state,
    mode: ctl.mode, voice_allowed: ctl.mode === "normal",     // text_only: the client must not start voice or the 3D avatar
    retention_days: r.session.retentionDays,      // so the UI can tell the student exactly how long the conversation is kept
    limits: { max_text_chars: LIMITS.maxTextChars, max_reply_tokens: LIMITS.maxReplyTokens },
    // what the student can pick and what is switched off, so the UI never offers a mode the instructor has disabled
    teaching_modes: MODES.map((m) => ({ id: m, label: MODE_LABELS[m], enabled: effectiveMode(m as Mode, a.settings).mode === m })),
    policy: { ai_policy: a.settings.aiPolicy, worked_solutions: a.settings.aiPolicy === "full" && a.settings.allowWorkedSolutions, practice_is_graded: false, learning_record_days: a.settings.learningRecordDays, store_mastery: a.settings.storeMastery && a.settings.learningRecordDays > 0, review_enabled: a.settings.reviewEnabled },
  });
}

async function ownSession(deps: Deps, c: Caller, id: string) {
  const s = await deps.store.getSession(id);
  return s && s.userId === c.userId ? s : null;
}

// Warm-up: write the course's cached prompt prefix (rules + whole textbook + tool list) with a 1-token call, so the student's first real question reads it
// from the cache instead of paying to re-load ~100K tokens. Best effort: any failure is ignored. Not metered per student (a few cents of cache writes at most).
const warmAt = new Map<string, number>();
export async function warm(deps: Deps, c: Caller, sessionId: string): Promise<Result> {
  try {
    const s = await ownSession(deps, c, sessionId);
    if (!s || s.state === "ended") return ok({ warmed: false });
    const key = `${c.userId}:${s.courseId}`, nowMs = Date.now();
    if ((warmAt.get(key) ?? 0) > nowMs - 120_000) return ok({ warmed: false, reason: "recent" });
    if (warmAt.size > 5000) warmAt.clear();
    warmAt.set(key, nowMs);
    const a = await deps.store.getCourseAccess(c.userId, s.courseId, new Date());
    if (!a.allowed || (!a.settings.enabled && !a.isStaff)) return ok({ warmed: false });
    const kOwner = keyOwnerOf(deps, a), stored = kOwner ? await deps.store.getStoredKey(kOwner) : null;
    if (!stored || (stored.provider && stored.provider !== "anthropic")) return ok({ warmed: false });
    // Prime the cached prefix every turn shares (the tools and the teaching rules) and the decrypted key path, and load the book into this instance for the next turn.
    void deps.content.bookData?.(s.courseId).catch(() => {});
    const apiKey = await decryptKey(stored.ciphertext, stored.iv, kOwner, deps.kek);
    const allowed = MODELS.allowed as readonly string[];
    const model = a.settings.model && allowed.includes(a.settings.model) ? a.settings.model : stored.model && allowed.includes(stored.model) ? stored.model : MODELS.default;
    const reviewOn = a.settings.reviewEnabled === true && !!deps.store.reviewList;
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 30_000);
    let cw = 0, cr = 0;
    try {
      for await (const ev of deps.provider.stream({ apiKey, model, system: buildSystem({ courseTitle: a.title, term: a.term, directives: "", retrieved: "" }), messages: [{ role: "user", content: "Hello." }], tools: toolDefinitionsForModel({ review: reviewOn }), maxTokens: 1, signal: ac.signal, baseURL: deps.baseURL ?? undefined, provider: stored.provider })) {
        if (ev.type === "end") { cw = ev.usage.cacheWrite; cr = ev.usage.cacheRead; break; }
      }
    } finally { clearTimeout(timer); }
    deps.log("info", "warm", { session_id: s.id, course_id: s.courseId, cache_read_tokens: cr, cache_write_tokens: cw });
    return ok({ warmed: true });
  } catch { return ok({ warmed: false }); }
}

export async function interrupt(deps: Deps, c: Caller, sessionId: string, clientTurnId: string, spokenChars: number | null): Promise<Result> {
  const s = await ownSession(deps, c, sessionId);
  if (!s) return err(404, errBody("session_not_found", "Session not found.", false));
  const changed = await deps.store.interruptTurn(s.id, c.userId, clientTurnId, spokenChars);
  if (s.state !== "ended") await deps.store.setSessionState(s.id, "interrupted");
  return ok({ interrupted: changed });
}

export async function clientState(deps: Deps, c: Caller, sessionId: string, state: "listening" | "speaking"): Promise<Result> {
  const s = await ownSession(deps, c, sessionId);
  if (!s) return err(404, errBody("session_not_found", "Session not found.", false));
  if (s.state === "ended") return err(409, errBody("session_ended", "This session has ended.", false));
  try { return ok({ state: await deps.store.setSessionState(s.id, state) }); }
  catch { return ok({ state: s.state, ignored: true }); }     // an out-of-order report (e.g. stale "speaking") is ignored, not an error
}

export async function history(deps: Deps, c: Caller, sessionId: string, afterSeq: number): Promise<Result> {
  const s = await ownSession(deps, c, sessionId);
  if (!s) return err(404, errBody("session_not_found", "Session not found.", false));
  const msgs = await deps.store.listMessages(s.id, afterSeq);
  return ok({ state: s.state, messages: msgs.map((m) => ({ seq: m.seq, role: m.role, text: m.content, turn_id: m.turnId, interrupted: m.interrupted })) });
}

export async function endSession(deps: Deps, c: Caller, sessionId: string): Promise<Result> {
  const s = await ownSession(deps, c, sessionId);
  if (!s) return err(404, errBody("session_not_found", "Session not found.", false));
  await deps.store.endSession(s.id);
  return ok();
}

// ---- instructor key management (bring-your-own-key) -------------------------------------------------------------------------
async function requireInstructor(deps: Deps, c: Caller): Promise<Result | null> {
  const role = await deps.store.getRole(c.userId);
  return role === "instructor" || role === "admin" ? null : err(403, errBody("forbidden", "Only instructors can manage the AI key.", false));
}

export async function setKey(deps: Deps, c: Caller, apiKey: string, model: string | undefined, validateKey: boolean | undefined, opt: { provider?: string; baseUrl?: string; priceIn?: number; priceOut?: number } = {}): Promise<Result> {
  const denied = await requireInstructor(deps, c); if (denied) return denied;
  const key = apiKey.trim(), provider = opt.provider ?? "anthropic";
  if (!isProviderId(provider)) return err(400, errBody("bad_request", "Unknown provider.", false));
  const other = provider !== "anthropic";
  if (!looksLikeKeyFor(provider, key, PROVIDERS[provider].keyPrefix)) return err(400, errBody("bad_request", other ? `That doesn't look like a ${PROVIDERS[provider].label} key.` : "That doesn't look like an Anthropic API key (it should start with sk-ant-).", false));
  if (other && !model) return err(400, errBody("bad_request", "Choose a model name for this provider.", false));
  if (!other && model && !(MODELS.allowed as readonly string[]).includes(model)) return err(400, errBody("bad_request", "Unsupported Claude model.", false));
  const useModel = model ?? MODELS.default;
  const baseURL = other ? resolveBaseURL(provider, opt.baseUrl ?? null, deps.extraHosts ?? []) : null;
  if (other && !baseURL) return err(400, errBody("bad_request", provider === "custom" ? "That address is not on this platform's approved list. Ask the platform administrator to add it." : "Provider address unavailable.", false));
  if (validateKey) {
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15_000);
      try { for await (const ev of deps.provider.stream({ apiKey: key, model: useModel, system: [{ type: "text", text: "Reply with the single word ok." }], messages: [{ role: "user", content: "ping" }], tools: [], maxTokens: other ? 16 : 4, signal: ac.signal, baseURL: deps.baseURL ?? baseURL ?? undefined, provider })) if (ev.type === "end") break; }
      finally { clearTimeout(t); }
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "auth") return err(400, errBody("provider_key_invalid", `${PROVIDERS[provider].label} rejected that key.`, false));
      if (e instanceof ProviderError && e.kind === "bad_request") return err(400, errBody("bad_request", e.detail ? `The provider rejected the request (HTTP ${e.status}): ${e.detail}` : `The provider rejected the request${e.status ? ` (HTTP ${e.status})` : ""}. Check the model name.`, false));
      return err(502, errBody("provider_unavailable", "Couldn't verify the key right now. It was NOT saved; try again.", true));
    }
  }
  const enc = await encryptKey(key, c.userId, deps.kek);
  await deps.store.putStoredKey(c.userId, { ...enc, model: useModel, last4: last4(key), provider, baseUrl: provider === "custom" ? baseURL : null, priceIn: other ? (opt.priceIn ?? null) : null, priceOut: other ? (opt.priceOut ?? null) : null });
  deps.log("info", "key_set", { user: await deps.userHash(c.userId), model: useModel, tool: provider });
  return ok({ saved: true, last4: last4(key), model: useModel, provider });      // the key itself is never returned
}
export async function keyStatus(deps: Deps, c: Caller): Promise<Result> {
  const denied = await requireInstructor(deps, c); if (denied) return denied;
  const k = await deps.store.getStoredKey(c.userId);
  return ok(k ? { has_key: true, last4: k.last4, model: k.model, provider: k.provider ?? "anthropic", price_in: k.priceIn ?? null, price_out: k.priceOut ?? null, updated_at: k.updatedAt } : { has_key: false });
}
export async function deleteKey(deps: Deps, c: Caller): Promise<Result> {
  const denied = await requireInstructor(deps, c); if (denied) return denied;
  await deps.store.deleteStoredKey(c.userId);
  deps.log("info", "key_deleted", { user: await deps.userHash(c.userId) });
  return ok();
}

// ---- per-course settings (owner or admin) -----------------------------------------------------------------------------------
export async function getSettings(deps: Deps, c: Caller, courseId: string): Promise<Result> {
  const m = await canManage(deps, c, courseId);
  if (!m.yes) return err(403, errBody("forbidden", "Only the course owner can view these settings.", false));
  const a = await deps.store.getCourseAccess(c.userId, courseId, (deps.now ?? (() => new Date()))());
  return ok(settingsBody(a.settings));
}
const settingsBody = (s: CourseSettings) => ({
  enabled: s.enabled, retention_days: s.retentionDays, student_daily_tokens: s.studentDailyTokens, course_monthly_usd: s.courseMonthlyUsd, model: s.model,
  ai_policy: s.aiPolicy, allow_worked_solutions: s.allowWorkedSolutions, block_during_assessments: s.blockDuringAssessments, learning_record_days: s.learningRecordDays, store_mastery: s.storeMastery,
  review_enabled: s.reviewEnabled, review_show_solutions: s.reviewShowSolutions, payer: s.payer,
});
export async function setSettings(deps: Deps, c: Caller, courseId: string, p: { enabled?: boolean; retention_days?: number; student_daily_tokens?: number; course_monthly_usd?: number; model?: string; ai_policy?: "full" | "hints_only" | "concepts_only"; allow_worked_solutions?: boolean; block_during_assessments?: boolean; learning_record_days?: number; store_mastery?: boolean; review_enabled?: boolean; review_show_solutions?: boolean; payer?: "instructor" | "platform" }): Promise<Result> {
  const m = await canManage(deps, c, courseId);
  if (!m.yes) return err(403, errBody("forbidden", "Only the course owner can change these settings.", false));
  if (p.payer !== undefined && (await deps.store.getRole(c.userId)) !== "admin") return err(403, errBody("forbidden", "Only a platform administrator can change who pays for the AI instructor.", false));
  if (p.payer === "platform" && !deps.platformKeyOwner && !(await deps.store.platformKeyOwner?.())) return err(409, errBody("bad_request", "No platform key is saved yet. An administrator must save an AI key first.", false));
  const s = await deps.store.setSettings(courseId, {
    ...(p.enabled !== undefined && { enabled: p.enabled }), ...(p.retention_days !== undefined && { retentionDays: p.retention_days }),
    ...(p.student_daily_tokens !== undefined && { studentDailyTokens: p.student_daily_tokens }), ...(p.course_monthly_usd !== undefined && { courseMonthlyUsd: p.course_monthly_usd }), ...(p.model !== undefined && { model: p.model }),
    ...(p.ai_policy !== undefined && { aiPolicy: p.ai_policy }), ...(p.allow_worked_solutions !== undefined && { allowWorkedSolutions: p.allow_worked_solutions }),
    ...(p.block_during_assessments !== undefined && { blockDuringAssessments: p.block_during_assessments }), ...(p.learning_record_days !== undefined && { learningRecordDays: p.learning_record_days }), ...(p.store_mastery !== undefined && { storeMastery: p.store_mastery }),
    ...(p.payer !== undefined && { payer: p.payer }), ...(p.review_enabled !== undefined && { reviewEnabled: p.review_enabled }), ...(p.review_show_solutions !== undefined && { reviewShowSolutions: p.review_show_solutions }),
  });
  deps.accessCache?.clear?.();     // settings changed: drop cached access so the new rules apply on the next turn
  deps.log("info", "settings_changed", { course_id: courseId, user: await deps.userHash(c.userId) });
  return ok(settingsBody(s));
}

// ---- graded-work review: status and consent (the student's own action), the meeting-request fallback, and the staff view of those requests --------------------------
export const REVIEW_CONSENT_VERSION = 1;
const cleanText = (s: string, n: number) => s.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
/** The exact wording the student agrees to. It names the AI service that will receive their work and how long the chat is kept, so the consent is informed. */
export function reviewConsentText(o: { provider: string; solutions: boolean; retentionDays: number }): string {
  const who = (isProviderId(o.provider) ? PROVIDERS[o.provider].label : "the AI service your instructor connected");
  const kept = o.retentionDays > 0 ? `Your conversation with the AI instructor is kept for ${o.retentionDays} days.` : "Your conversation with the AI instructor is deleted when the session ends.";
  return `Allow the AI instructor to read my own graded work in this course (exams, quizzes, arena results and assignments) after their deadlines have passed, so we can go over them together. It can see the questions, my answers, whether they were marked correct, and my points${o.solutions ? ", and the correct answers and explanations" : ""}. It cannot see anyone else's work, cannot change any grade, and sees nothing until the deadline has passed for the whole class. What it reads is sent to ${who} to write its replies. ${kept} I can turn this off at any time. If I do not allow it, I can still ask the TA or the professor for a meeting.`;
}
async function reviewAccess(deps: Deps, c: Caller, courseId: string) {
  const a = await deps.store.getCourseAccess(c.userId, courseId, (deps.now ?? (() => new Date()))());
  return a;
}
export async function reviewStatus(deps: Deps, c: Caller, courseId: string): Promise<Result> {
  const a = await reviewAccess(deps, c, courseId);
  if (!a.allowed) return err(403, errBody("not_enrolled", "You do not have access to this course's AI instructor.", false));
  const s = deps.store;
  const stored = a.settings.reviewEnabled && keyOwnerOf(deps, a) ? await s.getStoredKey(keyOwnerOf(deps, a)) : null;
  const consent = a.settings.reviewEnabled && s.reviewConsentGet ? await s.reviewConsentGet(c.userId, courseId) : null;
  const solutions = reviewSolutionsAllowed(a.settings);
  const [log, mine] = await Promise.all([
    a.settings.reviewEnabled && consent?.granted && s.reviewLogMine ? s.reviewLogMine(c.userId, courseId) : Promise.resolve([]),
    s.myMeetingRequests ? s.myMeetingRequests(c.userId, courseId) : Promise.resolve([]),
  ]);
  return ok({
    review_enabled: a.settings.reviewEnabled && !!s.reviewConsentGet, granted: consent?.granted === true, text_version: REVIEW_CONSENT_VERSION,
    consent_text: reviewConsentText({ provider: stored?.provider ?? "anthropic", solutions, retentionDays: a.settings.retentionDays }),
    solutions_shown: solutions, can_request_meeting: !!s.requestMeeting,
    recent_access: log.slice(0, 10), my_requests: mine.map((r) => ({ id: r.id, with: r.with, topic: r.topic, status: r.status, created_at: r.createdAt })),
  });
}
export async function reviewConsent(deps: Deps, c: Caller, courseId: string, granted: boolean): Promise<Result> {
  const a = await reviewAccess(deps, c, courseId);
  if (!a.allowed) return err(403, errBody("not_enrolled", "You do not have access to this course's AI instructor.", false));
  if (!a.settings.reviewEnabled || !deps.store.reviewConsentSet) return err(409, errBody("review_off", "Reviewing graded work with the AI instructor is not turned on for this course.", false));
  const r = await deps.store.reviewConsentSet(c.userId, courseId, granted, REVIEW_CONSENT_VERSION);
  if (!r.ok) return err(403, errBody("not_enrolled", "You do not have access to this course's AI instructor.", false));
  deps.log("info", "review_consent", { course_id: courseId, user: await deps.userHash(c.userId), reason: granted ? "granted" : "withdrawn" });
  return ok({ granted: r.granted === true, updated_at: r.updatedAt ?? null });
}
export async function requestMeeting(deps: Deps, c: Caller, courseId: string, withWhom: "ta" | "professor", topic: string, note: string | null): Promise<Result> {
  const a = await reviewAccess(deps, c, courseId);
  if (!a.allowed) return err(403, errBody("not_enrolled", "You do not have access to this course's AI instructor.", false));
  if (!deps.store.requestMeeting) return err(501, errBody("internal", "Meeting requests are not installed (migration 005).", false));
  const t = cleanText(topic, 200); if (!t) return err(400, errBody("bad_request", "Say what you would like to discuss.", false));
  const r = await deps.store.requestMeeting(c.userId, courseId, withWhom, t, note ? cleanText(note, 500) : null);
  if (!r.ok) return r.reason === "limit" ? err(429, errBody("rate_limited", "You already have five open requests. Please wait for a reply to one of them.", false)) : err(403, errBody("not_enrolled", "You do not have access to this course.", false));
  deps.log("info", "meeting_requested", { course_id: courseId, user: await deps.userHash(c.userId), tool: withWhom });
  return ok({ requested: true, id: r.id });
}
export async function listReviewRequests(deps: Deps, c: Caller, courseId: string): Promise<Result> {
  const a = await reviewAccess(deps, c, courseId);
  if (!a.allowed || !a.isStaff) return err(403, errBody("forbidden", "Only the course staff can see meeting requests.", false));
  if (!deps.store.listMeetingRequests) return ok({ requests: [] });
  const r = await deps.store.listMeetingRequests(c.userId, courseId);
  if (!r.ok) return err(403, errBody("forbidden", "Only the course staff can see meeting requests.", false));
  return ok({ requests: r.requests.map((q) => ({ id: q.id, with: q.with, topic: q.topic, note: q.note ?? null, status: q.status, created_at: q.createdAt, student: q.student ?? "student" })) });
}
export async function completeReviewRequest(deps: Deps, c: Caller, courseId: string, requestId: string): Promise<Result> {
  const a = await reviewAccess(deps, c, courseId);
  if (!a.allowed || !a.isStaff) return err(403, errBody("forbidden", "Only the course staff can do this.", false));
  if (!deps.store.completeMeetingRequest) return err(501, errBody("internal", "Meeting requests are not installed (migration 005).", false));
  return ok({ done: await deps.store.completeMeetingRequest(c.userId, courseId, requestId) });
}

// ---- course materials upload (owner or admin) ---------------------------------------------------------------------------------
export async function ingestMaterials(deps: Deps, c: Caller, courseId: string, b: { source_id: string; title: string; kind: string; replace?: boolean; chunks: IngestChunk[] }): Promise<Result> {
  const m = await canManage(deps, c, courseId);
  if (!m.yes) return err(403, errBody("forbidden", "Only the course owner can upload course materials.", false));
  if (!deps.store.ingestMaterials) return err(501, errBody("internal", "Materials upload is not available.", false));
  if (b.chunks.some((k) => !k.source_key.startsWith(b.source_id + ":") || !k.chunk_key.startsWith(k.source_key))) return err(400, errBody("bad_request", "Every chunk must belong to the named source.", false));
  const n = await deps.store.ingestMaterials(courseId, { id: b.source_id, title: b.title, kind: b.kind }, b.chunks, b.replace === true);
  (deps.content as { invalidate?: () => void }).invalidate?.();
  deps.log("info", "materials_ingested", { course_id: courseId, user: await deps.userHash(c.userId), count: n });
  return ok({ stored: n });
}

// ---- the student's own learning data (feedback, a readable view, deletion) -----------------------------------------------------
export async function feedback(deps: Deps, c: Caller, sessionId: string, turnId: string | null, rating: "helpful" | "not_helpful", reason: string | null): Promise<Result> {
  const s = await ownSession(deps, c, sessionId);
  if (!s) return err(404, errBody("session_not_found", "Session not found.", false));
  const a = await deps.store.getCourseAccess(c.userId, s.courseId, (deps.now ?? (() => new Date()))());
  if (!a.allowed) return err(403, errBody("not_enrolled", "You do not have access to this course's AI instructor.", false));
  if (a.settings.learningRecordDays <= 0) return ok({ stored: false, reason: "This course does not keep learning records." });
  await deps.store.saveFeedback(c.userId, s.courseId, s.id, turnId, rating, reason);
  return ok({ stored: true });
}
/** What the platform holds about this student's AI practice in one course: topics, practice counts, and mastery estimates with uncertainty. */
export async function myLearning(deps: Deps, c: Caller, courseId: string): Promise<Result> {
  const a = await deps.store.getCourseAccess(c.userId, courseId, (deps.now ?? (() => new Date()))());
  if (!a.allowed) return err(403, errBody("not_enrolled", "You do not have access to this course's AI instructor.", false));
  const [p, m] = await Promise.all([deps.store.getProgress(c.userId, courseId), deps.store.getMastery(c.userId, courseId)]);
  return ok({
    retention_days: a.settings.learningRecordDays, store_mastery: a.settings.storeMastery && a.settings.learningRecordDays > 0,
    recent_topics: p.recentTopics, practice_attempted: p.practiceAsked, practice_solved: p.practiceSolved,
    mastery: m.map((r) => masteryEstimate(r.topicKey, r.alpha, r.beta, r.attempts)),
    notice: "Practice is ungraded and separate from your course grade. These estimates are rough, shown with a range, and based only on the practice questions you answered.",
  });
}
export async function deleteMyLearning(deps: Deps, c: Caller, courseId: string, confirm: boolean): Promise<Result> {
  if (!confirm) return err(400, errBody("bad_request", "Set confirm to true to delete.", false));
  const a = await deps.store.getCourseAccess(c.userId, courseId, (deps.now ?? (() => new Date()))());
  if (a.reason === "not_found") return err(404, errBody("session_not_found", "Course not found.", false));
  const r = await deps.store.deleteLearnerData(c.userId, courseId);
  deps.log("info", "learner_data_deleted", { course_id: courseId, user: await deps.userHash(c.userId), count: r.events + r.mastery + r.feedback + r.sessions });
  return ok({ deleted: r });
}

// ---- operations ---------------------------------------------------------------------------------------------------------------
const clamp = (n: unknown, max: number) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : undefined);
/** Browser-measured per-session aggregates (speech time, avatar bytes, latency). A handful of calls per session, never per audio frame. */
export async function reportUsage(deps: Deps, c: Caller, sessionId: string, b: Record<string, unknown>): Promise<Result> {
  const s = await ownSession(deps, c, sessionId);
  if (!s) return err(404, errBody("session_not_found", "Session not found.", false));
  if (!deps.store.reportUsage) return ok({ stored: false });
  const m: SessionMetrics = { asrMs: clamp(b.asr_ms, 3.6e6), ttsMs: clamp(b.tts_ms, 3.6e6), audioInMs: clamp(b.audio_in_ms, 3.6e6), audioOutMs: clamp(b.audio_out_ms, 3.6e6), avatarBytes: clamp(b.avatar_bytes, 5e8), avatarInitMs: clamp(b.avatar_init_ms, 6e5), ttfaMs: clamp(b.ttfa_ms, 6e5), turns: clamp(b.turns, 100), interruptions: clamp(b.interruptions, 1000), syncErrors: clamp(b.sync_errors, 1000), audioDrops: clamp(b.audio_drops, 1000), textOnly: b.text_only === true };
  try { return ok({ stored: await deps.store.reportUsage(s.id, c.userId, m) }); } catch { return ok({ stored: false }); }   // metrics are best-effort; they must never break tutoring
}

/** Owner/admin view: spend against budget, live sessions, current mode, breaker states, and any alerts. No student content. */
export async function opsStatus(deps: Deps, c: Caller, courseId: string | undefined): Promise<Result> {
  const role = await deps.store.getRole(c.userId);
  const ctl = deps.control ? await deps.control.get() : DEFAULT_CONTROL;
  const out: Record<string, unknown> = { mode: ctl.mode, max_active_sessions: ctl.maxActiveSessions, course_max_generating: ctl.courseMaxGenerating ?? LIMITS.courseMaxConcurrentGenerating, gate: { in_use: deps.gate.inUse, waiting: deps.gate.waiting } };
  if (role === "admin") out.breakers = deps.breakers?.snapshot() ?? {};
  if (courseId) {
    const m = await canManage(deps, c, courseId); if (!m.yes) return err(403, errBody("forbidden", "Only the course owner or an admin can see this.", false));
    const a = await deps.store.getCourseAccess(c.userId, courseId, (deps.now ?? (() => new Date()))());
    if (deps.store.courseSpend) {
      const sp = await deps.store.courseSpend(courseId, (deps.now ?? (() => new Date()))()); const cap = a.settings.courseMonthlyUsd;
      const pct = cap > 0 ? sp.monthUsd / cap : 0, alerts: { level: string; message: string }[] = [];
      if (pct >= 1) alerts.push({ level: "critical", message: "Monthly budget used up; students are being refused until next month or the cap is raised." });
      else if (pct >= LIMITS.alertAtBudgetFraction) alerts.push({ level: "warning", message: `Monthly budget ${(pct * 100).toFixed(0)}% used.` });
      out.course = { month_usd: Math.round(sp.monthUsd * 1e4) / 1e4, budget_usd: cap, today_turns: sp.todayTurns, active_sessions: sp.activeSessions, alerts };
    }
  } else if (role !== "admin") return err(403, errBody("forbidden", "Provide a course_id.", false));
  return ok(out);
}

/** Emergency controls: admin only. `paused` stops all new sessions and turns on every instance within the cache TTL (about 5 s). */
export async function setControl(deps: Deps, c: Caller, b: { mode?: string; max_active_sessions?: number; clear_max_active_sessions?: boolean; course_max_generating?: number; clear_course_max_generating?: boolean; message?: string }): Promise<Result> {
  if ((await deps.store.getRole(c.userId)) !== "admin") return err(403, errBody("forbidden", "Admin only.", false));
  if (!deps.store.setControl) return err(501, errBody("internal", "Operator control is not installed (migration 002).", false));
  const patch: Record<string, unknown> = {};
  if (b.mode !== undefined) { if (!isMode(b.mode)) return err(400, errBody("bad_request", "Invalid mode.", false)); patch.mode = b.mode; }
  if (b.clear_max_active_sessions) patch.maxActiveSessions = null; else if (b.max_active_sessions !== undefined) patch.maxActiveSessions = b.max_active_sessions;
  if (b.clear_course_max_generating) patch.courseMaxGenerating = null; else if (b.course_max_generating !== undefined) patch.courseMaxGenerating = b.course_max_generating;
  if (b.message !== undefined) patch.message = b.message || null;
  const next = await deps.store.setControl(patch);
  deps.control?.invalidate();
  deps.log("warn", "control_changed", { user: await deps.userHash(c.userId), reason: `mode=${next.mode} max=${next.maxActiveSessions ?? "none"}` });
  return ok({ mode: next.mode, max_active_sessions: next.maxActiveSessions, message: next.message, course_max_generating: next.courseMaxGenerating ?? null });
}
