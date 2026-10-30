-- ============================================================================
-- 102_im_ai_review.sql  --  Macroeconomics AI Instructor: graded-work review (consent + release gated), meeting requests
-- STATUS: NOT APPLIED. Requires 101_im_ai_core.sql. Apply only with explicit approval. Additive; it READS ma_* tables and NEVER writes to them.
--
-- Rules enforced INSIDE the database (the Edge Function checks them too; this is the second lock):
--   1. The course must have AI review switched on (ma_ai_settings.review_enabled, default FALSE).
--   2. The student must have agreed (ma_ai_review_consent). Per student per course; withdrawable; only ever written by the student's own action.
--   3. Only the calling student's OWN work is returned. The student id comes from the authenticated session, never from the model.
--   4. Online exams, chapter quizzes, arenas and assignments are reviewable only after they have closed FOR EVERYONE (the later of the course
--      deadline and every per-student extension in ma_assessment_accommodation), and only if the course's own review switches allow that kind
--      (ma_course.review_exams / review_quizzes / review_arenas). review_wrong_only is honoured: only missed items are returned.
--   5. Paper (bubble-sheet) exams follow the Sheetwise release exactly: graded sheet, release open, and the release MODE decides what is shown
--      (score = totals and the scan; answers = + your answer, correct answer and points; questions = + the question text and choices).
--   6. Hidden rubrics are never returned. Correct answers appear only when the caller allows solutions (and).
--   7. Every read is logged (kind and reference only) so the student can see what was opened.
-- ============================================================================

alter table public.ma_ai_settings
  add column if not exists review_enabled boolean not null default false,
  add column if not exists review_show_solutions boolean not null default true;

create table if not exists public.ma_ai_review_consent (
  user_id      uuid not null,
  course_id    uuid not null references public.ma_course(id) on delete cascade,
  granted      boolean not null default false,
  text_version integer not null default 1,
  granted_at   timestamptz,
  revoked_at   timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (user_id, course_id)
);

create table if not exists public.ma_ai_review_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  course_id  uuid not null references public.ma_course(id) on delete cascade,
  session_id uuid,
  kind       text not null check (kind in ('exam','quiz','arena','assignment','paper')),
  ref        text not null check (char_length(ref) <= 60),
  at         timestamptz not null default now()
);
create index if not exists ma_ai_review_log_user on public.ma_ai_review_log (user_id, course_id, at desc);

create table if not exists public.ma_ai_review_requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  course_id  uuid not null references public.ma_course(id) on delete cascade,
  with_whom  text not null check (with_whom in ('ta','professor')),
  topic      text not null check (char_length(topic) between 1 and 200),
  note       text check (note is null or char_length(note) <= 500),
  status     text not null default 'open' check (status in ('open','done')),
  created_at timestamptz not null default now(),
  done_at    timestamptz,
  done_by    uuid
);
create index if not exists ma_ai_review_requests_course on public.ma_ai_review_requests (course_id, status, created_at desc);

