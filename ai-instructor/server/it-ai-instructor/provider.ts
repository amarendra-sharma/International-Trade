// provider.ts - the only module that talks to Anthropic. Uses the official SDK, with its own retries turned off
// (retry policy lives in retry.ts so we control exactly when a retry is safe).
import Anthropic from "npm:@anthropic-ai/sdk@0.135.0";

export interface SystemBlock { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export interface Msg { role: "user" | "assistant"; content: string | ContentBlock[] }
export interface LlmRequest {
  apiKey: string; model: string; system: SystemBlock[]; messages: Msg[]; tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  maxTokens: number; signal: AbortSignal; baseURL?: string;
  provider?: string;      // "anthropic" (default) or any other id: the request is then sent as OpenAI-compatible chat completions to baseURL
}
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export type LlmEvent =
  | { type: "text"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "end"; stopReason: string; content: ContentBlock[]; usage: Usage };
export interface LlmProvider { stream(req: LlmRequest): AsyncIterable<LlmEvent> }

export type ProviderErrorKind = "auth" | "rate_limit" | "overloaded" | "server" | "network" | "bad_request" | "aborted" | "unknown";
export class ProviderError extends Error {
  public detail?: string;   // provider's own short reason (e.g. "credit balance is too low"); only shown for the key check, never for student turns
  constructor(public kind: ProviderErrorKind, public status: number | null, public retryAfterMs: number | null, message: string) { super(message); this.name = "ProviderError"; }
  get retryable() { return this.kind === "rate_limit" || this.kind === "overloaded" || this.kind === "server" || this.kind === "network"; }
}

export function classifyAnthropicError(err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) return new ProviderError("aborted", null, null, "aborted");
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError("network", null, null, "provider unreachable");
  const e = err as { name?: string; status?: number; headers?: Record<string, string> | Headers; message?: string };
  if (e?.name === "AbortError" || e?.name === "APIUserAbortError") return new ProviderError("aborted", null, null, "aborted");
  const status = typeof e?.status === "number" ? e.status : null;
  let retryAfter: number | null = null;
  const h = e?.headers;
  const ra = h ? (typeof (h as Headers).get === "function" ? (h as Headers).get("retry-after") : (h as Record<string, string>)["retry-after"]) : null;
  if (ra && !Number.isNaN(Number(ra))) retryAfter = Math.min(30_000, Number(ra) * 1000);
  // Messages are generic on purpose: provider error bodies can echo request content.
  if (status === 401 || status === 403) return new ProviderError("auth", status, null, "provider rejected the key");
  if (status === 429) return new ProviderError("rate_limit", status, retryAfter, "provider rate limited");
  if (status === 529) return new ProviderError("overloaded", status, retryAfter, "provider overloaded");
  if (status !== null && status >= 500) return new ProviderError("server", status, retryAfter, "provider server error");
  if (status !== null && status >= 400) {
    const pe = new ProviderError("bad_request", status, null, "provider rejected the request");
    const body = (err as { error?: { error?: { message?: unknown; type?: unknown }; message?: unknown; type?: unknown } }).error;
    const m = body?.error?.message ?? body?.message, t = body?.error?.type ?? body?.type;
    if (typeof m === "string") pe.detail = ((typeof t === "string" ? t + ": " : "") + m).slice(0, 220);
    return pe;
  }
  if (e?.name === "APIConnectionError" || e?.name === "APIConnectionTimeoutError" || status === null) return new ProviderError("network", null, null, "provider unreachable");
  return new ProviderError("unknown", status, null, "provider error");
}

export const anthropicProvider: LlmProvider = {
  async *stream(req: LlmRequest) {
    const client = new Anthropic({ apiKey: req.apiKey, maxRetries: 0, baseURL: req.baseURL });
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      const stream = client.messages.stream({
        model: req.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages as never, ...(req.tools.length ? { tools: req.tools as never } : {}),
      }, { signal: req.signal });
      let stopReason = "end_turn";
      for await (const ev of stream) {
        if (ev.type === "message_start") {
          const u = ev.message.usage as unknown as Record<string, number>;
          usage.input = u.input_tokens ?? 0; usage.cacheRead = u.cache_read_input_tokens ?? 0; usage.cacheWrite = u.cache_creation_input_tokens ?? 0; usage.output = u.output_tokens ?? 0;
          yield { type: "usage", usage: { ...usage } };
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          yield { type: "text", text: ev.delta.text };
        } else if (ev.type === "message_delta") {
          usage.output = (ev.usage as unknown as Record<string, number>).output_tokens ?? usage.output;
          stopReason = ev.delta.stop_reason ?? stopReason;
          yield { type: "usage", usage: { ...usage } };
        }
      }
      const final = await stream.finalMessage();
      const content: ContentBlock[] = final.content.flatMap((b): ContentBlock[] =>
        b.type === "text" ? [{ type: "text", text: b.text }] : b.type === "tool_use" ? [{ type: "tool_use", id: b.id, name: b.name, input: b.input }] : []);
      yield { type: "end", stopReason: final.stop_reason ?? stopReason, content, usage: { ...usage } };
    } catch (err) {
      throw classifyAnthropicError(err, req.signal);
    }
  },
};

