// retry.ts - exponential backoff with full jitter. Only used where a retry cannot duplicate anything:
// a provider request that has not produced a single streamed event yet.
import { RETRY } from "./config.ts";

export interface RetryDecision { retry: boolean; afterMs?: number }
export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  if (signal?.aborted) return rej(new DOMException("aborted", "AbortError"));
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); res(); }, ms);
  const onAbort = () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

export function backoffMs(attempt: number, rand: () => number = Math.random, base = RETRY.baseMs, cap = RETRY.capMs): number {
  const ceiling = Math.min(cap, base * 2 ** (attempt - 1));   // attempt is 1-based: the delay after attempt N fails
  return Math.floor(rand() * ceiling);                          // full jitter
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  classify: (err: unknown) => RetryDecision,
  opts: { signal?: AbortSignal; maxAttempts?: number; rand?: () => number; sleep?: typeof sleep; deadline?: number; onRetry?: (attempt: number, ms: number) => void } = {},
): Promise<T> {
  const max = opts.maxAttempts ?? RETRY.maxAttempts, doSleep = opts.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try { return await fn(attempt); } catch (err) {
      if (opts.signal?.aborted) throw err;
      const d = classify(err);
      if (!d.retry || attempt >= max) throw err;
      const wait = Math.min(RETRY.capMs * 2, Math.max(d.afterMs ?? 0, backoffMs(attempt, opts.rand)));
      if (opts.deadline !== undefined && Date.now() + wait >= opts.deadline) throw err;   // no point sleeping past the turn deadline
      opts.onRetry?.(attempt, wait);
      await doSleep(wait, opts.signal);
    }
  }
}
