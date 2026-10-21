// supabase-store.ts - production Store: PostgREST reads/writes plus the it_ai_* functions, all via the service role.
// No raw SQL is ever built from user input; every value travels as a typed parameter.
import { LIMITS, MODELS, RETENTION } from "./config.ts";
import { assertTransition } from "./session-machine.ts";
import type { SessionState } from "./schemas.ts";
import type { IngestChunk, MeetingRequest, ReviewDetail, ReviewList, ReviewReason, BeginResult, BeginTurnInput, CourseAccess, CourseSettings, FinishTurnInput, LearningEvent, MasteryRow, Message, PracticeItem, ProgressSummary, Role, SessionRow, Store, StoredKey, SessionMetrics } from "./store.ts";
import { type Control, isMode } from "./resilience.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;   // the supabase-js client; typed loosely so tests can pass a SQL-backed fake with the same surface

export const DEFAULT_SETTINGS: CourseSettings = {
  enabled: false, retentionDays: RETENTION.defaultDays, studentDailyTokens: LIMITS.defaultStudentDailyTokens, courseMonthlyUsd: LIMITS.defaultCourseMonthlyUsd, model: MODELS.default,
  aiPolicy: "full", allowWorkedSolutions: true, blockDuringAssessments: true, learningRecordDays: 180, storeMastery: true,
  reviewEnabled: false, reviewShowSolutions: true, payer: "instructor",
};
const POLICIES = ["full", "hints_only", "concepts_only"];
export function mapSettings(s: Record<string, any>): CourseSettings {
  return {
    enabled: !!s.enabled, retentionDays: s.retention_days, studentDailyTokens: s.student_daily_tokens, courseMonthlyUsd: Number(s.course_monthly_usd), model: s.model,
    aiPolicy: POLICIES.includes(s.ai_policy) ? s.ai_policy : "full", allowWorkedSolutions: s.allow_worked_solutions !== false, blockDuringAssessments: s.block_during_assessments !== false,
    learningRecordDays: typeof s.learning_record_days === "number" ? s.learning_record_days : 180, storeMastery: s.store_mastery !== false,
    reviewEnabled: s.review_enabled === true, reviewShowSolutions: s.review_show_solutions !== false, payer: s.payer === "platform" ? "platform" : "instructor",
  };
}
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

function mapSession(r: Record<string, any>): SessionRow {
  return { id: r.id, courseId: r.course_id, userId: r.user_id, state: r.state, startedAt: r.started_at, lastActivityAt: r.last_activity_at, endedAt: r.ended_at ?? null, retentionDays: r.retention_days };
}

export class SupabaseStore implements Store {
  constructor(private db: Admin) {}

  private async one<T = any>(q: PromiseLike<{ data: T | null; error: any }>): Promise<T | null> {
    const { data, error } = await q; if (error) throw new Error(`db: ${error.message ?? "error"}`); return data;
  }

  async getRole(userId: string): Promise<Role | null> {
    const r = await this.one(this.db.from("it_profiles").select("role").eq("id", userId).maybeSingle());
    return r ? (r.role as Role) : null;
  }

