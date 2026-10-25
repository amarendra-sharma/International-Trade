// converse.ts - one student turn: authorise, reserve the turn atomically, stream Claude, run allowlisted tools,
// persist exactly once. Pure orchestration over injected dependencies, so every failure path is unit-testable.
import { matchFigure } from "./figmatch.ts";
import { figureSpec } from "./visuals.ts";
import { getWalk, walkDirective } from "./reviewstate.ts";
import { LIMITS, LONG_PROMPT, courseSubject, hasFigures, MODELS, PRICES_USD_PER_MTOK, UNKNOWN_PRICE_USD_PER_MTOK, resolveBaseURL } from "./config.ts";
import { sleep as realSleep, withRetry } from "./retry.ts";
import { buildSystem } from "./prompt.ts";
import { retrieveForTurn } from "./content.ts";
import { directives } from "./teaching.ts";
import { DRAW_DIRECTIVE, drawCue, type DrawCue } from "./drawcue.ts";
import { runTool, toolDefinitionsForModel } from "./tools.ts";
import { decryptKey } from "./vault.ts";
import { ProviderError, type ContentBlock, type LlmProvider, type Msg, type Usage } from "./provider.ts";
import type { ContentRepo, Message, Store } from "./store.ts";
import type { ErrorBody, ErrorCode, SseEvent, TurnRequest } from "./schemas.ts";
import type { Logger } from "./log.ts";
import { Admission, type BreakerSet, type ControlCache, DEFAULT_CONTROL, type TtlCache } from "./resilience.ts";
import type { CourseAccess, StoredKey } from "./store.ts";

// The concurrency gate is now a bounded admission queue (resilience.ts); `new Semaphore(n)` still means "n slots, no waiting room".
export const Semaphore = Admission;
export type Semaphore = Admission;

export interface Deps {
  store: Store; provider: LlmProvider; content: ContentRepo; log: Logger; kek: string; userHash: (id: string) => Promise<string>;
  gate: Admission; control?: ControlCache; accessCache?: TtlCache<{ access: CourseAccess; stored: StoredKey | null }>; breakers?: BreakerSet; assessCache?: TtlCache<boolean>; admissionWaitMs?: number; now?: () => Date; rand?: () => number; sleep?: typeof realSleep; baseURL?: string; extraHosts?: string[]; platformKeyOwner?: string;
  timeouts?: Partial<{ firstEventMs: number; idleMs: number; totalMs: number; pollMs: number }>;
}
export interface Caller { userId: string }

/** Whose stored key pays for this course's AI: the platform's when a platform administrator set the course to "platform" and a platform key owner is configured; otherwise the course owner's. */
export const keyOwnerOf = (deps: { platformKeyOwner?: string }, a: { ownerId: string; platformKeyOwner?: string; settings: { payer?: string } }): string => a.settings.payer === "platform" ? (deps.platformKeyOwner || a.platformKeyOwner || "") : a.ownerId;

export class TimeoutError extends Error { constructor(public phase: "first" | "idle" | "total") { super(`timeout:${phase}`); } }

export const errBody = (error: ErrorCode, message: string, retryable: boolean, retry_after_s?: number): ErrorBody => ({ error, message, retryable, ...(retry_after_s ? { retry_after_s } : {}) });

/** Anthropic models use the published table. Any other provider uses the instructor's own prices when given, otherwise a deliberately high placeholder (so budget caps stop early rather than late). */
export function costMicroUsd(model: string, u: Usage, other?: { priceIn: number | null; priceOut: number | null }, longUsage?: Usage): number {
  if (other) {
    const pi = other.priceIn ?? UNKNOWN_PRICE_USD_PER_MTOK.input, po = other.priceOut ?? UNKNOWN_PRICE_USD_PER_MTOK.output;
    return Math.round((u.input + u.cacheRead + u.cacheWrite) * pi + u.output * po);
  }
  const p = PRICES_USD_PER_MTOK[model] ?? PRICES_USD_PER_MTOK[MODELS.default];
  const base = (x: Usage) => x.input * p.input + x.output * p.output + x.cacheRead * p.cacheRead + x.cacheWrite * p.cacheWrite;
  const lp = LONG_PROMPT[model];
  // `longUsage` is the sum of the requests in this turn whose prompt crossed the long-prompt line; those pay the extra multiple.
  return Math.round(base(u) + (longUsage && lp ? base(longUsage) * (lp.mult - 1) : 0));
}
/** True when one request's prompt is over the model's long-prompt line. */
export const isLongPrompt = (model: string, u: Usage): boolean => { const lp = LONG_PROMPT[model]; return !!lp && u.input + u.cacheRead + u.cacheWrite > lp.over; };
const addUsage = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

