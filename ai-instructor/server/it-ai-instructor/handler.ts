// handler.ts - HTTP layer: CORS, auth, body-size cap, schema validation, routing. Separate from index.ts so it can be tested
// with injected dependencies and no network.
import { LIMITS } from "./config.ts";
import { REQUEST_SCHEMAS, type TurnRequest } from "./schemas.ts";
import { validate, ValidationError } from "./validate.ts";
import { errBody, handleTurn, type Deps } from "./converse.ts";
import * as A from "./actions.ts";
import { sseResponse } from "./sse.ts";

export interface HttpOptions { allowedOrigins: string[]; authenticate: (req: Request) => Promise<string | null> }

export function makeHandler(deps: Deps, opts: HttpOptions) {
  const corsFor = (req: Request): Record<string, string> => {
    const origin = req.headers.get("Origin") ?? "";
    const allow = opts.allowedOrigins.includes("*") ? "*" : opts.allowedOrigins.includes(origin) ? origin : opts.allowedOrigins[0];
    return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
  };
  const json = (cors: Record<string, string>, status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

  async function readBodyLimited(req: Request, max: number): Promise<string | null> {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > max) return null;
    const reader = req.body?.getReader(); if (!reader) return "";
    const chunks: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > max) { await reader.cancel(); return null; } chunks.push(value); }
    const all = new Uint8Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    return new TextDecoder().decode(all);
  }

  return async function handle(req: Request): Promise<Response> {
    const cors = corsFor(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method === "GET" && new URL(req.url).pathname.endsWith("/health")) return json(cors, 200, { ok: true });   // liveness/readiness only: no auth, no data, no dependency calls
    if (req.method !== "POST") return json(cors, 405, errBody("bad_request", "POST only.", false));
    try {
      const uid = await opts.authenticate(req);
      if (!uid) return json(cors, 401, errBody("unauthenticated", "Please sign in.", false));
      const raw = await readBodyLimited(req, LIMITS.maxBodyBytes);
      if (raw === null) return json(cors, 413, errBody("too_large", "Request too large.", false));
      let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return json(cors, 400, errBody("bad_request", "Invalid JSON.", false)); }
      const action = (parsed as { action?: string })?.action ?? "";
      const schema = Object.prototype.hasOwnProperty.call(REQUEST_SCHEMAS, action) ? REQUEST_SCHEMAS[action] : undefined;
      if (!schema) return json(cors, 400, errBody("bad_request", "Unknown action.", false));
      // deno-lint-ignore no-explicit-any
      let body: Record<string, any>;
      try { body = validate(schema, parsed) as typeof body; } catch (e) { return json(cors, 400, errBody("bad_request", e instanceof ValidationError ? e.message : "Invalid request.", false)); }
      const caller = { userId: uid };

      if (action === "turn") return sseResponse(cors, (emit, signal) => handleTurn(deps, caller, body as unknown as TurnRequest, signal, emit));
      let r: A.Result;
      switch (action) {
        case "start_session": r = await A.startSession(deps, caller, body.course_id); break;
        case "interrupt": r = await A.interrupt(deps, caller, body.session_id, body.client_turn_id, body.spoken_chars ?? null); break;
        case "client_state": r = await A.clientState(deps, caller, body.session_id, body.state); break;
        case "history": r = await A.history(deps, caller, body.session_id, body.after_seq ?? 0); break;
        case "end_session": r = await A.endSession(deps, caller, body.session_id); break;
        case "set_key": r = await A.setKey(deps, caller, body.api_key, body.model, body.validate, { provider: body.provider, baseUrl: body.base_url, priceIn: body.price_in, priceOut: body.price_out }); break;
        case "key_status": r = await A.keyStatus(deps, caller); break;
        case "delete_key": r = await A.deleteKey(deps, caller); break;
        case "report_usage": r = await A.reportUsage(deps, caller, body.session_id, body); break;
        case "ops_status": r = await A.opsStatus(deps, caller, body.course_id); break;
        case "set_control": r = await A.setControl(deps, caller, body); break;
        case "feedback": r = await A.feedback(deps, caller, body.session_id, body.turn_id ?? null, body.rating, body.reason ?? null); break;
        case "my_learning": r = await A.myLearning(deps, caller, body.course_id); break;
        case "delete_my_learning": r = await A.deleteMyLearning(deps, caller, body.course_id, body.confirm); break;
        case "review_status": r = await A.reviewStatus(deps, caller, body.course_id); break;
        case "review_consent": r = await A.reviewConsent(deps, caller, body.course_id, body.granted); break;
        case "request_meeting": r = await A.requestMeeting(deps, caller, body.course_id, body.with, body.topic, body.note ?? null); break;
        case "list_review_requests": r = await A.listReviewRequests(deps, caller, body.course_id); break;
        case "complete_review_request": r = await A.completeReviewRequest(deps, caller, body.course_id, body.request_id); break;
        case "get_settings": r = await A.getSettings(deps, caller, body.course_id); break;
        case "set_settings": r = await A.setSettings(deps, caller, body.course_id, body); break;
        default: r = { status: 400, body: errBody("bad_request", "Unknown action.", false) };
      }
      return json(cors, r.status, r.body);
    } catch (e) {
      deps.log("error", "unhandled", { reason: e instanceof Error ? e.name : "unknown" });
      return json(cors, 500, errBody("internal", "Something went wrong on our side.", false));
    }
  };
}
