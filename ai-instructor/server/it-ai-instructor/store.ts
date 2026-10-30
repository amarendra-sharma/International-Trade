// store.ts - everything the conversation logic needs from persistence. Implemented by supabase-store.ts for production
// and by tests/memory-store.ts for unit tests. Each method that must be atomic (beginTurn, finishTurn) is one database call.
import type { Control } from "./resilience.ts";
import type { SessionState } from "./schemas.ts";

export type Role = "student" | "instructor" | "admin";
export type AiPolicy = "full" | "hints_only" | "concepts_only";
export interface CourseSettings {
  enabled: boolean; retentionDays: number; studentDailyTokens: number; courseMonthlyUsd: number; model: string;
  // instructor-configured rules about AI assistance (migration 003)
  aiPolicy: AiPolicy; allowWorkedSolutions: boolean; blockDuringAssessments: boolean; learningRecordDays: number; storeMastery: boolean;
  // graded-work review (migration 005). Off until the course owner turns it on; each student must also agree.
  reviewEnabled: boolean; reviewShowSolutions: boolean;
  // who pays for the AI: the course owner's own key (default), or the platform's key (migration 006). Only a platform administrator can change it.
  payer: "instructor" | "platform";
  // what students may use the AI for (migration 104, Micro only): "course_only" refuses anything outside the course subject; textbook explanations on/off; which kinds of graded work can be reviewed
  scopeMode: "course_only" | "open"; useTextbook: boolean; reviewKinds: ReviewKind[];
  // professor mode (migration 112, Macroeconomics): the course owner lets the AI act for the course staff. Staff sessions only.
  professorMode?: boolean;
  /** raw professor-mode columns (undefined when the course family has none); professorMode above is the effective value (on and not paused) */
  profOn?: boolean; profPaused?: boolean;
}
export type ReviewKind = "exams" | "quizzes" | "assignments" | "arenas";
export const REVIEW_KINDS: ReviewKind[] = ["exams", "quizzes", "assignments", "arenas"];
export interface CourseAccess {
  allowed: boolean; reason?: "not_found" | "not_enrolled" | "inactive" | "expired" | "payment_required";
  isStaff: boolean; ownerId: string; title: string; term: string | null; settings: CourseSettings;
  studentName?: string;           // the signed-in user's first name, for greeting them
  platformKeyOwner?: string;      // set only for payer="platform" courses: the admin account whose stored key pays
}
export interface StoredKey {
  ciphertext: string; iv: string; model: string; last4: string; updatedAt: string;
  provider: string;                    // "anthropic" (default) or an OpenAI-compatible preset id; see config.ts PROVIDERS
  baseUrl: string | null;              // only for provider "custom": an operator-allowlisted https host
  priceIn: number | null; priceOut: number | null;   // instructor-entered USD per million tokens (non-Anthropic only); null = conservative placeholder
}
export interface SessionRow { id: string; courseId: string; userId: string; state: SessionState; startedAt: string; lastActivityAt: string; endedAt: string | null; retentionDays: number }
export interface Message { seq: number; role: "user" | "assistant"; content: string; turnId: string; interrupted: boolean }

export type BeginResult =
  | { kind: "ok"; turnId: string; seq: number }
  | { kind: "duplicate"; turnId: string; status: string }
  | { kind: "in_progress"; turnId: string }
  | { kind: "rate_limited"; retryAfterS: number; scope: "user_minute" | "user_day" | "session_hour" }
  | { kind: "budget"; scope: "student" | "course" }
  | { kind: "busy"; retryAfterS: number }
  | { kind: "session_ended" | "session_not_found" };

export interface BeginTurnInput { sessionId: string; userId: string; courseId: string; clientTurnId: string; text: string; settings: CourseSettings; now: Date; maxGenerating?: number }
export interface UsageRecord {
  turnId: string; courseId: string; userId: string; sessionId: string; model: string;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costMicroUsd: number; latencyMs: number; ttftMs: number | null;
}
export interface FinishTurnInput { turnId: string; status: "completed" | "interrupted" | "failed"; assistantText: string; errorCode?: string; usage: UsageRecord; endState: SessionState }

export interface PracticeItem { id: string; topic: string; topicKey: string | null; question: string; answer: string; answerKind: "numeric" | "short_text" | "multiple_choice"; hints: string[]; attempts: number; solved: boolean; hinted: boolean }
export type LearningEventKind = "topic_discussed" | "help_requested" | "practice_attempted" | "practice_solved";
export interface LearningEvent { event: LearningEventKind; topic: string; detail?: "hint" | "worked_solution" | "explanation" | "example" | "check_reasoning" | "clarification" }
export interface MasteryRow { topicKey: string; alpha: number; beta: number; attempts: number; lastAt: string }
export interface ProgressSummary { chaptersRead: number[]; quizzesPassed: number[]; practiceAsked: number; practiceSolved: number; recentTopics: string[] }