  async getCourseAccess(userId: string, courseId: string, now: Date): Promise<CourseAccess> {
    const empty = (reason: CourseAccess["reason"]): CourseAccess => ({ allowed: false, reason, isStaff: false, ownerId: "", title: "", term: null, settings: DEFAULT_SETTINGS });
    const course = await this.one(this.db.from("it_courses").select("id,owner_id,title,term,is_active,access_starts,access_ends,requires_payment").eq("id", courseId).maybeSingle());
    if (!course) return empty("not_found");
    const [srow, role, staff] = await Promise.all([
      this.one(this.db.from("it_ai_settings").select("*").eq("course_id", courseId).maybeSingle()),
      this.one(this.db.from("it_profiles").select("role,full_name").eq("id", userId).maybeSingle()),
      this.one(this.db.from("it_course_staff").select("can_view,can_grade,can_edit").eq("course_id", courseId).eq("user_id", userId).maybeSingle()),
    ]);
    const settings: CourseSettings = srow ? mapSettings(srow) : DEFAULT_SETTINGS;
    const studentName = firstName(role?.full_name);
    const platformKeyOwner = settings.payer === "platform" ? (await this.platformKeyOwner()) ?? undefined : undefined;
    const base = { ...(studentName ? { studentName } : {}), ownerId: course.owner_id as string, title: course.title as string, term: (course.term ?? null) as string | null, settings, ...(platformKeyOwner ? { platformKeyOwner } : {}) };
    const isStaff = course.owner_id === userId || role?.role === "admin" || !!(staff && (staff.can_view || staff.can_grade || staff.can_edit));
    if (isStaff) return { allowed: true, isStaff: true, ...base };

    const enr = await this.one(this.db.from("it_enrollments").select("status").eq("course_id", courseId).eq("student_id", userId).maybeSingle());
    if (!enr || enr.status !== "active") return { allowed: false, reason: "not_enrolled", isStaff: false, ...base };
    if (!course.is_active) return { allowed: false, reason: "inactive", isStaff: false, ...base };
    const today = dateOnly(now);
    if ((course.access_starts && today < course.access_starts) || (course.access_ends && today > course.access_ends)) return { allowed: false, reason: "expired", isStaff: false, ...base };
    if (course.requires_payment) {
      const [sub, waiver] = await Promise.all([
        this.one(this.db.from("it_subscriptions").select("status,expires_at").eq("course_id", courseId).eq("student_id", userId).maybeSingle()),
        this.one(this.db.from("it_fee_waivers").select("id").eq("course_id", courseId).eq("student_id", userId).limit(1).maybeSingle()),
      ]);
      const paid = !!sub && sub.status === "active" && (!sub.expires_at || new Date(sub.expires_at) > now);
      if (!paid && !waiver) return { allowed: false, reason: "payment_required", isStaff: false, ...base };
    }
    return { allowed: true, isStaff: false, ...base };
  }

  async platformKeyOwner(): Promise<string | null> {
    const admins = await this.db.from("it_profiles").select("id").eq("role", "admin");
    if (admins.error) throw new Error("db: platform key lookup failed");
    const ids = (admins.data ?? []).map((r: { id: string }) => r.id);
    if (!ids.length) return null;
    const r = await this.db.from("it_ai_keys").select("owner_id").in("owner_id", ids).order("updated_at", { ascending: true }).limit(1);
    if (r.error) throw new Error("db: platform key lookup failed");
    return r.data?.[0]?.owner_id ?? null;
  }

  async getStoredKey(ownerId: string): Promise<StoredKey | null> {
    const r = await this.one(this.db.from("it_ai_keys").select("ciphertext,iv,model,last4,updated_at,provider,base_url,price_in,price_out").eq("owner_id", ownerId).maybeSingle());
    return r ? { ciphertext: r.ciphertext, iv: r.iv, model: r.model, last4: r.last4, updatedAt: r.updated_at, provider: r.provider ?? "anthropic", baseUrl: r.base_url ?? null, priceIn: r.price_in === null || r.price_in === undefined ? null : Number(r.price_in), priceOut: r.price_out === null || r.price_out === undefined ? null : Number(r.price_out) } : null;
  }
  async putStoredKey(ownerId: string, k: Omit<StoredKey, "updatedAt">): Promise<void> {
    const { error } = await this.db.from("it_ai_keys").upsert({ owner_id: ownerId, ciphertext: k.ciphertext, iv: k.iv, model: k.model, last4: k.last4, provider: k.provider, base_url: k.baseUrl, price_in: k.priceIn, price_out: k.priceOut, updated_at: new Date().toISOString() }, { onConflict: "owner_id" });
    if (error) throw new Error("db: key save failed");
  }
  async deleteStoredKey(ownerId: string): Promise<void> { const { error } = await this.db.from("it_ai_keys").delete().eq("owner_id", ownerId); if (error) throw new Error("db: key delete failed"); }