// ---- OpenAI-compatible chat completions (Gemini, OpenAI, Groq, OpenRouter, ...) ------------------------------------------------------
// Same LlmProvider contract as above, so retries, timeouts, tools, breakers and metering in converse.ts are unchanged. Differences handled here:
// system blocks are joined into one system message (no prompt-cache markers), tool_use/tool_result blocks become tool_calls/tool messages,
// and the SSE stream is parsed by hand. Error messages stay generic because provider error bodies can echo request content.
type OaiMsg = { role: "system" | "user" | "assistant" | "tool"; content?: string | null; tool_call_id?: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] };
export function toOpenAiMessages(system: SystemBlock[], messages: Msg[]): OaiMsg[] {
  const out: OaiMsg[] = [{ role: "system", content: system.map((b) => b.text).join("\n\n") }];
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const text = m.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
      const calls = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use").map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${b.content}` : b.content });
        else if (b.type === "text") out.push({ role: "user", content: b.text });
      }
    }
  }
  return out;
}
const STOP: Record<string, string> = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };

export const openaiCompatProvider: LlmProvider = {
  async *stream(req: LlmRequest) {
    if (!req.baseURL) throw new ProviderError("bad_request", null, null, "no provider address");
    const body = {
      model: req.model, stream: true, stream_options: { include_usage: true }, messages: toOpenAiMessages(req.system, req.messages),
      ...(req.provider === "openai" ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
    };
    let res: Response;
    try {
      res = await fetch(req.baseURL.replace(/\/+$/, "") + "/chat/completions", { method: "POST", redirect: "error", signal: req.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.apiKey}` }, body: JSON.stringify(body) });
    } catch (err) { throw classifyAnthropicError(err, req.signal); }
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } throw classifyAnthropicError({ status: res.status, headers: res.headers }, req.signal); }
    if (!res.body) throw new ProviderError("network", null, null, "provider returned no body");

    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let text = "", stop = "end_turn", sawUsage = false;
    try {
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "", done = false;
      while (!done) {
        const r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") { done = true; break; }
          let j: Record<string, any>; try { j = JSON.parse(payload); } catch { continue; }
          if (j.error) throw new ProviderError("server", null, null, "provider error");
          if (j.usage) {
            sawUsage = true;
            const cached = Number(j.usage.prompt_tokens_details?.cached_tokens ?? 0);
            usage.input = Math.max(0, Number(j.usage.prompt_tokens ?? 0) - cached); usage.cacheRead = cached; usage.output = Number(j.usage.completion_tokens ?? 0);
            yield { type: "usage", usage: { ...usage } };
          }
          const ch = j.choices?.[0]; if (!ch) continue;
          const d = ch.delta ?? {};
          if (typeof d.content === "string" && d.content) { text += d.content; yield { type: "text", text: d.content }; }
          for (const tc of d.tool_calls ?? []) {
            const i = Number(tc.index ?? 0), cur = calls.get(i) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id; if (tc.function?.name) cur.name += tc.function.name; if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
            calls.set(i, cur);
          }
          if (ch.finish_reason) stop = STOP[ch.finish_reason] ?? "end_turn";
        }
      }
      try { await reader.cancel(); } catch { /* ignore */ }
    } catch (err) { throw classifyAnthropicError(err, req.signal); }

    if (!sawUsage) { usage.input = Math.ceil(JSON.stringify(body.messages).length / 3.5); usage.output = Math.ceil((text.length + [...calls.values()].reduce((a, c) => a + c.args.length, 0)) / 3.5); }   // provider sent no usage: estimate, never zero
    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text });
    [...calls.entries()].sort((a, b) => a[0] - b[0]).forEach(([i, c]) => {
      if (!c.name) return;
      let input: unknown = {}; try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = {}; }
      content.push({ type: "tool_use", id: c.id || `call_${i}`, name: c.name, input });
    });
    if (content.some((b) => b.type === "tool_use")) stop = "tool_use";
    yield { type: "end", stopReason: stop, content, usage: { ...usage } };
  },
};

/** Chooses the adapter per request: Anthropic's SDK by default, the OpenAI-compatible adapter for every other provider id. */
export const routedProvider: LlmProvider = {
  stream(req: LlmRequest) { return !req.provider || req.provider === "anthropic" ? anthropicProvider.stream(req) : openaiCompatProvider.stream(req); },
};
