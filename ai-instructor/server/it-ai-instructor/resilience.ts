// resilience.ts - protection against overload and outages: circuit breakers, bounded admission, and the operator control switch.
// Everything here is bounded in memory and time, and fails toward "refuse politely" rather than "queue forever".

// ---- circuit breaker ----------------------------------------------------------------------------------------------------------
// closed: calls flow. open: calls are refused instantly for openMs. half-open: a few probe calls are let through; a success closes it.
export type BreakerState = "closed" | "open" | "half_open";
export interface BreakerOptions { failureThreshold: number; windowMs: number; openMs: number; halfOpenProbes: number; now?: () => number }
export const DEFAULT_BREAKER: BreakerOptions = { failureThreshold: 5, windowMs: 30_000, openMs: 15_000, halfOpenProbes: 2 };

export class CircuitBreaker {
  private failures: number[] = []; private openedAt = 0; private probes = 0; private _state: BreakerState = "closed";
  constructor(readonly name: string, private o: BreakerOptions = DEFAULT_BREAKER) {}
  private now() { return (this.o.now ?? Date.now)(); }
  get state(): BreakerState { this.refresh(); return this._state; }
  private refresh() { if (this._state === "open" && this.now() - this.openedAt >= this.o.openMs) { this._state = "half_open"; this.probes = 0; } }
  /** Ask permission to call. A half-open breaker admits only a few probes at a time. */
  check(): { allowed: true } | { allowed: false; retryAfterS: number } {
    this.refresh();
    if (this._state === "closed") return { allowed: true };
    if (this._state === "half_open") { if (this.probes < this.o.halfOpenProbes) { this.probes++; return { allowed: true }; } return { allowed: false, retryAfterS: 2 }; }
    return { allowed: false, retryAfterS: Math.max(1, Math.ceil((this.o.openMs - (this.now() - this.openedAt)) / 1000)) };
  }
  success() { this.refresh(); if (this._state === "half_open") { this._state = "closed"; } this.failures = []; }
  failure() {
    this.refresh(); const t = this.now();
    if (this._state === "half_open") { this._state = "open"; this.openedAt = t; return; }
    this.failures = this.failures.filter((f) => t - f < this.o.windowMs); this.failures.push(t);
    if (this.failures.length >= this.o.failureThreshold) { this._state = "open"; this.openedAt = t; this.failures = []; }
  }
}

/** Breakers keyed by name (e.g. one per instructor key). Bounded so an attacker cannot grow it without limit. */
export class BreakerSet {
  private m = new Map<string, CircuitBreaker>();
  constructor(private o: BreakerOptions = DEFAULT_BREAKER, private maxKeys = 2000) {}
  get(name: string): CircuitBreaker {
    let b = this.m.get(name);
    if (!b) { if (this.m.size >= this.maxKeys) { const oldest = this.m.keys().next().value as string; this.m.delete(oldest); } b = new CircuitBreaker(name, this.o); this.m.set(name, b); }
    return b;
  }
  snapshot(): Record<string, BreakerState> { const o: Record<string, BreakerState> = {}; for (const [k, b] of this.m) if (b.state !== "closed") o[k] = b.state; return o; }
}

// ---- admission: bounded concurrency + bounded waiting room ----------------------------------------------------------------------
// At most `max` run; at most `maxQueue` wait, each for at most `waitMs`. Anything beyond is refused immediately.
export type Admit = "ok" | "queue_full" | "timeout";
export class Admission {
  private n = 0; private q: { go: () => void }[] = [];
  constructor(private max: number, private maxQueue = 0) {}
  get inUse() { return this.n; } get waiting() { return this.q.length; }
  tryAcquire(): boolean { if (this.n >= this.max) return false; this.n++; return true; }
  async acquire(waitMs: number): Promise<Admit> {
    if (this.tryAcquire()) return "ok";
    if (waitMs <= 0 || this.q.length >= this.maxQueue) return "queue_full";
    return await new Promise<Admit>((resolve) => {
      const w = { go: () => { clearTimeout(timer); resolve("ok"); } };
      const timer = setTimeout(() => { const i = this.q.indexOf(w); if (i >= 0) this.q.splice(i, 1); resolve("timeout"); }, waitMs);
      this.q.push(w);
    });
  }
  release() { const next = this.q.shift(); if (next) next.go(); else this.n = Math.max(0, this.n - 1); }   // hand the slot straight to the next waiter
}

// ---- operator control (emergency shutdown / degradation) ------------------------------------------------------------------------
//  normal    everything on
//  text_only the client must not start voice/avatar; text tutoring only (cuts browser load; the server still serves turns)
//  paused    no new sessions or turns anywhere ("emergency stop"); existing sessions get a clear message
export type Mode = "normal" | "text_only" | "paused";
export interface Control { mode: Mode; maxActiveSessions: number | null; message: string | null; courseMaxGenerating?: number | null }
export const DEFAULT_CONTROL: Control = { mode: "normal", maxActiveSessions: null, message: null, courseMaxGenerating: null };
const RANK: Record<Mode, number> = { normal: 0, text_only: 1, paused: 2 };
export const isMode = (m: unknown): m is Mode => m === "normal" || m === "text_only" || m === "paused";

/** Caches the control row so it costs at most one DB read per ttl per instance. If the DB is unreachable it keeps the last known
 *  value; with no value yet it uses the environment value. The environment can only make things MORE restrictive, never less. */
export class ControlCache {
  private v: Control | null = null; private at = 0;
  constructor(private load: (() => Promise<Control | null>) | undefined, private envMode: Mode = "normal", private ttlMs = 5000, private now: () => number = Date.now) {}
  async get(): Promise<Control> {
    if (this.load && (this.v === null || this.now() - this.at >= this.ttlMs)) {
      try { const c = await this.load(); if (c) this.v = c; this.at = this.now(); } catch { this.at = this.now(); /* keep last known */ }
    }
    const base = this.v ?? DEFAULT_CONTROL;
    return RANK[this.envMode] > RANK[base.mode] ? { ...base, mode: this.envMode } : base;
  }
  invalidate() { this.at = 0; }
}

// ---- short-lived authorisation cache -------------------------------------------------------------------------------------------------
// Cuts two of the ~7 database reads per turn. The trade-off is explicit: a change in enrolment, course switch or instructor key can take up to
// `ttlMs` to reach a running conversation (default 15 s). Denials are cached for much less so a newly enrolled student is not locked out.
// Bounded size, per instance, never shared. Set ttl to 0 to disable. Rate limits and budgets are NOT cached: they stay in the atomic SQL.
export class TtlCache<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private ttlMs: number, private maxEntries = 5000, private now: () => number = Date.now) {}
  get(k: string): V | undefined { const e = this.m.get(k); if (!e) return undefined; if (e.exp <= this.now()) { this.m.delete(k); return undefined; } return e.v; }
  set(k: string, v: V, ttlMs = this.ttlMs) { if (this.ttlMs <= 0) return; if (this.m.size >= this.maxEntries) this.m.delete(this.m.keys().next().value as string); this.m.set(k, { v, exp: this.now() + ttlMs }); }
  delete(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  get size() { return this.m.size; }
}