  async setSettings(courseId: string, p: Partial<CourseSettings>): Promise<CourseSettings> {
    const cur = (await this.getCourseSettings(courseId));
    const next = { ...cur, ...p };
    const { error } = await this.db.from("it_ai_settings").upsert({ course_id: courseId, enabled: next.enabled, retention_days: next.retentionDays, student_daily_tokens: next.studentDailyTokens, course_monthly_usd: next.courseMonthlyUsd, model: next.model, ai_policy: next.aiPolicy, allow_worked_solutions: next.allowWorkedSolutions, block_during_assessments: next.blockDuringAssessments, learning_record_days: next.learningRecordDays, store_mastery: next.storeMastery, ...("reviewEnabled" in p || "reviewShowSolutions" in p ? { review_enabled: next.reviewEnabled, review_show_solutions: next.reviewShowSolutions } : {}), ...("payer" in p ? { payer: next.payer } : {}), updated_at: new Date().toISOString() }, { onConflict: "course_id" });
    if (error) throw new Error("db: settings save failed");
    return next;
  }
  private async getCourseSettings(courseId: string): Promise<CourseSettings> {
    const s = await this.one(this.db.from("it_ai_settings").select("*").eq("course_id", courseId).maybeSingle());
    return s ? mapSettings(s) : DEFAULT_SETTINGS;
  }

  async createSession(userId: string, courseId: string, retentionDays: number, _now: Date) {
    const { data, error } = await this.db.rpc("it_ai_create_session", { p_user: userId, p_course: courseId, p_retention: retentionDays, p_max_per_day: LIMITS.sessionsPerUserPerDay });
    if (error) throw new Error("db: create session failed");
    return data.ok ? { ok: true as const, session: mapSession(data.session) } : { ok: false as const, code: "rate_limited" as const };
  }
  async getSession(id: string): Promise<SessionRow | null> {
    const r = await this.one(this.db.from("it_ai_sessions").select("*").eq("id", id).maybeSingle());
    return r ? mapSession(r) : null;
  }
  async setSessionState(id: string, to: SessionState): Promise<SessionState> {
    const cur = await this.getSession(id); if (!cur) throw new Error("session missing");
    if (cur.state === to) return to;
    assertTransition(cur.state, to);
    const { data, error } = await this.db.from("it_ai_sessions").update({ state: to, last_activity_at: new Date().toISOString() }).eq("id", id).eq("state", cur.state).select("state");
    if (error) throw new Error("db: state update failed");
    return data && data.length ? to : ((await this.getSession(id))?.state ?? cur.state);   // lost a race: report the actual state
  }
  async endSession(id: string) { const { error } = await this.db.rpc("it_ai_end_session", { p_session: id }); if (error) throw new Error("db: end session failed"); }