do $$ declare t text; begin
  foreach t in array array['ma_ai_review_consent','ma_ai_review_log','ma_ai_review_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ---- who is staff for this course ---------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_is_staff(p_user uuid, p_course uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ma_course c where c.id = p_course and c.owner_id = p_user::text)
      or exists (select 1 from public.ma_person p where p.user_id = p_user::text and p.role::text = 'admin')
      or exists (select 1 from public.ma_course_staff s where s.course_id = p_course and s.user_id = p_user::text and (s.can_view_grades or s.can_grade or s.can_edit_exams or s.can_view_roster));
$$;

-- ---- when does an item close FOR EVERYONE? -------------------------------------------------------------------------------------------
-- The later of the course-level deadline and any student's extension for the same item. NULL = never reviewable.
create or replace function public.ma_ai_review_closes(p_course uuid, p_kind text, p_exam uuid, p_chapter integer, p_slug text, p_asg uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select greatest(
    case p_kind
      when 'exam'       then (select e.closes_at from public.ma_exam e where e.id = p_exam and e.course_id = p_course)
      when 'quiz'       then (select d.closes_at from public.ma_quiz_deadline d where d.course_id = p_course and d.chapter = p_chapter)
      when 'arena'      then (select d.closes_at from public.ma_arena_deadline d where d.course_id = p_course and d.arena_slug = p_slug)
      when 'assignment' then (select a.due_at from public.ma_assignment a where a.id = p_asg and a.course_id = p_course)
    end,
    (select max(o.due_override) from public.ma_assessment_accommodation o
      where o.course_id = p_course and o.due_override is not null and o.kind = p_kind and o.ref_id = case p_kind
        when 'exam' then p_exam::text when 'quiz' then p_chapter::text when 'arena' then p_slug when 'assignment' then p_asg::text end)
  );
$$;

-- ---- the gate every read passes: null = allowed, otherwise the reason ---------------------------------------------------------------------
create or replace function public.ma_ai_review_gate(p_user uuid, p_course uuid, p_now timestamptz)
returns text language sql stable security definer set search_path = public as $$
  select case
    when not public.ma_ai_can_read(p_user, p_course) then 'not_enrolled'
    when not coalesce((select s.review_enabled from public.ma_ai_settings s where s.course_id = p_course), false) then 'review_off'
    when not coalesce((select c.granted from public.ma_ai_review_consent c where c.user_id = p_user and c.course_id = p_course), false) then 'no_consent'
    when public.ma_ai_assessment_active(p_user, p_course, p_now) then 'assessment_in_progress'
    else null end;
$$;

-- ---- consent -----------------------------------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_review_consent_get(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('granted', c.granted, 'updated_at', c.updated_at, 'text_version', c.text_version)
                   from public.ma_ai_review_consent c where c.user_id = p_user and c.course_id = p_course),
                  jsonb_build_object('granted', false, 'updated_at', null, 'text_version', 1));
$$;

create or replace function public.ma_ai_review_consent_set(p_user uuid, p_course uuid, p_granted boolean, p_version integer default 1, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.ma_ai_can_read(p_user, p_course) then return jsonb_build_object('ok', false, 'reason', 'not_enrolled'); end if;
  insert into public.ma_ai_review_consent as c (user_id, course_id, granted, text_version, granted_at, revoked_at, updated_at)
  values (p_user, p_course, p_granted, p_version, case when p_granted then p_now end, case when p_granted then null else p_now end, p_now)
  on conflict (user_id, course_id) do update set
    granted = excluded.granted, text_version = excluded.text_version, updated_at = p_now,
    granted_at = case when excluded.granted then p_now else c.granted_at end,
    revoked_at = case when excluded.granted then null else p_now end;
  return jsonb_build_object('ok', true) || public.ma_ai_review_consent_get(p_user, p_course);
end $$;


-- ---- what graded work does this student have, and which of it can be reviewed now? (Macro: no paper exams; exam rows are one per answered item) ----
create or replace function public.ma_ai_review_list(p_user uuid, p_course uuid, p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare g text := public.ma_ai_review_gate(p_user, p_course, p_now); res jsonb; c public.ma_course%rowtype;
begin
  if g is not null then return jsonb_build_object('allowed', false, 'reason', g); end if;
  select * into c from public.ma_course where id = p_course;
  with rows as (
    select 'exam:' || a.exam_id as ref, 'exam' as kind, coalesce(e.title, 'Exam') as title, public.ma_ai_review_closes(p_course, 'exam', a.exam_id, null, null, null) as closes,
           max(a.created_at) as at, count(*)::int as n
      from public.ma_exam_attempt a left join public.ma_exam e on e.id = a.exam_id
     where a.student_id = p_user::text and a.course_id = p_course and a.exam_id is not null
     group by a.exam_id, e.title
    union all
    select 'quiz:' || q.chapter, 'quiz', 'Chapter ' || q.chapter || ' quiz', public.ma_ai_review_closes(p_course, 'quiz', null, q.chapter, null, null), q.updated_at, 0
      from public.ma_chapter_progress q where q.student_id = p_user::text and q.course_id = p_course and coalesce(q.quiz_attempts, 0) > 0
    union all
    select 'arena:' || t.arena_slug, 'arena', initcap(replace(t.arena_slug, '-', ' ')) || ' arena', public.ma_ai_review_closes(p_course, 'arena', null, null, t.arena_slug, null), max(t.created_at), count(*)::int
      from public.ma_attempt t where t.user_id = p_user::text and (t.course_id = p_course or t.course_id is null) group by t.arena_slug
    union all
    select 'asg:' || b.id, 'assignment', a.title, public.ma_ai_review_closes(p_course, 'assignment', null, null, null, a.id), b.submitted_at, 1
      from public.ma_submission b join public.ma_assignment a on a.id = b.assignment_id
     where b.student_id = p_user::text and b.course_id = p_course
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'ref', ref, 'kind', kind, 'title', title, 'closes_at', closes, 'submitted_at', at, 'items', n,
      'reviewable', case when kind = 'exam' and not coalesce(c.review_exams, false) then false
                         when kind = 'quiz' and not coalesce(c.review_quizzes, false) then false
                         when kind = 'arena' and not coalesce(c.review_arenas, false) then false
                         else closes is not null and closes <= p_now end,
      'reason', case when kind = 'exam' and not coalesce(c.review_exams, false) then 'review_off'
                     when kind = 'quiz' and not coalesce(c.review_quizzes, false) then 'review_off'
                     when kind = 'arena' and not coalesce(c.review_arenas, false) then 'review_off'
                     when closes is null then 'no_deadline' when closes > p_now then 'still_open' else null end) order by at desc nulls last), '[]'::jsonb)
    into res from (select * from rows order by at desc nulls last limit 80) x;
  return jsonb_build_object('allowed', true, 'items', res);
end $$;

-- ---- open one item ------------------------------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_review_get(p_user uuid, p_course uuid, p_ref text, p_solutions boolean default false, p_session uuid default null, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g text := public.ma_ai_review_gate(p_user, p_course, p_now); c public.ma_course%rowtype;
  v_kind text; v_key text; v_id uuid; closes timestamptz; res jsonb;
  e public.ma_exam%rowtype; asg public.ma_assignment%rowtype; sub public.ma_submission%rowtype;
  wrong_only constant boolean := true;      -- Macro has no per-course switch yet: only missed items are returned
begin
  if g is not null then return jsonb_build_object('allowed', false, 'reason', g); end if;
  select * into c from public.ma_course where id = p_course;
  if p_ref !~ '^(exam|asg):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     and p_ref !~ '^quiz:[0-9]{1,3}$' and p_ref !~ '^arena:[a-z0-9-]{1,50}$' then return jsonb_build_object('allowed', false, 'reason', 'bad_ref'); end if;
  v_kind := split_part(p_ref, ':', 1); v_key := split_part(p_ref, ':', 2);

  if v_kind = 'exam' then
    v_id := v_key::uuid;
    select * into e from public.ma_exam where id = v_id and course_id = p_course;
    if not found then return jsonb_build_object('allowed', false, 'reason', 'not_found'); end if;
    if not coalesce(c.review_exams, false) then return jsonb_build_object('allowed', false, 'reason', 'review_off'); end if;
    closes := public.ma_ai_review_closes(p_course, 'exam', v_id, null, null, null);
    if closes is null then return jsonb_build_object('allowed', false, 'reason', 'no_deadline'); end if;
    if closes > p_now then return jsonb_build_object('allowed', false, 'reason', 'still_open', 'closes_at', closes); end if;
    select jsonb_build_object('allowed', true, 'kind', 'exam', 'title', e.title, 'closes_at', closes, 'solutions_included', p_solutions,
      'items', coalesce(jsonb_agg(
        jsonb_build_object(
          'n', x.ord, 'question', left(coalesce(i.prompt, ''), 700), 'type', i.item_type,
          'options', case when jsonb_typeof(i.options) = 'array' then i.options else null end,
          'points_possible', coalesce(x.points_possible, i.points), 'points_earned', x.points_earned, 'student_answer', left(x.submitted_value, 300),
          'student_choice', case when x.submitted_value ~ '^[0-9]{1,2}$' and jsonb_typeof(i.options) = 'array' then i.options ->> (x.submitted_value)::int else null end,
          'marked_correct', x.is_correct, 'graded', x.graded_at is not null,
          'question_unavailable', (i.prompt is null))
        || case when p_solutions then jsonb_build_object(
             'correct_choice', case when jsonb_typeof(i.options) = 'array' and k.correct_value ~ '^[0-9]{1,2}$' then i.options ->> (k.correct_value)::int else null end,
             'correct_value', left(k.correct_value, 200), 'explanation', left(k.rationale, 700)) else '{}'::jsonb end
        order by x.ord), '[]'::jsonb)) into res
    from (select a.*, row_number() over (order by a.created_at, a.id) as ord from public.ma_exam_attempt a
           where a.exam_id = v_id and a.student_id = p_user::text and a.course_id = p_course and (not wrong_only or a.is_correct is distinct from true) limit 60) x
    left join public.ma_assessment_item i on i.id = x.item_id
    left join public.ma_assessment_item_key k on k.item_id = x.item_id;

  elsif v_kind = 'quiz' then
    if not coalesce(c.review_quizzes, false) then return jsonb_build_object('allowed', false, 'reason', 'review_off'); end if;
    closes := public.ma_ai_review_closes(p_course, 'quiz', null, v_key::int, null, null);
    if closes is null then return jsonb_build_object('allowed', false, 'reason', 'no_deadline'); end if;
    if closes > p_now then return jsonb_build_object('allowed', false, 'reason', 'still_open', 'closes_at', closes); end if;
    select jsonb_build_object('allowed', true, 'kind', 'quiz', 'title', 'Chapter ' || v_key || ' quiz', 'closes_at', closes, 'solutions_included', false,
      'items', jsonb_build_array(jsonb_build_object('chapter', q.chapter, 'best_score', q.quiz_score, 'attempts', q.quiz_attempts, 'passed', q.quiz_passed,
        'note', 'Quiz questions are generated fresh for each attempt, so only the result is available here.'))) into res
      from public.ma_chapter_progress q where q.student_id = p_user::text and q.course_id = p_course and q.chapter = v_key::int;
    if res is null then return jsonb_build_object('allowed', false, 'reason', 'not_found'); end if;

  elsif v_kind = 'arena' then
    if not coalesce(c.review_arenas, false) then return jsonb_build_object('allowed', false, 'reason', 'review_off'); end if;
    closes := public.ma_ai_review_closes(p_course, 'arena', null, null, v_key, null);
    if closes is null then return jsonb_build_object('allowed', false, 'reason', 'no_deadline'); end if;
    if closes > p_now then return jsonb_build_object('allowed', false, 'reason', 'still_open', 'closes_at', closes); end if;
    select jsonb_build_object('allowed', true, 'kind', 'arena', 'title', initcap(replace(v_key, '-', ' ')) || ' arena', 'closes_at', closes, 'solutions_included', p_solutions,
      'items', coalesce(jsonb_agg(
        jsonb_build_object('n', x.ord, 'case', x.case_index, 'question', left(x.prompt_text, 700), 'student_choice', left(x.chosen_label, 300), 'marked_correct', x.is_correct, 'played_at', x.created_at)
        || case when p_solutions then jsonb_build_object('correct_choice', left(x.correct_label, 300)) else '{}'::jsonb end order by x.ord), '[]'::jsonb)) into res
    from (select t.*, row_number() over (order by t.created_at, t.id) as ord from public.ma_attempt t
           where t.user_id = p_user::text and (t.course_id = p_course or t.course_id is null) and t.arena_slug = v_key and (not wrong_only or t.is_correct is distinct from true) limit 60) x;

  else
    v_id := v_key::uuid;
    select * into sub from public.ma_submission where id = v_id and student_id = p_user::text and course_id = p_course;
    if not found then return jsonb_build_object('allowed', false, 'reason', 'not_found'); end if;
    select * into asg from public.ma_assignment where id = sub.assignment_id and course_id = p_course;
    if not found then return jsonb_build_object('allowed', false, 'reason', 'not_found'); end if;
    closes := public.ma_ai_review_closes(p_course, 'assignment', null, null, null, asg.id);
    if closes is null then return jsonb_build_object('allowed', false, 'reason', 'no_deadline'); end if;
    if closes > p_now then return jsonb_build_object('allowed', false, 'reason', 'still_open', 'closes_at', closes); end if;
    res := jsonb_build_object('allowed', true, 'kind', 'assignment', 'title', asg.title, 'closes_at', closes, 'solutions_included', false,
      'items', jsonb_build_array(jsonb_build_object('instructions', left(asg.instructions, 1500), 'points_possible', asg.points, 'score', sub.score,
        'instructor_feedback', left(sub.feedback, 1500), 'graded', sub.graded_at is not null)));
  end if;

  insert into public.ma_ai_review_log (user_id, course_id, session_id, kind, ref) values (p_user, p_course, p_session, v_kind, p_ref);
  return res;
end $$;

-- ---- what the AI instructor has opened for this student (metadata only) ---------------------------------------------------------------------
create or replace function public.ma_ai_review_log_mine(p_user uuid, p_course uuid, p_limit integer default 20)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'at', at) order by at desc), '[]'::jsonb)
    from (select kind, at from public.ma_ai_review_log where user_id = p_user and course_id = p_course order by at desc limit least(greatest(p_limit, 1), 50)) t;
