// schemas.ts - typed request and response shapes for the conversation endpoint.
import { LIMITS, MODELS, MODEL_ID_PATTERN, PROVIDER_IDS } from "./config.ts";
import type { Schema } from "./validate.ts";
import { MODES } from "./teaching.ts";
import type { VisualSpec } from "./visuals.ts";

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const uuid: Schema = { type: "string", pattern: UUID };
const ctxField: Schema = { type: "string", maxLength: LIMITS.maxContextFieldChars };
const context: Schema = {
  type: "object", additionalProperties: false,
  properties: { chapter: { type: "integer", minimum: 0, maximum: 200 }, view: { type: "string", enum: ["reading", "quiz", "arena", "graph", "equation", "other"] }, topic: ctxField },
};

export const REQUEST_SCHEMAS: Record<string, Schema> = {
  start_session: { type: "object", additionalProperties: false, required: ["action", "course_id"], properties: { action: { type: "string", enum: ["start_session"] }, course_id: uuid, context } },
  turn: {
    type: "object", additionalProperties: false, required: ["action", "session_id", "client_turn_id", "text"],
    properties: {
      action: { type: "string", enum: ["turn"] }, session_id: uuid, client_turn_id: uuid,
      text: { type: "string", minLength: 1, maxLength: LIMITS.maxTextChars }, input_mode: { type: "string", enum: ["voice", "text"] }, context,
      mode: { type: "string", enum: MODES },
    },
  },
  interrupt: { type: "object", additionalProperties: false, required: ["action", "session_id", "client_turn_id"], properties: { action: { type: "string", enum: ["interrupt"] }, session_id: uuid, client_turn_id: uuid, spoken_chars: { type: "integer", minimum: 0, maximum: 20000 } } },
  client_state: { type: "object", additionalProperties: false, required: ["action", "session_id", "state"], properties: { action: { type: "string", enum: ["client_state"] }, session_id: uuid, state: { type: "string", enum: ["listening", "speaking"] } } },
  history: { type: "object", additionalProperties: false, required: ["action", "session_id"], properties: { action: { type: "string", enum: ["history"] }, session_id: uuid, after_seq: { type: "integer", minimum: 0, maximum: 1000000 } } },
  end_session: { type: "object", additionalProperties: false, required: ["action", "session_id"], properties: { action: { type: "string", enum: ["end_session"] }, session_id: uuid } },
  set_key: { type: "object", additionalProperties: false, required: ["action", "api_key"], properties: { action: { type: "string", enum: ["set_key"] }, api_key: { type: "string", minLength: 20, maxLength: 300 }, model: { type: "string", pattern: MODEL_ID_PATTERN }, validate: { type: "boolean" },
    // opt-in alternative providers (default "anthropic"); prices are USD per million tokens, used only to estimate spend for non-Anthropic models
    provider: { type: "string", enum: PROVIDER_IDS }, base_url: { type: "string", maxLength: 200 }, price_in: { type: "number", minimum: 0, maximum: 1000 }, price_out: { type: "number", minimum: 0, maximum: 1000 } } },
  key_status: { type: "object", additionalProperties: false, required: ["action"], properties: { action: { type: "string", enum: ["key_status"] } } },
  delete_key: { type: "object", additionalProperties: false, required: ["action"], properties: { action: { type: "string", enum: ["delete_key"] } } },
  report_usage: {
    type: "object", additionalProperties: false, required: ["action", "session_id"],
    properties: {
      action: { type: "string", enum: ["report_usage"] }, session_id: uuid,
      // browser-measured, per-session aggregates sent a few times per session (never per audio frame). All are deltas since the last report.
      asr_ms: { type: "integer", minimum: 0, maximum: 3_600_000 }, tts_ms: { type: "integer", minimum: 0, maximum: 3_600_000 },
      audio_in_ms: { type: "integer", minimum: 0, maximum: 3_600_000 }, audio_out_ms: { type: "integer", minimum: 0, maximum: 3_600_000 },
      avatar_bytes: { type: "integer", minimum: 0, maximum: 500_000_000 }, avatar_init_ms: { type: "integer", minimum: 0, maximum: 600_000 },
      ttfa_ms: { type: "integer", minimum: 0, maximum: 600_000 }, turns: { type: "integer", minimum: 0, maximum: 100 },
      interruptions: { type: "integer", minimum: 0, maximum: 1000 }, sync_errors: { type: "integer", minimum: 0, maximum: 1000 }, audio_drops: { type: "integer", minimum: 0, maximum: 1000 },
      text_only: { type: "boolean" },
    },
  },
  ops_status: { type: "object", additionalProperties: false, required: ["action"], properties: { action: { type: "string", enum: ["ops_status"] }, course_id: uuid } },
  set_control: {
    type: "object", additionalProperties: false, required: ["action"],
    properties: { action: { type: "string", enum: ["set_control"] }, mode: { type: "string", enum: ["normal", "text_only", "paused"] }, max_active_sessions: { type: "integer", minimum: 0, maximum: 100000 }, clear_max_active_sessions: { type: "boolean" }, course_max_generating: { type: "integer", minimum: 1, maximum: 5000 }, clear_course_max_generating: { type: "boolean" }, message: { type: "string", maxLength: 200 } },
  },
  get_settings: { type: "object", additionalProperties: false, required: ["action", "course_id"], properties: { action: { type: "string", enum: ["get_settings"] }, course_id: uuid } },
  set_settings: {
    type: "object", additionalProperties: false, required: ["action", "course_id"],
    properties: {
      action: { type: "string", enum: ["set_settings"] }, course_id: uuid, enabled: { type: "boolean" },
      retention_days: { type: "integer", minimum: 0, maximum: 365 }, student_daily_tokens: { type: "integer", minimum: 1000, maximum: 1_000_000 },
      course_monthly_usd: { type: "number", minimum: 0, maximum: 10000 }, model: { type: "string", enum: MODELS.allowed },
      // instructor-configured AI assistance rules and learning-record retention (migration 003)
      ai_policy: { type: "string", enum: ["full", "hints_only", "concepts_only"] }, allow_worked_solutions: { type: "boolean" }, block_during_assessments: { type: "boolean" },
      learning_record_days: { type: "integer", minimum: 0, maximum: 730 }, store_mastery: { type: "boolean" },
      // graded-work review (migration 005): off by default; the correct answers are shown to the AI only when review_show_solutions is true and ai_policy is full
      review_enabled: { type: "boolean" }, review_show_solutions: { type: "boolean" },
    },
  },
  // graded-work review (migration 005): status and consent for the student; meeting requests for the student; the request list for staff
  review_status: { type: "object", additionalProperties: false, required: ["action", "course_id"], properties: { action: { type: "string", enum: ["review_status"] }, course_id: uuid } },
  review_consent: { type: "object", additionalProperties: false, required: ["action", "course_id", "granted"], properties: { action: { type: "string", enum: ["review_consent"] }, course_id: uuid, granted: { type: "boolean" } } },
  request_meeting: {
    type: "object", additionalProperties: false, required: ["action", "course_id", "with", "topic"],
    properties: { action: { type: "string", enum: ["request_meeting"] }, course_id: uuid, with: { type: "string", enum: ["ta", "professor"] }, topic: { type: "string", minLength: 1, maxLength: 200 }, note: { type: "string", maxLength: 500 } },
  },
  list_review_requests: { type: "object", additionalProperties: false, required: ["action", "course_id"], properties: { action: { type: "string", enum: ["list_review_requests"] }, course_id: uuid } },
  complete_review_request: { type: "object", additionalProperties: false, required: ["action", "course_id", "request_id"], properties: { action: { type: "string", enum: ["complete_review_request"] }, course_id: uuid, request_id: uuid } },
  // course materials upload (instructor/owner only): batches of pre-chunked text for a source, e.g. lecture slides
  ingest_materials: {
    type: "object", additionalProperties: false, required: ["action", "course_id", "source_id", "title", "kind", "chunks"],
    properties: {
      action: { type: "string", enum: ["ingest_materials"] }, course_id: uuid, source_id: { type: "string", pattern: "^it-[a-z0-9-]{2,30}$" }, title: { type: "string", minLength: 1, maxLength: 160 },
      kind: { type: "string", enum: ["textbook", "lecture_notes", "lesson", "approved_material"] }, replace: { type: "boolean" },
      chunks: { type: "array", minItems: 1, maxItems: 25, items: { type: "object", additionalProperties: false, required: ["chunk_key", "source_key", "chapter", "section", "heading", "kind", "ord", "pos", "title", "body"], properties: {
        chunk_key: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,40}:[a-z0-9][a-z0-9._#-]{0,30}$" }, source_key: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,40}:[a-z0-9][a-z0-9._#-]{0,30}$" },
        chapter: { type: "integer", minimum: 0, maximum: 200 }, section: { type: "string", minLength: 1, maxLength: 30 }, heading: { type: "string", minLength: 1, maxLength: 200 },
        kind: { type: "string", enum: ["lesson", "example", "term", "problem", "notes", "summary", "objectives", "data", "warning", "reference"] }, ord: { type: "integer", minimum: 0, maximum: 100000 }, pos: { type: "integer", minimum: 0, maximum: 10000000 },
        title: { type: "string", minLength: 1, maxLength: 220 }, body: { type: "string", minLength: 1, maxLength: 2000 },
      } } },
    },
  },
  // the student's own learning data (migration 003)
  feedback: {
    type: "object", additionalProperties: false, required: ["action", "session_id", "rating"],
    properties: { action: { type: "string", enum: ["feedback"] }, session_id: uuid, turn_id: uuid, rating: { type: "string", enum: ["helpful", "not_helpful"] }, reason: { type: "string", enum: ["too_hard", "too_easy", "incorrect", "unclear", "off_topic", "other"] } },
  },
  my_learning: { type: "object", additionalProperties: false, required: ["action", "course_id"], properties: { action: { type: "string", enum: ["my_learning"] }, course_id: uuid } },
  delete_my_learning: { type: "object", additionalProperties: false, required: ["action", "course_id", "confirm"], properties: { action: { type: "string", enum: ["delete_my_learning"] }, course_id: uuid, confirm: { type: "boolean" } } },
};