  async beginTurn(i: BeginTurnInput): Promise<BeginResult> {
    const { data, error } = await this.db.rpc("it_ai_begin_turn", {
      p_session: i.sessionId, p_user: i.userId, p_course: i.courseId, p_client_turn: i.clientTurnId, p_text: i.text,
      p_user_per_min: LIMITS.userTurnsPerMinute, p_user_per_day: LIMITS.userTurnsPerDay, p_session_per_hour: LIMITS.sessionTurnsPerHour,
      p_student_daily_tokens: i.settings.studentDailyTokens, p_course_monthly_usd: i.settings.courseMonthlyUsd, p_course_max_generating: i.maxGenerating ?? LIMITS.courseMaxConcurrentGenerating,
      p_stale_seconds: Math.round(LIMITS.generatingStaleAfterMs / 1000), p_idle_ttl_seconds: Math.round(LIMITS.sessionIdleTtlMs / 1000), p_now: i.now.toISOString(),
    });
    if (error) throw new Error("db: begin turn failed");
    switch (data.kind) {
      case "ok": return { kind: "ok", turnId: data.turn_id, seq: data.seq };
      case "duplicate": return { kind: "duplicate", turnId: data.turn_id, status: data.status };
      case "in_progress": return { kind: "in_progress", turnId: data.turn_id };
      case "rate_limited": return { kind: "rate_limited", retryAfterS: data.retry_after_s, scope: data.scope };
      case "budget": return { kind: "budget", scope: data.scope };
      case "busy": return { kind: "busy", retryAfterS: data.retry_after_s };
      case "session_ended": return { kind: "session_ended" };
      default: return { kind: "session_not_found" };
    }
  }
  async turnStatus(turnId: string) {
    const r = await this.one(this.db.from("it_ai_turns").select("status").eq("id", turnId).maybeSingle());
    return (r ? r.status : "missing") as "generating" | "completed" | "interrupted" | "failed" | "missing";
  }
  async listMessages(sessionId: string, afterSeq = 0): Promise<Message[]> {
    const { data, error } = await this.db.from("it_ai_messages").select("seq,role,content,turn_id,interrupted").eq("session_id", sessionId).gt("seq", afterSeq).order("seq", { ascending: true }).limit(200);
    if (error) throw new Error("db: list messages failed");
    return (data ?? []).map((m: any) => ({ seq: m.seq, role: m.role, content: m.content, turnId: m.turn_id, interrupted: m.interrupted }));
  }
  async finishTurn(i: FinishTurnInput): Promise<boolean> {
    const u = i.usage;
    const { data, error } = await this.db.rpc("it_ai_finish_turn", {
      p_turn: i.turnId, p_status: i.status, p_text: i.assistantText, p_error: i.errorCode ?? null, p_end_state: i.endState,
      p_course: u.courseId, p_user: u.userId, p_session: u.sessionId, p_model: u.model, p_in: u.inputTokens, p_out: u.outputTokens,
      p_cache_read: u.cacheReadTokens, p_cache_write: u.cacheWriteTokens, p_cost: u.costMicroUsd, p_latency: Math.round(u.latencyMs), p_ttft: u.ttftMs === null ? null : Math.round(u.ttftMs),
      p_idle_ttl_seconds: Math.round(LIMITS.sessionIdleTtlMs / 1000), p_now: new Date().toISOString(),
    });
    if (error) throw new Error("db: finish turn failed");
    return data === true;
  }
  async interruptTurn(sessionId: string, userId: string, clientTurnId: string, spoken: number | null): Promise<boolean> {
    const { data, error } = await this.db.rpc("it_ai_interrupt_turn", { p_session: sessionId, p_user: userId, p_client_turn: clientTurnId, p_spoken: spoken });
    if (error) throw new Error("db: interrupt failed"); return data === true;
  }
  async ingestMaterials(courseId: string, src: { id: string; title: string; kind: string }, chunks: IngestChunk[], replace: boolean): Promise<number> {
    const s = await this.db.from("it_ai_sources").upsert({ id: src.id, title: src.title, kind: src.kind, version: new Date().toISOString().slice(0, 10), ingested_at: new Date().toISOString() }, { onConflict: "id" });
    if (s.error) throw new Error("db: source save failed");
    if (replace) { const d = await this.db.from("it_ai_chunks").delete().eq("source_id", src.id); if (d.error) throw new Error("db: chunk clear failed"); }
    const rows = chunks.map((c) => ({ chunk_key: c.chunk_key, source_id: src.id, source_key: c.source_key, chapter: c.chapter, section: c.section, heading: c.heading, kind: c.kind, ord: c.ord, pos: c.pos, title: c.title, body: c.body }));
    const u = await this.db.from("it_ai_chunks").upsert(rows, { onConflict: "chunk_key" });
    if (u.error) throw new Error("db: chunk save failed");
    const l = await this.db.from("it_ai_course_sources").upsert({ course_id: courseId, source_id: src.id, max_chapter: null }, { onConflict: "course_id,source_id", ignoreDuplicates: true });
    if (l.error) throw new Error("db: course link failed");
    return rows.length;
  }
  // ---- operations (migration 002) ----
  async getControl(): Promise<Control | null> {
    const { data, error } = await this.db.rpc("it_ai_get_control", {}); if (error) throw new Error("db: control read failed");
    return data ? { mode: isMode(data.mode) ? data.mode : "normal", maxActiveSessions: typeof data.max_active_sessions === "number" ? data.max_active_sessions : null, message: data.message ?? null, courseMaxGenerating: typeof data.course_max_generating === "number" ? data.course_max_generating : null } : null;
  }
  async setControl(patch: Partial<Control>): Promise<Control> {
    const { data, error } = await this.db.rpc("it_ai_set_control", { p_mode: patch.mode ?? null, p_max: typeof patch.maxActiveSessions === "number" ? patch.maxActiveSessions : null, p_clear_max: patch.maxActiveSessions === null, p_message: patch.message ?? null, p_set_message: "message" in patch, p_max_gen: typeof patch.courseMaxGenerating === "number" ? patch.courseMaxGenerating : null, p_clear_max_gen: patch.courseMaxGenerating === null });
    if (error) throw new Error("db: control write failed");
    return { mode: data.mode, maxActiveSessions: data.max_active_sessions ?? null, message: data.message ?? null, courseMaxGenerating: data.course_max_generating ?? null };
  }
  async countActiveSessions(withinSeconds: number): Promise<number> {
    const { data, error } = await this.db.rpc("it_ai_count_active", { p_seconds: withinSeconds }); if (error) throw new Error("db: count failed"); return Number(data ?? 0);
  }
  async reportUsage(sessionId: string, userId: string, m: SessionMetrics): Promise<boolean> {
    const j = { asr_ms: m.asrMs, tts_ms: m.ttsMs, audio_in_ms: m.audioInMs, audio_out_ms: m.audioOutMs, avatar_bytes: m.avatarBytes, avatar_init_ms: m.avatarInitMs, ttfa_ms: m.ttfaMs, turns: m.turns, interruptions: m.interruptions, sync_errors: m.syncErrors, audio_drops: m.audioDrops, text_only: m.textOnly };
    const { data, error } = await this.db.rpc("it_ai_report_usage", { p_session: sessionId, p_user: userId, p_m: j }); if (error) throw new Error("db: report failed"); return data === true;
  }
  async courseSpend(courseId: string, now: Date) {
    const { data, error } = await this.db.rpc("it_ai_course_spend", { p_course: courseId, p_now: now.toISOString() }); if (error) throw new Error("db: spend failed");
    return { monthUsd: Number(data?.month_usd ?? 0), todayTurns: Number(data?.today_turns ?? 0), activeSessions: Number(data?.active_sessions ?? 0) };
  }