$$;

-- ---- meeting requests (fallback when the student does not allow review) --------------------------------------------------------------------
create or replace function public.ma_ai_review_request_create(p_user uuid, p_course uuid, p_with text, p_topic text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if not public.ma_ai_can_read(p_user, p_course) then return jsonb_build_object('ok', false, 'reason', 'not_enrolled'); end if;
  if (select count(*) from public.ma_ai_review_requests where user_id = p_user and course_id = p_course and status = 'open') >= 5 then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  insert into public.ma_ai_review_requests (user_id, course_id, with_whom, topic, note) values (p_user, p_course, p_with, left(trim(p_topic), 200), nullif(left(trim(coalesce(p_note, '')), 500), '')) returning id into rid;
  return jsonb_build_object('ok', true, 'id', rid);
end $$;

create or replace function public.ma_ai_review_requests_mine(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'with', with_whom, 'topic', topic, 'status', status, 'created_at', created_at) order by created_at desc), '[]'::jsonb)
    from (select * from public.ma_ai_review_requests where user_id = p_user and course_id = p_course order by created_at desc limit 20) t;
$$;

create or replace function public.ma_ai_review_requests_list(p_user uuid, p_course uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ma_ai_is_staff(p_user, p_course) then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  return jsonb_build_object('ok', true, 'requests', coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'with', r.with_whom, 'topic', r.topic, 'note', r.note, 'status', r.status, 'created_at', r.created_at,
                                        'student', coalesce(nullif(p.full_name, ''), p.email, 'student')) order by (r.status = 'open') desc, r.created_at desc)
      from (select * from public.ma_ai_review_requests where course_id = p_course order by (status = 'open') desc, created_at desc limit 100) r
      left join public.ma_person p on p.user_id = r.user_id::text), '[]'::jsonb));