const estTokens = (s: string) => Math.ceil(s.length / 3.5);

// Build the model's message list from stored history: merge consecutive same-role messages (a failed turn leaves two user
// messages in a row), drop the oldest when over budget, and always start with a user message.
export function buildMessages(history: Message[]): Msg[] {
  const merged: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of history) {
    const text = m.interrupted && m.role === "assistant" ? `${m.content} [the student interrupted here]` : m.content;
    if (!text.trim()) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n" + text; else merged.push({ role: m.role, content: text });
  }
  let total = merged.reduce((a, m) => a + estTokens(m.content), 0);
  while (merged.length > 1 && (total > LIMITS.maxHistoryTokensEst || merged[0].role !== "user")) { total -= estTokens(merged[0].content); merged.shift(); }
  return merged;
}

function mapProviderError(e: unknown): ErrorBody {
  if (e instanceof TimeoutError) return errBody("timeout", "The instructor took too long to respond. Please ask again.", true);
  if (e instanceof ProviderError) {
    switch (e.kind) {
      case "auth": return errBody("provider_key_invalid", "The instructor's AI connection needs attention. Please tell your instructor.", false);
      case "rate_limit": return errBody("provider_busy", "The AI service is busy right now. Try again in a moment.", true, Math.ceil((e.retryAfterMs ?? 3000) / 1000));
      case "overloaded": case "server": case "network": return errBody("provider_unavailable", "The AI service is temporarily unavailable. Try again shortly.", true, 5);
      case "aborted": return errBody("interrupted", "Interrupted.", false);
      default: return errBody("internal", "Something went wrong on our side.", false);
    }
  }
  return errBody("internal", "Something went wrong on our side.", false);
}