  async purgeExpired(now: Date): Promise<number> {
    const { data, error } = await this.db.rpc("it_ai_purge", { p_now: now.toISOString(), p_idle_ttl_seconds: Math.round(LIMITS.sessionIdleTtlMs / 1000) });
    if (error) throw new Error("db: purge failed"); return Number(data ?? 0);
  }

  async createPractice(userId: string, courseId: string, sessionId: string, p: Omit<PracticeItem, "id" | "attempts" | "solved" | "hinted">) {
    const { count } = await this.db.from("it_ai_practice").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("user_id", userId);
    if ((count ?? 0) >= LIMITS.maxPracticePerSession) return { error: "limit" as const };
    const r = await this.one(this.db.from("it_ai_practice").insert({ user_id: userId, course_id: courseId, session_id: sessionId, topic: p.topic, topic_key: p.topicKey, question: p.question, answer: p.answer, answer_kind: p.answerKind, hints: p.hints }).select("id").single());
    return { id: r.id as string };
  }
  async getPractice(userId: string, sessionId: string, id: string): Promise<PracticeItem | null> {
    const r = await this.one(this.db.from("it_ai_practice").select("*").eq("id", id).eq("user_id", userId).eq("session_id", sessionId).maybeSingle());
    return r ? { id: r.id, topic: r.topic, topicKey: r.topic_key ?? null, question: r.question, answer: r.answer, answerKind: r.answer_kind, hints: r.hints ?? [], attempts: r.attempts, solved: r.solved, hinted: !!r.hinted } : null;
  }
  async recordPracticeAttempt(userId: string, id: string, solved: boolean, hinted = false) {
    const { error } = await this.db.rpc("it_ai_practice_attempt", { p_id: id, p_user: userId, p_solved: solved }); if (error) throw new Error("db: attempt failed");
    if (hinted) await this.db.from("it_ai_practice").update({ hinted: true }).eq("id", id).eq("user_id", userId);
  }
  async recordEvent(userId: string, courseId: string, sessionId: string, idemKey: string, ev: LearningEvent): Promise<"recorded" | "duplicate"> {
    const { data, error } = await this.db.from("it_ai_events").upsert({ user_id: userId, course_id: courseId, session_id: sessionId, idem_key: idemKey, event: ev.event, topic: ev.topic, detail: ev.detail ?? null, note: null }, { onConflict: "idem_key", ignoreDuplicates: true }).select("id");
    if (error) throw new Error("db: event failed");
    return data && data.length ? "recorded" : "duplicate";
  }
  async getProgress(userId: string, courseId: string): Promise<ProgressSummary> {
    const [prog, evs] = await Promise.all([
      this.db.from("it_chapter_progress").select("chapter,reading_done,quiz_passed").eq("student_id", userId).eq("course_id", courseId),
      this.db.from("it_ai_events").select("event,topic,created_at").eq("user_id", userId).eq("course_id", courseId).order("created_at", { ascending: false }).limit(100),
    ]);
    const rows: any[] = prog.data ?? [], events: any[] = evs.data ?? [];
    const topics: string[] = []; for (const e of events) if (!topics.includes(e.topic) && topics.length < 5) topics.push(e.topic);
    return {
      chaptersRead: rows.filter((r) => r.reading_done).map((r) => r.chapter).sort((a, b) => a - b),
      quizzesPassed: rows.filter((r) => r.quiz_passed).map((r) => r.chapter).sort((a, b) => a - b),
      practiceAsked: events.filter((e) => e.event === "practice_attempted").length, practiceSolved: events.filter((e) => e.event === "practice_solved").length, recentTopics: topics,
    };
  }

