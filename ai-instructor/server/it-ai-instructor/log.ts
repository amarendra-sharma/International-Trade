// log.ts - structured JSON logs that cannot carry secrets or student text.
// Only an allowlist of field names is ever emitted; string values are scrubbed for key-like tokens; user ids are hashed.
const ALLOWED = new Set([
  "event", "level", "ts", "course_id", "session_id", "turn_id", "user", "action", "state", "from", "to", "status", "code", "model",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_micro_usd", "latency_ms", "ttft_ms", "attempt",
  "tool", "retryable", "http_status", "stop_reason", "reason", "bytes", "chars", "limit", "window", "count", "iteration",
]);
const KEYLIKE = /(sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{10,})/g;

export function scrub(v: unknown): unknown {
  if (typeof v === "string") return v.replace(KEYLIKE, "[redacted]").slice(0, 200);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  return undefined;
}

export async function hashUser(userId: string, salt: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ":" + userId));
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Sink = (line: string) => void;
export function makeLogger(sink: Sink = (l) => console.log(l)) {
  return (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) => {
    const out: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
    for (const [k, v] of Object.entries(fields)) { if (!ALLOWED.has(k)) continue; const s = scrub(v); if (s !== undefined) out[k] = s; }
    sink(JSON.stringify(out));
  };
}
export type Logger = ReturnType<typeof makeLogger>;

// ---- volume control --------------------------------------------------------------------------------------------------------------
// Supabase documents a log-event threshold of 100 events per 10 seconds. At hundreds of turns per second, two log lines per turn would be
// dropped unpredictably by the platform (including the errors we most want). So the logger limits itself: info events are sampled, every
// level goes through a token bucket, and a periodic "log_dropped" line says how many were skipped. Authoritative per-turn metering lives
// in the it_ai_usage table, not in logs.
export interface SampleOptions { infoSampleRate: number; perSecond: number; burst: number; now?: () => number; rand?: () => number; summaryEveryMs?: number }
export function makeSampledLogger(sink: Sink, o: SampleOptions): Logger {
  const base = makeLogger(sink), now = o.now ?? Date.now, rand = o.rand ?? Math.random, every = o.summaryEveryMs ?? 10_000;
  let tokens = o.burst, last = now(), dropped = 0, lastSummary = now();
  return (level, event, fields = {}) => {
    const t = now(); tokens = Math.min(o.burst, tokens + ((t - last) / 1000) * o.perSecond); last = t;
    const sampledOut = level === "info" && rand() >= o.infoSampleRate;
    if (sampledOut || tokens < 1) { dropped++; }
    else { tokens -= 1; base(level, event, fields); }
    if (dropped > 0 && t - lastSummary >= every && tokens >= 1) { tokens -= 1; base("warn", "log_dropped", { count: dropped, window: Math.round((t - lastSummary) / 1000) }); dropped = 0; lastSummary = t; }
  };
}
