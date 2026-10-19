// config.ts - every limit and default in one place. Values are conservative starting points for the
// International Trade pilot; none are measured capacity claims (see Prompt 7 for load testing).

export const MODELS = {
  // API ids as published for the current generation. The instructor picks one; anything else is refused.
  allowed: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"] as const,
  default: "claude-haiku-5-5",
};

// USD per million tokens, from Anthropic's published pricing page (read 2026-10-16). Update when it changes.
// Haiku 5.5 has a long-prompt surcharge above 100k input tokens; our prompts are capped far below that.
export const PRICES_USD_PER_MTOK: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-haiku-5-5": { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.10 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.20 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
};

// Providers an instructor may choose with their own key (opt-in per instructor; Claude stays the default).
// "anthropic" uses the official SDK. Every other id speaks the OpenAI-compatible chat-completions streaming protocol.
// Base URLs are FIXED presets: an instructor can never type a URL, so a key cannot be used to make this function call an arbitrary host.
// "custom" is available only for hosts the platform operator lists in the AI_INSTRUCTOR_EXTRA_HOSTS secret (comma separated, https, port 443).
export const PROVIDERS = {
  anthropic: { label: "Claude (Anthropic)", baseURL: null as string | null, keyPrefix: "sk-ant-" },
  gemini: { label: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", keyPrefix: "" },
  openai: { label: "OpenAI", baseURL: "https://api.openai.com/v1", keyPrefix: "sk-" },
  groq: { label: "Groq", baseURL: "https://api.groq.com/openai/v1", keyPrefix: "gsk_" },
  openrouter: { label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", keyPrefix: "sk-or-" },
  custom: { label: "Other OpenAI-compatible service", baseURL: null as string | null, keyPrefix: "" },
} as const;
export type ProviderId = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const isProviderId = (p: unknown): p is ProviderId => typeof p === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, p);
/** The address to call for a provider. Presets are fixed; "custom" must be https, port 443, no credentials, and on the operator's host allowlist. Returns null if not allowed. */
export function resolveBaseURL(provider: string, customUrl: string | null, extraHosts: string[]): string | null {
  if (provider === "anthropic") return null;
  if (!isProviderId(provider)) return null;
  if (provider !== "custom") return PROVIDERS[provider].baseURL;
  try {
    const u = new URL(customUrl ?? "");
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || u.search || u.hash) return null;
    if (!extraHosts.map((h) => h.trim().toLowerCase()).filter(Boolean).includes(u.hostname.toLowerCase())) return null;
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch { return null; }
}
export const MODEL_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$";
// Non-Anthropic prices are not known to this platform. Until the instructor enters their own, spending is ESTIMATED with this deliberately
// high placeholder so the monthly budget cap errs toward stopping early. (USD per million tokens.)
export const UNKNOWN_PRICE_USD_PER_MTOK = { input: 3, output: 15 };

export const LIMITS = {
  maxBodyBytes: 16 * 1024,            // whole request body
  maxTextChars: 2000,                 // one student utterance (~ 2-3 minutes of speech)
  maxContextFieldChars: 200,
  maxReplyTokens: 2200,               // spoken answers stay short, but a graph tool call alone can need ~600 tokens, so leave room for the call AND the explanation
  maxHistoryTokensEst: 6000,          // older turns are dropped beyond this (estimated, chars/3.5)
  maxToolIterations: 4,
  maxToolOutputChars: 5000,
  maxToolsPerIteration: 4,
  // per-user and per-session rate limits (sliding windows enforced in the database)
  userTurnsPerMinute: 10,
  userTurnsPerDay: 250,
  sessionTurnsPerHour: 60,
  sessionsPerUserPerDay: 30,
  // concurrency
  isolateMaxConcurrentTurns: 24,
  courseMaxConcurrentGenerating: 40,
  // default budgets (instructor can change per course)
  defaultStudentDailyTokens: 60_000,
  defaultCourseMonthlyUsd: 25,
  // timeouts
  firstEventTimeoutMs: 20_000,
  idleTimeoutMs: 20_000,
  totalTurnTimeoutMs: 75_000,
  generatingStaleAfterMs: 120_000,   // a "generating" turn older than this is considered dead
  activeSessionWindowS: 180,          // a session counts as "active" if it had activity in the last 3 minutes
  alertAtBudgetFraction: 0.8,
  logInfoSampleRate: 0.02,           // fraction of info-level log lines kept (errors/warnings are never sampled, only rate limited)
  logPerSecondPerInstance: 2,        // hard ceiling per function instance; the platform documents 100 events / 10 s
  accessCacheTtlMs: 15_000,          // enrolment/key lookups are reused for this long per instance (0 = off). Changes take up to this long to apply.
  admissionQueueMax: 50,             // turns allowed to wait for a slot on one instance; beyond this they are refused at once
  admissionWaitMs: 2000,             // longest a turn waits in that queue
  sessionIdleTtlMs: 2 * 60 * 60 * 1000,
  // course-aware retrieval (Prompt 6): how much course text may reach the model on one turn
  retrievalMaxPassages: 4,
  retrievalMaxCharsEach: 1100,
  retrievalMaxCharsTotal: 4200,       // about 1,200 tokens: small enough that retrieval does not dominate the prompt or the bill
  retrievalTimeoutMs: 1500,           // past this the turn continues without course text (coverage "none") rather than making the student wait
  assessmentCacheTtlMs: 15_000,       // "is the student in a quiz or exam?" is re-checked at most this often per student and course
  maxPracticePerSession: 20,
};

export const RETRY = { maxAttempts: 3, baseMs: 400, capMs: 4000 };   // 1 try + 2 retries, full jitter

export const RETENTION = {
  // 0 = delete the conversation when the session ends or goes idle; N = keep N days for the instructor to review.
  defaultDays: 0,
  maxDays: 365,
};