export type SessionState = "listening" | "processing" | "generating" | "speaking" | "interrupted" | "ended";

export interface TurnRequest { action: "turn"; session_id: string; client_turn_id: string; text: string; input_mode?: "voice" | "text"; mode?: (typeof MODES)[number]; context?: { chapter?: number; view?: string; topic?: string } }
export interface StartSessionRequest { action: "start_session"; course_id: string; context?: TurnRequest["context"] }

export type ErrorCode =
  | "unauthenticated" | "forbidden" | "not_enrolled" | "course_disabled" | "no_instructor_key" | "bad_request" | "too_large"
  | "rate_limited" | "budget_exhausted" | "busy" | "duplicate" | "in_progress" | "session_ended" | "session_not_found"
  | "provider_key_invalid" | "review_off" | "assessment_in_progress" | "paused" | "capacity" | "provider_unavailable" | "provider_busy" | "timeout" | "interrupted" | "internal";

export interface ErrorBody { error: ErrorCode; message: string; retryable: boolean; retry_after_s?: number }

// Server-sent events for action "turn":
//  accepted {turn_id, seq}   delta {text}   tool {name, status}   done {turn_id, stop_reason, usage}   error ErrorBody
export type SseEvent =
  | { event: "accepted"; data: { turn_id: string } }
  | { event: "delta"; data: { text: string } }
  | { event: "tool"; data: { name: string; status: "running" | "done" | "rejected" } }
  | { event: "visual"; data: VisualSpec }                    // an equation or graph for the student's screen; spec contains numbers and short labels only
  | { event: "done"; data: { turn_id: string; stop_reason: string; usage: { input_tokens: number; output_tokens: number } } }
  | { event: "error"; data: ErrorBody };