// ---- graded-work review (migration 005). Every call is scoped to ONE student in ONE course and re-checks consent, deadlines and ownership in the database. ----
export type ReviewReason = "not_enrolled" | "review_off" | "no_consent" | "assessment_in_progress" | "bad_ref" | "not_found" | "still_open" | "no_deadline";
export interface ReviewConsent { granted: boolean; updatedAt: string | null; textVersion: number }
export interface ReviewListItem { ref: string; kind: "exam" | "quiz" | "arena" | "assignment" | "paper"; title: string; closesAt: string | null; submittedAt: string | null; items: number; reviewable: boolean; reason: "still_open" | "no_deadline" | "review_off" | null }
export type ReviewList = { allowed: true; items: ReviewListItem[] } | { allowed: false; reason: ReviewReason };
/** A graded paper (bubble-sheet) exam: the scanned pages live in the private paper-scans bucket and are fetched by the STUDENT'S browser with their own session. */
export interface ReviewScan { sheetId: string; paths: string[]; score: number | null; maxScore: number | null; mode: "score" | "answers" | "questions" }
export type ReviewDetail = { allowed: true; kind: string; title: string; closesAt: string | null; solutionsIncluded: boolean; items: Record<string, unknown>[]; scan?: ReviewScan } | { allowed: false; reason: ReviewReason; closesAt?: string | null };
export interface MeetingRequest { id: string; with: "ta" | "professor"; topic: string; note?: string | null; status: "open" | "done"; createdAt: string; student?: string }
export interface ReviewRepo {
  profCall?(name: ProfCall, args: Record<string, unknown>): Promise<any>;
  reviewConsentGet(userId: string, courseId: string): Promise<ReviewConsent>;
  reviewConsentSet(userId: string, courseId: string, granted: boolean, version: number): Promise<{ ok: boolean; reason?: string } & Partial<ReviewConsent>>;
  reviewList(userId: string, courseId: string, now: Date): Promise<ReviewList>;
  reviewGet(userId: string, courseId: string, ref: string, solutions: boolean, sessionId: string | null, now: Date): Promise<ReviewDetail>;
  reviewLogMine(userId: string, courseId: string): Promise<{ kind: string; at: string }[]>;
  walkSet?(sessionId: string, userId: string, courseId: string, w: WalkRecord): Promise<void>;
  walkGet?(sessionId: string, userId: string): Promise<WalkRecord | null>;
  walkPos?(sessionId: string, userId: string, pos: number): Promise<void>;
  requestMeeting(userId: string, courseId: string, withWhom: "ta" | "professor", topic: string, note: string | null): Promise<{ ok: boolean; id?: string; reason?: string }>;
  myMeetingRequests(userId: string, courseId: string): Promise<MeetingRequest[]>;
  listMeetingRequests(userId: string, courseId: string): Promise<{ ok: boolean; requests: MeetingRequest[] }>;
  completeMeetingRequest(userId: string, courseId: string, id: string): Promise<boolean>;
}

export interface Store extends Partial<ReviewRepo> {
  getRole(userId: string): Promise<Role | null>;
  getCourseAccess(userId: string, courseId: string, now: Date): Promise<CourseAccess>;
  getStoredKey(ownerId: string): Promise<StoredKey | null>;
  /** The admin account whose stored key is the platform key (the oldest admin key). Optional so test doubles can omit it. */
  platformKeyOwner?(): Promise<string | null>;
  putStoredKey(ownerId: string, k: Omit<StoredKey, "updatedAt">): Promise<void>;
  deleteStoredKey(ownerId: string): Promise<void>;
  setSettings(courseId: string, patch: Partial<CourseSettings>): Promise<CourseSettings>;

  createSession(userId: string, courseId: string, retentionDays: number, now: Date): Promise<{ ok: true; session: SessionRow } | { ok: false; code: "rate_limited" }>;
  getSession(id: string): Promise<SessionRow | null>;
  setSessionState(id: string, to: SessionState): Promise<SessionState>;       // validates the transition, returns the new state
  endSession(id: string): Promise<void>;

  beginTurn(i: BeginTurnInput): Promise<BeginResult>;
  turnStatus(turnId: string): Promise<"generating" | "completed" | "interrupted" | "failed" | "missing">;
  listMessages(sessionId: string, afterSeq?: number): Promise<Message[]>;
  finishTurn(i: FinishTurnInput): Promise<boolean>;                              // true only for the call that actually closed the turn
  interruptTurn(sessionId: string, userId: string, clientTurnId: string, spokenChars: number | null): Promise<boolean>;
  purgeExpired(now: Date): Promise<number>;

