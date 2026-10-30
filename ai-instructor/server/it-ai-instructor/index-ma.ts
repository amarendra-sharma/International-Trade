// ============================================================================
// ma-ai-instructor - the same conversational AI instructor, for Macroeconomics (reads the ma_* portal tables, uses the ma_ai_* tables; needs migrations 107-110)
// Actions: start_session, turn (SSE), interrupt, client_state, history, end_session,
//          set_key, key_status, delete_key, get_settings, set_settings, report_usage, ops_status, set_control,
//          feedback, my_learning, delete_my_learning
// Supabase function name MUST be: ma-ai-instructor      (verify_jwt: true)
// Secrets required: AI_INSTRUCTOR_KEK (base64 of 32 random bytes), AI_INSTRUCTOR_LOG_SALT (any random string)
//   optional: AI_INSTRUCTOR_EXTRA_HOSTS (approved hosts for provider "custom"), AI_INSTRUCTOR_ORIGINS, AI_INSTRUCTOR_MODE.
//   plus the standard SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
// Needs migrations 001-004. Deploy with the Supabase CLI (see BACKEND.md); schema changes need explicit approval.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { LIMITS } from "./config.ts";
import { hashUser, makeSampledLogger } from "./log.ts";
import { routedProvider } from "./provider.ts";
import type { Deps } from "./converse.ts";
import { Admission, BreakerSet, ControlCache, isMode, TtlCache } from "./resilience.ts";
import { makeHandler } from "./handler.ts";
import { MaSupabaseStore } from "./ma-store.ts";
import { SupabaseContent } from "./content.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const salt = Deno.env.get("AI_INSTRUCTOR_LOG_SALT") ?? "";
const store = new MaSupabaseStore(admin);
const envMode = Deno.env.get("AI_INSTRUCTOR_MODE");        // optional hard override: "text_only" or "paused" (can only be MORE restrictive than the database switch)
const deps: Deps = {
  subject: "macroeconomics",
  store, control: new ControlCache(() => store.getControl(), isMode(envMode) ? envMode : "normal"), breakers: new BreakerSet(),
  admissionWaitMs: LIMITS.admissionWaitMs, accessCache: new TtlCache(LIMITS.accessCacheTtlMs), assessCache: new TtlCache(LIMITS.assessmentCacheTtlMs),
  provider: routedProvider, extraHosts: (Deno.env.get("AI_INSTRUCTOR_EXTRA_HOSTS") ?? "").split(",").map((x) => x.trim()).filter(Boolean), content: new SupabaseContent(admin, "ma_ai_"), log: makeSampledLogger((l) => console.log(l), { infoSampleRate: LIMITS.logInfoSampleRate, perSecond: LIMITS.logPerSecondPerInstance, burst: 20 }), gate: new Admission(LIMITS.isolateMaxConcurrentTurns, LIMITS.admissionQueueMax),
  kek: Deno.env.get("AI_INSTRUCTOR_KEK") ?? "", platformKeyOwner: Deno.env.get("AI_INSTRUCTOR_PLATFORM_KEY_OWNER") || undefined, userHash: (id) => hashUser(id, salt),
};

// Tighten AI_INSTRUCTOR_ORIGINS to the production origins when deploying (comma separated). "*" matches the existing functions.
Deno.serve(makeHandler(deps, {
  // The shared AI_INSTRUCTOR_ORIGINS secret lists the Micro / International Trade sites only, so Macroeconomics' own origins are always added here.
  allowedOrigins: [...(Deno.env.get("AI_INSTRUCTOR_ORIGINS") ?? "*").split(",").map((x) => x.trim()), "https://macroeconomics.macronations.com", "https://www.macroeconomics.macronations.com"],
  authenticate: async (req) => {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const { data } = await admin.auth.getUser(token);
    return data?.user?.id ?? null;
  },
}));
