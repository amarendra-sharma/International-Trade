// eq-store.ts - the Econometrics (eq_*) flavour of the production store. Everything about the AI instructor itself (sessions, turns, usage, mastery,
// review, content) lives in the eq_ai_* tables via the SAME SupabaseStore code; this class only replaces the few lookups that read the portal's own tables:
// who a user is, whether they may use a course, and their chapter progress.
//   Econometrics ids are text; eq_enrollments has no status column (a row means enrolled); quizzes live in eq_chapter_progress.percent (reading counts at percent >= 1).
import { DEFAULT_SETTINGS, firstName, mapSettings, SupabaseStore } from "./supabase-store.ts";
import type { CourseAccess, CourseSettings, ProgressSummary, Role } from "./store.ts";

export class EqSupabaseStore extends SupabaseStore {
  // deno-lint-ignore no-explicit-any
  constructor(db: any) { super(db, "eq_ai_"); }

  async getRole(userId: string): Promise<Role | null> {
    const r = await this.one(this.db.from("eq_profiles").select("role").eq("id", userId).maybeSingle());
    if (!r) return null;
    return r.role === "admin" ? "admin" : r.role === "instructor" ? "instructor" : "student";
  }

  async getCourseAccess(userId: string, courseId: string, now: Date): Promise<CourseAccess> {
    const empty = (reason: CourseAccess["reason"]): CourseAccess => ({ allowed: false, reason, isStaff: false, ownerId: "", title: "", term: null, settings: DEFAULT_SETTINGS });
    const course = await this.one(this.db.from("eq_courses").select("id,owner_id,title,term,is_active,opens_at,closes_at").eq("id", courseId).maybeSingle());
    if (!course) return empty("not_found");
    const [srow, person, staff] = await Promise.all([
      this.one(this.db.from(this.t("settings")).select("*").eq("course_id", courseId).maybeSingle()),
      this.one(this.db.from("eq_profiles").select("role,full_name").eq("id", userId).maybeSingle()),
      this.one(this.db.from("eq_course_staff").select("can_view,can_grade,can_edit").eq("course_id", courseId).eq("user_id", userId).maybeSingle()),
    ]);
    const settings: CourseSettings = srow ? mapSettings(srow) : { ...DEFAULT_SETTINGS, payer: "platform" };
    const studentName = firstName(person?.full_name);
    const platformKeyOwner = settings.payer === "platform" ? (await this.platformKeyOwner()) ?? undefined : undefined;
    const base = { ...(studentName ? { studentName } : {}), ownerId: String(course.owner_id), title: course.title as string, term: (course.term ?? null) as string | null, settings, ...(platformKeyOwner ? { platformKeyOwner } : {}) };
    const isStaff = course.owner_id === userId || person?.role === "admin" || !!(staff && (staff.can_view || staff.can_grade || staff.can_edit));
    if (isStaff) return { allowed: true, isStaff: true, ...base };

    const enr = await this.one(this.db.from("eq_enrollments").select("id").eq("course_id", courseId).eq("student_id", userId).limit(1).maybeSingle());
    if (!enr) return { allowed: false, reason: "not_enrolled", isStaff: false, ...base };
    if (!course.is_active) return { allowed: false, reason: "inactive", isStaff: false, ...base };
    if ((course.opens_at && now < new Date(course.opens_at)) || (course.closes_at && now > new Date(course.closes_at))) return { allowed: false, reason: "expired", isStaff: false, ...base };
    return { allowed: true, isStaff: false, ...base };
  }

  /** Stored AI keys live in the shared it_ai_keys table (owner = an administrator's account id, which is the same auth user in both portals). */
  async platformKeyOwner(): Promise<string | null> {
    const admins = await this.db.from("eq_profiles").select("id").eq("role", "admin");
    if (admins.error) throw new Error("db: platform key lookup failed");
    const ids = (admins.data ?? []).map((r: { id: string }) => r.id);
    if (!ids.length) return null;
    const r = await this.db.from("it_ai_keys").select("owner_id").in("owner_id", ids).order("updated_at", { ascending: true }).limit(1);
    if (r.error) throw new Error("db: platform key lookup failed");
    return r.data?.[0]?.owner_id ?? null;
  }

  async getProgress(userId: string, courseId: string): Promise<ProgressSummary> {
    const [prog, evs] = await Promise.all([
      this.db.from("eq_chapter_progress").select("chapter,percent").eq("student_id", userId).eq("course_id", courseId),
      this.db.from(this.t("events")).select("event,topic,created_at").eq("user_id", userId).eq("course_id", courseId).order("created_at", { ascending: false }).limit(100),
    ]);
    // deno-lint-ignore no-explicit-any
    const rows: any[] = prog.data ?? [], events: any[] = evs.data ?? [];
    const topics: string[] = []; for (const e of events) if (!topics.includes(e.topic) && topics.length < 5) topics.push(e.topic);
    return {
      chaptersRead: rows.filter((r) => Number(r.percent) >= 1).map((r) => r.chapter).sort((a, b) => a - b),
      quizzesPassed: rows.filter((r) => Number(r.percent) >= 70).map((r) => r.chapter).sort((a, b) => a - b),
      practiceAsked: events.filter((e) => e.event === "practice_attempted").length, practiceSolved: events.filter((e) => e.event === "practice_solved").length, recentTopics: topics,
    };
  }
}