export async function handleTurn(deps: Deps, caller: Caller, req: TurnRequest, clientSignal: AbortSignal, emit: (e: SseEvent) => void): Promise<void> {
  const { store, log } = deps, now = deps.now ?? (() => new Date()), sleep = deps.sleep ?? realSleep;
  const to = { firstEventMs: LIMITS.firstEventTimeoutMs, idleMs: LIMITS.idleTimeoutMs, totalMs: LIMITS.totalTurnTimeoutMs, pollMs: 2000, ...deps.timeouts };
  const fail = (b: ErrorBody) => emit({ event: "error", data: b });
  const user = await deps.userHash(caller.userId);
  const t0 = Date.now();

  // ---- authorise: session ownership, enrolment, course switch, instructor key -------------------------------------------------
  // database reads for authorisation are guarded by a breaker: during a DB outage we refuse fast instead of piling up requests
  const dbBreaker = deps.breakers?.get("db");
  const dbGate = dbBreaker?.check();
  if (dbGate && !dbGate.allowed) { log("warn", "turn_rejected", { code: "db_breaker_open" }); return fail(errBody("busy", "The instructor is temporarily unavailable. Please try again shortly.", true, dbGate.retryAfterS)); }
  let session, access, stored;
  try {
    session = await store.getSession(req.session_id);
    if (!session || session.userId !== caller.userId) { dbBreaker?.success(); return fail(errBody("session_not_found", "Session not found.", false)); }
    if (session.state === "ended") { dbBreaker?.success(); return fail(errBody("session_ended", "This session has ended. Start a new one.", false)); }
    const ck = `${caller.userId}:${session.courseId}`, hit = deps.accessCache?.get(ck);
    if (hit) ({ access, stored } = hit);
    else {
      access = await store.getCourseAccess(caller.userId, session.courseId, now());
      stored = access.allowed && keyOwnerOf(deps, access) ? await store.getStoredKey(keyOwnerOf(deps, access)) : null;
      deps.accessCache?.set(ck, { access, stored }, access.allowed && stored ? undefined : 3000);      // denials and "no key yet" are remembered only briefly
    }
    dbBreaker?.success();
  } catch (e) {
    dbBreaker?.failure(); log("error", "db_unavailable", { reason: e instanceof Error ? e.name : "unknown", session_id: req.session_id });
    return fail(errBody("busy", "The instructor is temporarily unavailable. Please try again shortly.", true, 5));
  }
  if (!access.allowed) return fail(errBody(access.reason === "not_found" ? "session_not_found" : "not_enrolled", "You do not have access to this course's AI instructor.", false));
  if (!access.settings.enabled && !access.isStaff) return fail(errBody("course_disabled", "The AI instructor is not turned on for this course.", false));
  if (!stored) return fail(errBody("no_instructor_key", "The AI instructor isn't set up yet. Please tell your instructor.", false));

  // ---- assessment boundary: no tutoring while this student has a quiz or exam open (instructors and TAs are exempt so they can test) -----
  // Fails CLOSED: if the check itself cannot be answered the student is asked to retry, because guessing "no exam" could undermine one.
  if (access.settings.blockDuringAssessments && !access.isStaff) {
    const ck = `a:${caller.userId}:${session.courseId}`;
    let locked = deps.assessCache?.get(ck);
    if (locked === undefined) {
      try { locked = await store.assessmentActive(caller.userId, session.courseId, now()); deps.assessCache?.set(ck, locked); dbBreaker?.success(); }
      catch { dbBreaker?.failure(); log("error", "db_unavailable", { reason: "assessment_check", session_id: session.id }); return fail(errBody("busy", "The instructor is temporarily unavailable. Please try again shortly.", true, 5)); }
    }
    if (locked) { log("info", "turn_rejected", { code: "assessment_in_progress", course_id: session.courseId }); return fail(errBody("assessment_in_progress", "The AI instructor is switched off while a quiz or exam is open. It will be back as soon as you submit.", false)); }
  }

  // ---- operator switch and provider breakers: refuse BEFORE reserving a turn, so nothing is billed, counted or stored ----------------
  const ctl = deps.control ? await deps.control.get() : DEFAULT_CONTROL;
  if (ctl.mode === "paused") return fail(errBody("paused", ctl.message ?? "The AI instructor is paused for maintenance. Please try again later.", true, 60));
  const ownerBreaker = deps.breakers?.get(`key:${keyOwnerOf(deps, access)}`), globalBreaker = deps.breakers?.get("anthropic");
  for (const b of [ownerBreaker, globalBreaker]) {
    const c = b?.check();
    if (c && !c.allowed) { log("warn", "turn_rejected", { code: "provider_breaker_open", course_id: session.courseId }); return fail(errBody("provider_unavailable", "The AI service is temporarily unavailable. Try again shortly.", true, c.retryAfterS)); }
  }

  const admitted = await deps.gate.acquire(deps.admissionWaitMs ?? 0);
  if (admitted !== "ok") { log("warn", "turn_rejected", { code: "busy", course_id: session.courseId, reason: admitted }); return fail(errBody("busy", "The instructor is handling many students right now. Try again in a few seconds.", true, 3)); }
  let turnId = "";
  const ac = new AbortController();
  const onClientAbort = () => ac.abort(new DOMException("client", "AbortError"));
  if (clientSignal.aborted) onClientAbort(); else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  const timers: number[] = [];
  let assistantText = "", usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, longUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ttft: number | null = null;
  const otherProvider = stored.provider && stored.provider !== "anthropic";
  const model = stored.model && (MODELS.allowed as readonly string[]).includes(stored.model) ? stored.model : MODELS.default;
  // Claude: the course may pick among the allowed Claude models. Any other provider: the model the instructor saved with the key (the course-level Claude picker does not apply).
  const chosenModel = otherProvider ? stored.model : access.settings.model && (MODELS.allowed as readonly string[]).includes(access.settings.model) ? access.settings.model : model;
  const providerBase = otherProvider ? (deps.baseURL ?? resolveBaseURL(stored.provider, stored.baseUrl, deps.extraHosts ?? [])) : (deps.baseURL ?? undefined);
  const priceOverride = otherProvider ? { priceIn: stored.priceIn, priceOut: stored.priceOut } : undefined;

  try {
    if (otherProvider && !providerBase) return fail(errBody("no_instructor_key", "The AI instructor isn't set up correctly yet. Please tell your instructor.", false));   // inside try: the finally block releases the admission slot
    // ---- reserve the turn atomically (dedupe, rate limits, budgets, concurrency) ------------------------------------------------
    const begin = await store.beginTurn({ sessionId: session.id, userId: caller.userId, courseId: session.courseId, clientTurnId: req.client_turn_id, text: req.text, settings: access.settings, now: now(), maxGenerating: ctl.courseMaxGenerating ?? undefined });
    switch (begin.kind) {
      case "duplicate": return fail(errBody("duplicate", "That message was already received.", false));
      case "in_progress": return fail(errBody("in_progress", "That message is still being answered.", true, 2));
      case "rate_limited": return fail(errBody("rate_limited", "You're sending messages too quickly. Please wait a moment.", true, begin.retryAfterS));
      case "budget": return fail(errBody("budget_exhausted", begin.scope === "student" ? "You've reached today's limit for the AI instructor. It resets tomorrow." : "This course's AI instructor budget is used up for now. Please tell your instructor.", false));
      case "busy": return fail(errBody("busy", "The instructor is handling many students right now. Try again in a few seconds.", true, begin.retryAfterS));
      case "session_ended": return fail(errBody("session_ended", "This session has ended.", false));
      case "session_not_found": return fail(errBody("session_not_found", "Session not found.", false));
    }
    turnId = begin.turnId;
    log("info", "turn_start", { course_id: session.courseId, session_id: session.id, turn_id: turnId, user, model: chosenModel });
    emit({ event: "accepted", data: { turn_id: turnId } });

    // slow, independent steps start now and are awaited only when needed; the database reads, the key and the book all overlap
    // Every turn sends the table of contents plus only the chapters the question is about (voice: two, typed: up to three). The whole book is about
    // 110k tokens, which is slow and, on Haiku 5.5, is billed at five times the rate above 100k. Providers without prompt caching, or content without chapter data, keep the old path.
    let visualShown = false, truncatedOnce = false, noTools = false, shownFig = "", forceDraw = false, forcedOnce = false;
    const voiceFast = !otherProvider && !!deps.content.bookData;
    const maxChapters = req.input_mode === "voice" ? 2 : 3, maxChars = req.input_mode === "voice" ? 70_000 : 100_000;
    const keyP = decryptKey(stored.ciphertext, stored.iv, keyOwnerOf(deps, access), deps.kek);
    keyP.catch(() => {});
    const within = <T,>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
    const bookP: Promise<string> = (!voiceFast && !otherProvider && deps.content.fullText)
      ? within(deps.content.fullText(session.courseId), 8000).catch(() => { log("warn", "textbook_unavailable", { turn_id: turnId }); return ""; })
      : Promise.resolve("");
    const dataP = voiceFast ? within(deps.content.bookData!(session.courseId), 6000).catch(() => { log("warn", "textbook_unavailable", { turn_id: turnId }); return null; }) : Promise.resolve(null);
    dataP.catch(() => {});
    // ---- teaching directives (mode, hint-before-answer, instructor rules) and course retrieval, both decided here on the server ------
    const reviewOn = access.settings.reviewEnabled === true && !!store.reviewList;            // the review tools exist only when the course owner turned review on
    const dir = directives({ mode: req.mode, text: req.text, settings: access.settings, review: reviewOn, subject: courseSubject(session.courseId) });
    const cue: DrawCue = !hasFigures(session.courseId) && !dir.flags.length && dir.mode !== "review" ? drawCue(req.text) : null;
    const hist = await store.listMessages(session.id);
    const prevUser = [...hist].reverse().find((m) => m.role === "user" && m.turnId !== turnId)?.content;
    const [apiKey, retrieval] = await Promise.all([keyP, retrieveForTurn(deps.content, { userId: caller.userId, courseId: session.courseId, chapter: req.context?.chapter ?? null }, req.text, { mode: dir.mode, topic: req.context?.topic, previousUser: prevUser })]);
    log("info", "retrieval", { turn_id: turnId, reason: `${retrieval.coverage}/${retrieval.strategy}`, count: retrieval.passages.length, latency_ms: retrieval.ms, ...(dir.flags.length ? { code: "restricted_request" } : {}) });
    const textbook = await bookP;
    let focused: { toc: string; text: string } | undefined;
    if (voiceFast) {
      const data = await dataP;
      if (data && (data.toc || data.chapters.size)) {
        const want: number[] = [];
        if (retrieval.coverage === "strong") for (const p of retrieval.passages) if (typeof p.chapter === "number" && !want.includes(p.chapter)) want.push(p.chapter);
        if (!want.length && typeof req.context?.chapter === "number") want.push(req.context.chapter);
        let text = "", used = 0;
        for (const ch of want.slice(0, 3)) { const t = data.chapters.get(ch); if (!t) continue; if (used && text.length + t.length > maxChars) break; text += (text ? "\n\n" : "") + t; used++; if (used >= maxChapters) break; }
        focused = { toc: data.toc, text };
      }
    }
    const preMs = Date.now() - t0;
    // The textbook figure the question is about goes onto the whiteboard NOW, before the model speaks, so the first spoken sentence already has the axes in front of the student.
    let preFig: ReturnType<typeof matchFigure> = null;
    if (hasFigures(session.courseId) && !dir.flags.length && dir.mode !== "review") { try { preFig = matchFigure(req.text); } catch { preFig = null; } }
    let figDirective = "";
    if (preFig) {
      const spec = figureSpec(preFig.num);
      figDirective = `FIGURE ALREADY ON THE WHITEBOARD: the textbook's Figure ${spec.num} (${spec.title}) is already showing next to you. Do NOT call show_figure or show_graph for it. The board reveals one step each time you start a new sentence and highlights it while you talk. Steps in order: ${spec.panels.flatMap((x) => x.steps.map((s) => s.label)).map((x, n) => (n + 1) + ") " + x).join("; ")}. Do not announce or introduce the figure ("here is", "on your board", "before I start"); your FIRST sentence must already describe step 1 (the axes), then one or two short sentences per step in exactly that order, then what it means. The colours and solid/dashed styles in the step list are exact facts about the picture: never call a solid curve dashed or the reverse. Which curve is the original and which the shifted one comes ONLY from the book's explanation below; where it names a style or colour (for example "solid violet"), use exactly that, and where it does not, say "the solid purple curve" or "the dashed purple curve" by appearance without claiming which is which. The book's own explanation (use it, add nothing that contradicts it): ${spec.caption}`;
      visualShown = true; shownFig = spec.num; emit({ event: "visual", data: { ...spec, early: true } });
    }
    const system = buildSystem({ noFigures: !hasFigures(session.courseId), studentName: access.studentName, textbook, focused, courseTitle: access.title, term: access.term, chapter: req.context?.chapter, view: req.context?.view, topic: req.context?.topic, directives: [dir.block, reviewOn ? ((w) => w ? walkDirective(w) : "")(getWalk(session.id) ?? (await store.walkGet?.(session.id, caller.userId).then((x) => x ? { ...x, at: Date.now() } : null).catch(() => null))) : "", figDirective, cue ? DRAW_DIRECTIVE[cue] : "", req.input_mode === "voice" ? "VOICE: The student has just heard a brief spoken acknowledgment (such as \"Good question\" or \"Sure, one moment\"). Do not open with an acknowledgment, praise, \"Let me draw that\" or \"Let me think\". Begin with the substance in your first sentence; if you will draw, say in that sentence what you are drawing and then make the call." : ""].filter(Boolean).join("\n"), retrieved: retrieval.block });
    const messages: Msg[] = buildMessages(hist);

    // ---- deadlines: total turn time, and "superseded by a newer turn / ended elsewhere" ------------------------------------------
    timers.push(setTimeout(() => ac.abort(new TimeoutError("total")), to.totalMs) as unknown as number);
    const poll = setInterval(async () => { try { if ((await store.turnStatus(turnId)) !== "generating") ac.abort(new DOMException("superseded", "AbortError")); } catch { /* ignore */ } }, to.pollMs);
    timers.push(poll as unknown as number);
    void store.setSessionState(session.id, "generating").catch(() => {});

    // ---- model loop with allowlisted tools -------------------------------------------------------------------------------------
    let stopReason = "end_turn";
    let retryLocked = false;      // set once this iteration has streamed text to the student: retrying would repeat it
    for (let iter = 0; iter <= LIMITS.maxToolIterations; iter++) {
      retryLocked = false; const textBefore = assistantText.length;
      const final = await withRetry(async () => {
        // each attempt has its own abort signal, so a timed-out attempt is really cancelled at the provider before we retry
        const attemptAc = new AbortController();
        const relay = () => attemptAc.abort(ac.signal.reason);
        if (ac.signal.aborted) relay(); else ac.signal.addEventListener("abort", relay, { once: true });
        const useForce = forceDraw; forceDraw = false;
        const allTools = iter < LIMITS.maxToolIterations && !noTools ? toolDefinitionsForModel({ review: reviewOn, figures: hasFigures(session.courseId) }) : [];
        const it = deps.provider.stream({ apiKey, model: chosenModel, system, messages, tools: useForce ? allTools.filter((t) => t.name === "show_graph" || t.name === "show_consumer_choice") : allTools, ...(useForce ? { toolChoice: "any" as const } : {}), maxTokens: LIMITS.maxReplyTokens, signal: attemptAc.signal, baseURL: providerBase ?? undefined, provider: stored.provider })[Symbol.asyncIterator]();
        let first = true;
        const pull = async () => {
          let timer: number | undefined;
          const wait = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new TimeoutError(first ? "first" : "idle")), first ? to.firstEventMs : to.idleMs) as unknown as number; });
          try { return await Promise.race([it.next(), wait]); } finally { clearTimeout(timer); }
        };
        try {
          for (;;) {
            const r = await pull();
            if (r.done) throw new ProviderError("unknown", null, null, "stream ended without a final message");
            const ev = r.value;
            if (first) { first = false; }
            if (ev.type === "text") {
              if (ttft === null) ttft = Date.now() - t0;
              assistantText += ev.text; emit({ event: "delta", data: { text: ev.text } });
              retryLocked = true;                                   // output has left the building: no more retries for this turn
            } else if (ev.type === "usage") { /* cumulative for this call; folded in at the end event */ }
            else if (ev.type === "end") { it.return?.()?.catch?.(() => {}); return ev; }      // always finalise the provider's iterator so its resources are released
          }
        } catch (e) { attemptAc.abort(); it.return?.()?.catch?.(() => {}); throw e; }
        finally { ac.signal.removeEventListener("abort", relay); }
      }, (e) => {
        if (retryLocked || ac.signal.aborted) return { retry: false };
        if (e instanceof TimeoutError) return { retry: e.phase === "first" };
        if (e instanceof ProviderError && e.retryable) return { retry: true, afterMs: e.retryAfterMs ?? undefined };
        return { retry: false };
      }, { signal: ac.signal, rand: deps.rand, sleep, deadline: t0 + to.totalMs, onRetry: (a, ms) => log("warn", "provider_retry", { attempt: a, latency_ms: ms }) });

      usage = addUsage(usage, final.usage);
      if (!otherProvider && isLongPrompt(chosenModel, final.usage)) longUsage = addUsage(longUsage, final.usage);
      stopReason = final.stopReason;
      // The sentence she said before drawing must be released to the voice NOW, not held until the next text arrives after the tool has run.
      if (assistantText.length > textBefore && (final.stopReason === "tool_use" || final.stopReason === "max_tokens")) { assistantText += "\n\n"; emit({ event: "delta", data: { text: "\n\n" } }); }
      const calls = final.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      // A reply cut off by the token limit loses any half-written tool call. Ask once for a smaller one instead of silently dropping the graph.
      if (final.stopReason === "max_tokens" && !visualShown && !truncatedOnce && iter < LIMITS.maxToolIterations) {
        truncatedOnce = true;
        log("warn", "reply_truncated", { turn_id: turnId });
        const said = final.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("").trim();
        if (said) messages.push({ role: "assistant", content: said });
        messages.push({ role: "user", content: "(automatic note) Your last reply was cut off before it finished, so nothing was drawn. If you were drawing a graph, call show_graph again now as small as possible: give each curve as a short formula (expr, or x_expr and y_expr, with from and to) or at most 6 points, at most 2 curves, no notes, then say one short sentence about it. Do not repeat what you already said." });
        continue;
      }
      // Cut off a second time while still trying to draw: stop offering tools and make sure the student gets a spoken answer.
      if (final.stopReason === "max_tokens" && !visualShown && truncatedOnce && !noTools && !assistantText.trim() && iter < LIMITS.maxToolIterations) {
        noTools = true;
        log("warn", "reply_truncated_twice", { turn_id: turnId });
        messages.push({ role: "user", content: "(automatic note) The drawing could not be completed. Do not draw anything now. Answer the student's question in words only, in at most 8 short spoken sentences, and say you can try the picture again if they ask." });
        continue;
      }
      // She was asked for a picture on a course that draws with tools, answered in words only: ask once more, this time requiring the drawing tool.
      if (cue === "explicit" && calls.length === 0 && !visualShown && !forcedOnce && !noTools && final.stopReason === "end_turn" && iter < LIMITS.maxToolIterations) {
        forcedOnce = true; forceDraw = true;
        log("warn", "draw_forced", { turn_id: turnId });
        const said = final.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("").trim();
        if (said) { messages.push({ role: "assistant", content: said }); }
        messages.push({ role: "user", content: "(automatic note) The student asked for a picture and nothing was drawn. Call the drawing tool now (show_consumer_choice for budget lines and indifference curves, otherwise show_graph), then explain it in at most 4 short sentences without repeating what you already said." });
        if (said) { assistantText += "\n\n"; emit({ event: "delta", data: { text: "\n\n" } }); }
        continue;
      }
      if (final.stopReason !== "tool_use" || calls.length === 0) break;

      messages.push({ role: "assistant", content: final.content });
      const results: ContentBlock[] = [];
      for (const call of calls.slice(0, LIMITS.maxToolsPerIteration)) {
        emit({ event: "tool", data: { name: call.name, status: "running" } });
        const out = await runTool(call.name, call.input, { store, content: deps.content, userId: caller.userId, courseId: session.courseId, sessionId: session.id, turnId, chapter: req.context?.chapter ?? null, settings: access.settings, solutionGranted: dir.solutionGranted, emitVisual: (v) => { if (v.kind === "figure") { if (v.num === shownFig) return; shownFig = v.num; } visualShown = true; emit({ event: "visual", data: v }); } }, call.id);
        log(out.ok ? "info" : "warn", out.ok ? "tool_ok" : "tool_rejected", { tool: call.name.slice(0, 40), reason: out.ok ? undefined : out.reason, turn_id: turnId });
        emit({ event: "tool", data: { name: call.name, status: out.ok ? "done" : "rejected" } });
        results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, is_error: !out.ok });
      }
      for (const extra of calls.slice(LIMITS.maxToolsPerIteration)) results.push({ type: "tool_result", tool_use_id: extra.id, content: JSON.stringify({ error: "Too many tool calls in one step." }), is_error: true });
      messages.push({ role: "user", content: results });
      if (iter === LIMITS.maxToolIterations) stopReason = "tool_limit";
    }

    ownerBreaker?.success(); globalBreaker?.success();
    // approved learning events, decided by the server from the retrieval and the chosen mode (never from the chat text, never by the model)
    if (access.settings.learningRecordDays > 0 && !access.isStaff) {
      try {
        const topic = retrieval.sourceKeys[0] ?? (req.context?.chapter ? `ch${Math.trunc(req.context.chapter)}` : null);
        if (retrieval.sourceKeys[0]) await store.recordEvent(caller.userId, session.courseId, session.id, `${turnId}:topic`, { event: "topic_discussed", topic: retrieval.sourceKeys[0].toLowerCase() });
        if (dir.helpDetail) await store.recordEvent(caller.userId, session.courseId, session.id, `${turnId}:help`, { event: "help_requested", topic: (topic ?? "general").toLowerCase(), detail: dir.helpDetail });
      } catch { log("warn", "learning_event_failed", { turn_id: turnId }); }
    }
    const closed = await store.finishTurn({ turnId, status: "completed", assistantText, endState: "speaking", usage: usageRecord(turnId, session, caller.userId, chosenModel, usage, Date.now() - t0, ttft, priceOverride, longUsage) });
    log("info", "turn_done", { turn_id: turnId, session_id: session.id, course_id: session.courseId, input_tokens: usage.input, output_tokens: usage.output, cache_read_tokens: usage.cacheRead, cost_micro_usd: costMicroUsd(chosenModel, usage, priceOverride, longUsage), latency_ms: Date.now() - t0, ttft_ms: ttft ?? undefined, pre_ms: preMs, stop_reason: stopReason });
    if (closed) emit({ event: "done", data: { turn_id: turnId, stop_reason: stopReason, usage: { input_tokens: usage.input, output_tokens: usage.output } } });
  } catch (e) {
    const interrupted = ac.signal.aborted && !(ac.signal.reason instanceof TimeoutError);
    const body = interrupted ? errBody("interrupted", "Interrupted.", false) : mapProviderError(ac.signal.reason instanceof TimeoutError ? ac.signal.reason : e);
    if (!interrupted) {      // feed the breakers: provider-side failures only (a bad key or the student's own cancel must not trip them)
      const cause = ac.signal.reason instanceof TimeoutError ? ac.signal.reason : e;
      if (cause instanceof ProviderError && cause.kind === "rate_limit") ownerBreaker?.failure();
      else if ((cause instanceof ProviderError && ["overloaded", "server", "network"].includes(cause.kind)) || (cause instanceof TimeoutError && cause.phase !== "total")) { ownerBreaker?.failure(); globalBreaker?.failure(); }
    }
    if (!interrupted) log("warn", "turn_failed", { turn_id: turnId || undefined, code: body.error, session_id: session.id, course_id: session.courseId, latency_ms: Date.now() - t0 });
    if (turnId) {
      try {
        await store.finishTurn({ turnId, status: interrupted ? "interrupted" : "failed", assistantText, errorCode: interrupted ? undefined : body.error, endState: interrupted ? "interrupted" : "listening", usage: usageRecord(turnId, session, caller.userId, chosenModel, usage, Date.now() - t0, ttft, priceOverride, longUsage) });
      } catch (pe) { log("error", "persist_failed", { turn_id: turnId, code: "finish_turn" }); void pe; }
    }
    if (!interrupted) fail(body);
  } finally {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    clientSignal.removeEventListener("abort", onClientAbort);
    deps.gate.release();
  }
}
function usageRecord(turnId: string, s: { id: string; courseId: string }, userId: string, model: string, u: Usage, latencyMs: number, ttftMs: number | null, other?: { priceIn: number | null; priceOut: number | null }, longUsage?: Usage) {
  return { turnId, courseId: s.courseId, userId, sessionId: s.id, model, inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite, costMicroUsd: costMicroUsd(model, u, other, longUsage), latencyMs, ttftMs };
}
