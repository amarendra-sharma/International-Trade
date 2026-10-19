// sse.ts - turns an emit()-style producer into a Server-Sent Events Response, and aborts the producer if the client goes away.
import type { SseEvent } from "./schemas.ts";

export function sseResponse(headers: HeadersInit, run: (emit: (e: SseEvent) => void, signal: AbortSignal) => Promise<void>): Response {
  const ac = new AbortController(), enc = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: SseEvent) => { if (closed) return; try { controller.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)); } catch { closed = true; } };
      try { await run(emit, ac.signal); } catch { emit({ event: "error", data: { error: "internal", message: "Something went wrong on our side.", retryable: false } }); }
      finally { if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } } }
    },
    cancel() { closed = true; ac.abort(new DOMException("client disconnected", "AbortError")); },     // student interrupted / closed the tab
  });
  return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
