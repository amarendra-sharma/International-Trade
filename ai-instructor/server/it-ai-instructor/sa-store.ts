// sa-store.ts - the Game Theory / StrategyArena (sa_*) flavour of the production store. Everything about the AI instructor itself (sessions, turns, usage, mastery,
// review, content) lives in the sa_ai_* tables via the SAME SupabaseStore code; this class only replaces the few lookups that read the portal's own tables:
// who a user is, whether they may use a course, and their chapter progress.
//   Econometrics ids are text; sa_enrollments has no status column (a row means enrolled); quizzes live in sa_chapter_progress.percent (reading counts at percent >= 1).
import { DEFAULT_SETTINGS, firstName, mapSettings, SupabaseStore } from "./supabase-store.ts";
import type { CourseAccess, CourseSettings, ProgressSummary, Role } from "./store.ts";

export class SaSupabaseStore extends SupabaseStore {
  // deno-lint-ignore no-explicit-any
  constructor(db: any) { super(db, "sa_ai_"); this.keysTable = "sa_ai_keys"; }

  async getRole(userId: string): Promise<Role | null> {
    const r = await this.one(this.db.from("sa_profiles").select("role").eq("id", userId).maybeSingle());
    if (!r) return null;
    return r.role === "admin" ? "admin" : r.role === "instructor" ? "instructor" : "student";
  }

  async getCourseAccess(userId: string, courseId: string, now: Date): Promise<CourseAccess> {
    const empty = (reason: CourseAccess["reason"]): CourseAccess => ({ allowed: false, reason, isStaff: false, ownerId: "", title: "", term: null, settings: DEFAULT_SETTINGS });
    const course = await this.one(this.db.from("sa_courses").select("id,owner_id,title,term,is_active,access_starts,access_ends,requires_payment").eq("id", courseId).maybeSingle());
    if (!course) return empty("not_found");
    const [srow, person, staff] = await Promise.all([
      this.one(this.db.from(this.t("settings")).select("*").eq("course_id", courseId).maybeSingle()),
      this.one(this.db.from("sa_profiles").select("role,full_name").eq("id", userId).maybeSingle()),
      this.one(this.db.from("sa_course_staff").select("can_view_work,can_view_gradebook,can_grade,can_edit_items,can_manage_deadlines").eq("course_id", courseId).eq("user_id", userId).maybeSingle()),
    ]);
    const settings: CourseSettings = srow ? mapSettings(srow) : { ...DEFAULT_SETTINGS, payer: "platform" };
    const studentName = firstName(person?.full_name);
    const platformKeyOwner = settings.payer === "platform" ? (await this.platformKeyOwner()) ?? undefined : undefined;
    const base = { ...(studentName ? { studentName } : {}), ownerId: String(course.owner_id), title: course.title as string, term: (course.term ?? null) as string | null, settings, ...(platformKeyOwner ? { platformKeyOwner } : {}) };
    const isStaff = course.owner_id === userId || person?.role === "admin" || !!(staff && (staff.can_view_work || staff.can_view_gradebook || staff.can_grade || staff.can_edit_items || staff.can_manage_deadlines));
    if (isStaff) return { allowed: true, isStaff: true, ...base };

    const enr = await this.one(this.db.from("sa_enrollments").select("id,status").eq("course_id", courseId).eq("student_id", userId).eq("status", "active").limit(1).maybeSingle());
    if (!enr) return { allowed: false, reason: "not_enrolled", isStaff: false, ...base };
    if (!course.is_active) return { allowed: false, reason: "inactive", isStaff: false, ...base };
    const day = (d: Date) => d.toISOString().slice(0, 10);
    if ((course.access_starts && day(now) < String(course.access_starts)) || (course.access_ends && day(now) > String(course.access_ends))) return { allowed: false, reason: "expired", isStaff: false, ...base };
    return { allowed: true, isStaff: false, ...base };
  }

  /** Stored AI keys live in this project's sa_ai_keys table (owner = an administrator's account id). */
  async platformKeyOwner(): Promise<string | null> {
    const admins = await this.db.from("sa_profiles").select("id").eq("role", "admin");
    if (admins.error) throw new Error("db: platform key lookup failed");
    const ids = (admins.data ?? []).map((r: { id: string }) => r.id);
    if (!ids.length) return null;
    const r = await this.db.from("sa_ai_keys").select("owner_id").in("owner_id", ids).order("updated_at", { ascending: true }).limit(1);
    if (r.error) throw new Error("db: platform key lookup failed");
    return r.data?.[0]?.owner_id ?? null;
  }

  async getProgress(userId: string, courseId: string): Promise<ProgressSummary> {
    const [prog, evs] = await Promise.all([
      this.db.from("sa_chapter_progress").select("chapter,reading_done,quiz_passed").eq("student_id", userId).eq("course_id", courseId),
      this.db.from(this.t("events")).select("event,topic,created_at").eq("user_id", userId).eq("course_id", courseId).order("created_at", { ascending: false }).limit(100),
    ]);
    // deno-lint-ignore no-explicit-any
    const rows: any[] = prog.data ?? [], events: any[] = evs.data ?? [];
    const topics: string[] = []; for (const e of events) if (!topics.includes(e.topic) && topics.length < 5) topics.push(e.topic);
    return {
      chaptersRead: rows.filter((r) => r.reading_done === true).map((r) => r.chapter).sort((a, b) => a - b),
      quizzesPassed: rows.filter((r) => r.quiz_passed === true).map((r) => r.chapter).sort((a, b) => a - b),
      practiceAsked: events.filter((e) => e.event === "practice_attempted").length, practiceSolved: events.filter((e) => e.event === "practice_solved").length, recentTopics: topics,
    };
  }
}