end $$;

create or replace function public.ma_ai_review_request_done(p_user uuid, p_course uuid, p_id uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.ma_ai_is_staff(p_user, p_course) then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  update public.ma_ai_review_requests set status = 'done', done_at = p_now, done_by = p_user where id = p_id and course_id = p_course and status = 'open';
  return jsonb_build_object('ok', found);
end $$;

-- ---- deletion and retention: the student's data goes with the rest of their learning data -------------------------------------------------------
create or replace function public.ma_ai_delete_learner_data(p_user uuid, p_course uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a integer; b integer; c integer; d integer; e integer;
begin
  delete from public.ma_ai_events   where user_id = p_user and course_id = p_course; get diagnostics a = row_count;
  delete from public.ma_ai_mastery  where user_id = p_user and course_id = p_course; get diagnostics b = row_count;
  delete from public.ma_ai_feedback where user_id = p_user and course_id = p_course; get diagnostics c = row_count;
  delete from public.ma_ai_sessions where user_id = p_user and course_id = p_course; get diagnostics d = row_count;
  delete from public.ma_ai_review_log where user_id = p_user and course_id = p_course; get diagnostics e = row_count;
  delete from public.ma_ai_review_consent where user_id = p_user and course_id = p_course;
  return jsonb_build_object('events', a, 'mastery', b, 'feedback', c, 'sessions', d, 'review_log', e);
end $$;

create or replace function public.ma_ai_purge_learning(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; k integer;
begin
  delete from public.ma_ai_events e where e.created_at < p_now - make_interval(days => coalesce((select s.learning_record_days from public.ma_ai_settings s where s.course_id = e.course_id), 180)); get diagnostics k = row_count; n := n + k;
  delete from public.ma_ai_mastery m where m.last_at < p_now - make_interval(days => coalesce((select s.learning_record_days from public.ma_ai_settings s where s.course_id = m.course_id), 180)); get diagnostics k = row_count; n := n + k;
  delete from public.ma_ai_feedback f where f.created_at < p_now - make_interval(days => coalesce((select s.learning_record_days from public.ma_ai_settings s where s.course_id = f.course_id), 180)); get diagnostics k = row_count; n := n + k;
  delete from public.ma_ai_review_log l where l.at < p_now - make_interval(days => coalesce((select s.learning_record_days from public.ma_ai_settings s where s.course_id = l.course_id), 180)); get diagnostics k = row_count; n := n + k;
  delete from public.ma_ai_review_requests q where q.status = 'done' and q.done_at < p_now - interval '365 days'; get diagnostics k = row_count; n := n + k;
  return n;
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'ma_ai_is_staff(uuid,uuid)', 'ma_ai_review_closes(uuid,text,uuid,integer,text,uuid)', 'ma_ai_review_gate(uuid,uuid,timestamptz)',
    'ma_ai_review_consent_get(uuid,uuid)', 'ma_ai_review_consent_set(uuid,uuid,boolean,integer,timestamptz)',
    'ma_ai_review_list(uuid,uuid,timestamptz)', 'ma_ai_review_get(uuid,uuid,text,boolean,uuid,timestamptz)', 'ma_ai_review_log_mine(uuid,uuid,integer)',
    'ma_ai_review_request_create(uuid,uuid,text,text,text)', 'ma_ai_review_requests_mine(uuid,uuid)', 'ma_ai_review_requests_list(uuid,uuid)',
    'ma_ai_review_request_done(uuid,uuid,uuid,timestamptz)', 'ma_ai_delete_learner_data(uuid,uuid)', 'ma_ai_purge_learning(timestamptz)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ROLLBACK (manual): drop the functions above, then
-- drop table if exists public.ma_ai_review_requests, public.ma_ai_review_log, public.ma_ai_review_consent;
-- alter table public.ma_ai_settings drop column if exists review_enabled, drop column if exists review_show_solutions;