  createPractice(userId: string, courseId: string, sessionId: string, p: Omit<PracticeItem, "id" | "attempts" | "solved" | "hinted">): Promise<{ id: string } | { error: "limit" }>;
  getPractice(userId: string, sessionId: string, id: string): Promise<PracticeItem | null>;
  recordPracticeAttempt(userId: string, id: string, solved: boolean, hinted?: boolean): Promise<void>;
  /** Approved learning events only (migration 003). `topic` is a controlled key (a section id), never free text; there is no note field. */
  recordEvent(userId: string, courseId: string, sessionId: string, idemKey: string, ev: LearningEvent): Promise<"recorded" | "duplicate">;
  getProgress(userId: string, courseId: string): Promise<ProgressSummary>;

  // ---- learning records (migration 003) ----
  assessmentActive(userId: string, courseId: string, now: Date): Promise<boolean>;
  updateMastery(userId: string, courseId: string, topicKey: string, correct: boolean, weight: number): Promise<void>;
  getMastery(userId: string, courseId: string): Promise<MasteryRow[]>;
  saveFeedback(userId: string, courseId: string, sessionId: string, turnId: string | null, rating: "helpful" | "not_helpful", reason: string | null): Promise<void>;
  deleteLearnerData(userId: string, courseId: string): Promise<{ events: number; mastery: number; feedback: number; sessions: number }>;

  // ---- operations (migration 002). Optional so older stores keep working; callers treat absence as "feature off". ----
  ingestMaterials?(courseId: string, src: { id: string; title: string; kind: string }, chunks: IngestChunk[], replace: boolean): Promise<number>;
  getControl?(): Promise<Control | null>;
  setControl?(patch: Partial<Control>): Promise<Control>;
  countActiveSessions?(withinSeconds: number): Promise<number>;
  reportUsage?(sessionId: string, userId: string, m: SessionMetrics): Promise<boolean>;
  courseSpend?(courseId: string, now: Date): Promise<{ monthUsd: number; todayTurns: number; activeSessions: number }>;
}
export interface IngestChunk { chunk_key: string; source_key: string; chapter: number; section: string; heading: string; kind: string; ord: number; pos: number; title: string; body: string }
export interface SessionMetrics { asrMs?: number; ttsMs?: number; audioInMs?: number; audioOutMs?: number; avatarBytes?: number; avatarInitMs?: number; ttfaMs?: number; turns?: number; interruptions?: number; syncErrors?: number; audioDrops?: number; textOnly?: boolean }

// Course content (migration 003). Every call is scoped to ONE student in ONE course; the database re-checks enrolment on each call.
export interface ContentScope { userId: string; courseId: string; chapter?: number | null }
export interface Passage {
  chunkKey: string; sourceKey: string; title: string; chapter: number; section: string; heading: string; kind: string; text: string;
  score: number; allTerms: boolean; matched: number; total: number; unknown: number;
}
export interface OutlineEntry { chapter: number; section: string; sourceKey: string; heading: string; kind: string; chunks: number }
export interface ContentRepo {
  search(scope: ContentScope, query: string, limit: number): Promise<Passage[]>;
  getSection(scope: ContentScope, sourceKey: string): Promise<Passage[]>;
  outline(scope: ContentScope, chapter?: number): Promise<OutlineEntry[]>;
  /** The complete text of every textbook-kind source linked to the course, ready to place in a cached prompt block. Optional: absent means "retrieval only". */
  fullText?(courseId: string): Promise<string>;
  /** The book split for fast voice turns: table of contents plus each chapter's own text. Optional. */
  bookData?(courseId: string): Promise<{ full: string; toc: string; chapters: Map<number, string> }>;
}
export const NullContent: ContentRepo = { search: async () => [], getSection: async () => [], outline: async () => [] };

export interface WalkRecord { ref: string; title: string; items: import("./visuals.ts").MissedItem[]; pos: number; solutions: boolean; score: number | null; maxScore: number | null; scan?: Record<string, unknown> | null }

/** The fixed set of professor-mode database functions (ma_ai_prof_*). Nothing else can be reached through profCall. */
export type ProfCall = "overview" | "set_exam_window" | "announce" | "finalize" | "exam_results" | "undo" | "recent";
export const PROF_CALLS: readonly ProfCall[] = ["overview", "set_exam_window", "announce", "finalize", "exam_results", "undo", "recent"];