  // ---- learning records and the assessment boundary (migration 003) ----
  async assessmentActive(userId: string, courseId: string, now: Date): Promise<boolean> {
    const { data, error } = await this.db.rpc("it_ai_assessment_active", { p_user: userId, p_course: courseId, p_now: now.toISOString() });
    if (error) throw new Error("db: assessment check failed"); return data === true;
  }
  async updateMastery(userId: string, courseId: string, topicKey: string, correct: boolean, weight: number): Promise<void> {
    const { error } = await this.db.rpc("it_ai_update_mastery", { p_user: userId, p_course: courseId, p_topic: topicKey, p_correct: correct, p_weight: weight });
    if (error) throw new Error("db: mastery failed");
  }
  async getMastery(userId: string, courseId: string): Promise<MasteryRow[]> {
    const { data, error } = await this.db.from("it_ai_mastery").select("topic_key,alpha,beta,attempts,last_at").eq("user_id", userId).eq("course_id", courseId).order("last_at", { ascending: false }).limit(50);
    if (error) throw new Error("db: mastery read failed");
    return (data ?? []).map((r: any) => ({ topicKey: r.topic_key, alpha: Number(r.alpha), beta: Number(r.beta), attempts: r.attempts, lastAt: r.last_at }));
  }
  async saveFeedback(userId: string, courseId: string, sessionId: string, turnId: string | null, rating: "helpful" | "not_helpful", reason: string | null): Promise<void> {
    const row = { user_id: userId, course_id: courseId, session_id: sessionId, turn_id: turnId, rating, reason };
    const { error } = turnId ? await this.db.from("it_ai_feedback").upsert(row, { onConflict: "user_id,turn_id" }) : await this.db.from("it_ai_feedback").insert(row);
    if (error) throw new Error("db: feedback failed");
  }
  async deleteLearnerData(userId: string, courseId: string) {
    const { data, error } = await this.db.rpc("it_ai_delete_learner_data", { p_user: userId, p_course: courseId });
    if (error) throw new Error("db: delete failed");
    return { events: Number(data?.events ?? 0), mastery: Number(data?.mastery ?? 0), feedback: Number(data?.feedback ?? 0), sessions: Number(data?.sessions ?? 0) };
  }
  // ---- graded-work review (migration 005): every rule is re-checked inside the database functions ----
  private async rpcJson(name: string, args: Record<string, unknown>) {
    const { data, error } = await this.db.rpc(name, args);
    if (error) throw new Error(`db: ${name} failed`);
    return data as any;
  }
  async reviewConsentGet(userId: string, courseId: string) {
    const d = await this.rpcJson("it_ai_review_consent_get", { p_user: userId, p_course: courseId });
    return { granted: d?.granted === true, updatedAt: d?.updated_at ?? null, textVersion: Number(d?.text_version ?? 1) };
  }
  async reviewConsentSet(userId: string, courseId: string, granted: boolean, version: number) {
    const d = await this.rpcJson("it_ai_review_consent_set", { p_user: userId, p_course: courseId, p_granted: granted, p_version: version });
    return d?.ok ? { ok: true, granted: d.granted === true, updatedAt: d.updated_at ?? null, textVersion: Number(d.text_version ?? version) } : { ok: false, reason: String(d?.reason ?? "failed") };
  }
  async reviewList(userId: string, courseId: string, now: Date): Promise<ReviewList> {
    const d = await this.rpcJson("it_ai_review_list", { p_user: userId, p_course: courseId, p_now: now.toISOString() });
    if (!d?.allowed) return { allowed: false, reason: (d?.reason ?? "not_enrolled") as ReviewReason };
    return { allowed: true, items: (d.items ?? []).map((i: any) => ({ ref: i.ref, kind: i.kind, title: i.title, closesAt: i.closes_at ?? null, submittedAt: i.submitted_at ?? null, items: Number(i.items ?? 0), reviewable: i.reviewable === true, reason: i.reason ?? null })) };
  }
  async reviewGet(userId: string, courseId: string, ref: string, solutions: boolean, sessionId: string | null, now: Date): Promise<ReviewDetail> {
    const d = await this.rpcJson("it_ai_review_get", { p_user: userId, p_course: courseId, p_ref: ref, p_solutions: solutions, p_session: sessionId, p_now: now.toISOString() });
    if (!d?.allowed) return { allowed: false, reason: (d?.reason ?? "not_found") as ReviewReason, closesAt: d?.closes_at ?? null };
    return { allowed: true, kind: String(d.kind), title: String(d.title), closesAt: d.closes_at ?? null, solutionsIncluded: d.solutions_included === true, items: Array.isArray(d.items) ? d.items : [] };
  }
  async reviewLogMine(userId: string, courseId: string) { const d = await this.rpcJson("it_ai_review_log_mine", { p_user: userId, p_course: courseId }); return (Array.isArray(d) ? d : []).map((r: any) => ({ kind: String(r.kind), at: String(r.at) })); }
  async requestMeeting(userId: string, courseId: string, withWhom: "ta" | "professor", topic: string, note: string | null) {
    const d = await this.rpcJson("it_ai_review_request_create", { p_user: userId, p_course: courseId, p_with: withWhom, p_topic: topic, p_note: note });
    return d?.ok ? { ok: true, id: String(d.id) } : { ok: false, reason: String(d?.reason ?? "failed") };
  }
  private mapReq(r: any): MeetingRequest { return { id: String(r.id), with: r.with === "professor" ? "professor" : "ta", topic: String(r.topic), note: r.note ?? null, status: r.status === "done" ? "done" : "open", createdAt: String(r.created_at), ...(r.student ? { student: String(r.student) } : {}) }; }
  async myMeetingRequests(userId: string, courseId: string) { const d = await this.rpcJson("it_ai_review_requests_mine", { p_user: userId, p_course: courseId }); return (Array.isArray(d) ? d : []).map((r: any) => this.mapReq(r)); }
  async listMeetingRequests(userId: string, courseId: string) {
    const d = await this.rpcJson("it_ai_review_requests_list", { p_user: userId, p_course: courseId });
    return d?.ok ? { ok: true, requests: (d.requests ?? []).map((r: any) => this.mapReq(r)) } : { ok: false, requests: [] };
  }
  async completeMeetingRequest(userId: string, courseId: string, id: string) { const d = await this.rpcJson("it_ai_review_request_done", { p_user: userId, p_course: courseId, p_id: id }); return d?.ok === true; }

}

/** A safe first name from a profile's full name: letters, marks, apostrophes and hyphens only, at most 30 characters; "" when nothing usable. */
export function firstName(full: unknown): string {
  const w = String(full ?? "").trim().split(/\s+/)[0] ?? "";
  const n = w.replace(/[^\p{L}\p{M}'’-]/gu, "").slice(0, 30);
  return n.length >= 2 ? n[0]!.toUpperCase() + n.slice(1) : "";
}
