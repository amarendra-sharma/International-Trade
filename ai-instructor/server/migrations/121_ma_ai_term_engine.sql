-- 121_ma_ai_term_engine.sql -- autonomous term engine for Asha: syllabus, planned lectures, exam creation from the question bank, server-side final grades with a veto window.

-- new actions are ON unless the owner explicitly turned them off
create or replace function public.ma_ai_prof_gate(p_user uuid, p_course uuid, p_cap text, p_action text)
returns text language plpgsql stable security definer set search_path = public as $$
declare s public.ma_ai_settings%rowtype; used int;
begin
  if not public.ma_ai_prof_can(p_user, p_course, p_cap) then return 'not_staff'; end if;
  select * into s from public.ma_ai_settings where course_id = p_course;
  if not found or not s.enabled then return 'ai_off'; end if;
  if not s.professor_mode then return 'prof_off'; end if;
  if s.prof_paused then return 'paused'; end if;
  if coalesce((s.prof_actions ->> p_action)::boolean, p_action in ('syllabus', 'lectures', 'exam_create', 'final_grades', 'grade_final')) is not true then return 'action_off'; end if;
  select count(*) into used from public.ma_ai_actions where course_id = p_course and created_at > now() - interval '1 day' and status = 'done';
  if used >= s.prof_daily_cap then return 'daily_cap'; end if;
  return null;
end $$;

create table if not exists public.ma_ai_syllabus (course_id uuid primary key, title text not null, body text not null, updated_at timestamptz not null default now());
create table if not exists public.ma_ai_term (course_id uuid primary key, ends_at timestamptz not null, hold_hours int not null default 48, auto_final boolean not null default true, final_queued_at timestamptz);
create table if not exists public.ma_ai_class_session (
  id uuid primary key default gen_random_uuid(), course_id uuid not null, seq int not null, title text not null, outline jsonb not null, starts_at timestamptz not null, duration_min int not null default 75,
  status text not null default 'planned' check (status in ('planned','live','done','missed')), class_id uuid);
create index if not exists ma_ai_class_session_idx on public.ma_ai_class_session (course_id, starts_at);
do $$ declare t text; begin
  foreach t in array array['ma_ai_syllabus','ma_ai_term','ma_ai_class_session'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- ---- syllabus (+ grading weights + term end) ----------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_syllabus_save(p_user uuid, p_course uuid, p_title text, p_body text, p_weights jsonb, p_ends_at timestamptz, p_hold_hours int, p_announce boolean, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'syllabus'); old public.ma_ai_syllabus%rowtype; c public.ma_course%rowtype; k text; sumw numeric := 0; aid bigint; ann jsonb;
  keys text[] := array['reading','quizzes','arenas','assignments','midterm','final','attendance','capstone'];
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if coalesce(length(trim(p_title)), 0) < 3 or length(p_title) > 160 or coalesce(length(p_body), 0) < 50 or length(p_body) > 12000 then return jsonb_build_object('ok', false, 'reason', 'bad_text'); end if;
  select * into c from public.ma_course where id = p_course;
  if p_weights is not null then
    if jsonb_typeof(p_weights) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'bad_weights'); end if;
    foreach k in array keys loop
      if p_weights ? k then
        if (p_weights ->> k)::numeric < 0 or (p_weights ->> k)::numeric > 1 then return jsonb_build_object('ok', false, 'reason', 'bad_weights'); end if;
        sumw := sumw + (p_weights ->> k)::numeric;
      end if;
    end loop;
    if abs(sumw - 1) > 0.011 then return jsonb_build_object('ok', false, 'reason', 'weights_must_sum_to_1', 'sum', sumw); end if;
  end if;
  if p_ends_at is not null and (p_hold_hours is null or p_hold_hours not between 1 and 168) then return jsonb_build_object('ok', false, 'reason', 'bad_hold'); end if;
  select * into old from public.ma_ai_syllabus where course_id = p_course;
  insert into public.ma_ai_syllabus (course_id, title, body, updated_at) values (p_course, trim(p_title), p_body, now())
    on conflict (course_id) do update set title = excluded.title, body = excluded.body, updated_at = now();
  if p_weights is not null then
    update public.ma_course set weight_reading = coalesce((p_weights ->> 'reading')::numeric, 0), weight_quizzes = coalesce((p_weights ->> 'quizzes')::numeric, 0), weight_arenas = coalesce((p_weights ->> 'arenas')::numeric, 0),
      weight_assignments = coalesce((p_weights ->> 'assignments')::numeric, 0), weight_midterm = coalesce((p_weights ->> 'midterm')::numeric, 0), weight_final = coalesce((p_weights ->> 'final')::numeric, 0),
      weight_attendance = coalesce((p_weights ->> 'attendance')::numeric, 0), weight_capstone = coalesce((p_weights ->> 'capstone')::numeric, 0) where id = p_course;
  end if;
  if p_ends_at is not null then
    insert into public.ma_ai_term (course_id, ends_at, hold_hours, auto_final) values (p_course, p_ends_at, p_hold_hours, true)
      on conflict (course_id) do update set ends_at = excluded.ends_at, hold_hours = excluded.hold_hours, final_queued_at = case when excluded.ends_at > now() then null else public.ma_ai_term.final_queued_at end;
  end if;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'syllabus_save', 'syllabus:' || p_course, jsonb_build_object('title', trim(p_title), 'ends_at', p_ends_at),
    jsonb_build_object('had', old.course_id is not null, 'title', old.title, 'body', old.body, 'weights', case when p_weights is null then null else jsonb_build_object('reading', c.weight_reading, 'quizzes', c.weight_quizzes, 'arenas', c.weight_arenas, 'assignments', c.weight_assignments, 'midterm', c.weight_midterm, 'final', c.weight_final, 'attendance', c.weight_attendance, 'capstone', c.weight_capstone) end),
    null, p_session);
  if coalesce(p_announce, true) then
    ann := public.ma_ai_prof_announce(p_user, p_course, 'Syllabus: ' || trim(p_title), left(p_body, 3900), p_session, p_trigger);
  end if;
  return jsonb_build_object('ok', true, 'action_id', aid, 'announced', coalesce((ann ->> 'ok')::boolean, false), 'announce_reason', ann ->> 'reason');
end $$;

create or replace function public.ma_ai_prof_syllabus_get(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not (public.ma_ai_prof_read_ok(p_user, p_course, 'edit_exams') or exists (select 1 from public.ma_enrollment e where e.course_id = p_course and e.user_id = p_user::text and e.status::text = 'active')) then jsonb_build_object('found', false)
    else coalesce((select jsonb_build_object('found', true, 'title', s.title, 'body', left(s.body, 5000), 'ends_at', (select ends_at from public.ma_ai_term t where t.course_id = p_course)) from public.ma_ai_syllabus s where s.course_id = p_course), jsonb_build_object('found', false)) end;
$$;

-- ---- planned lectures: explicit sessions, each with its own outline -------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_lectures_plan(p_user uuid, p_course uuid, p_sessions jsonb, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'lectures'); s jsonb; i int := 0; prev jsonb; aid bigint; n int;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if jsonb_typeof(p_sessions) <> 'array' or jsonb_array_length(p_sessions) not between 1 and 60 or length(p_sessions::text) > 60000 then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  for s in select * from jsonb_array_elements(p_sessions) loop
    if coalesce(length(trim(s ->> 'title')), 0) < 3 or length(s ->> 'title') > 160 or jsonb_typeof(s -> 'outline') <> 'array' or jsonb_array_length(s -> 'outline') not between 1 and 12
       or (s ->> 'starts_at') is null or coalesce((s ->> 'minutes')::int, 75) not between 10 and 240 or length((s -> 'outline')::text) > 4000 then return jsonb_build_object('ok', false, 'reason', 'bad_session', 'index', i + 1); end if;
    if (s ->> 'starts_at')::timestamptz < now() - interval '2 hours' then return jsonb_build_object('ok', false, 'reason', 'in_the_past', 'index', i + 1); end if;
    i := i + 1;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('seq', x.seq, 'title', x.title, 'outline', x.outline, 'starts_at', x.starts_at, 'duration_min', x.duration_min) order by x.starts_at), '[]'::jsonb) into prev
    from public.ma_ai_class_session x where x.course_id = p_course and x.status = 'planned';
  delete from public.ma_ai_class_session where course_id = p_course and status = 'planned';
  insert into public.ma_ai_class_session (course_id, seq, title, outline, starts_at, duration_min)
    select p_course, row_number() over (order by (e ->> 'starts_at')::timestamptz), trim(e ->> 'title'),
           (select jsonb_agg(jsonb_build_object('title', o)) from jsonb_array_elements_text(e -> 'outline') o), (e ->> 'starts_at')::timestamptz, coalesce((e ->> 'minutes')::int, 75)
      from jsonb_array_elements(p_sessions) e;
  get diagnostics n = row_count;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'lectures_plan', 'lectures:' || p_course, jsonb_build_object('count', n), jsonb_build_object('sessions', prev), jsonb_build_object('count', n), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'planned', n);
end $$;

create or replace function public.ma_ai_prof_lectures_get(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.ma_ai_prof_read_ok(p_user, p_course, 'edit_exams') then jsonb_build_object('allowed', false)
    else jsonb_build_object('allowed', true, 'sessions', coalesce((select jsonb_agg(jsonb_build_object('seq', s.seq, 'title', s.title, 'starts_at', s.starts_at, 'minutes', s.duration_min, 'status', s.status) order by s.starts_at) from public.ma_ai_class_session s where s.course_id = p_course), '[]'::jsonb)) end;
$$;

-- ---- exams from the question bank (chapters from..to, n questions per concept tag, random per student) --------------------------------------------
create or replace function public.ma_ai_prof_exam_create(p_user uuid, p_course uuid, p_kind text, p_title text, p_from int, p_to int, p_per_tag int, p_opens timestamptz, p_closes timestamptz, p_minutes int, p_weight numeric, p_proctored boolean, p_publish boolean, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'exam_create'); recipe jsonb; total numeric; eid uuid; aid bigint; nq int;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if p_kind not in ('midterm', 'final', 'exam') or coalesce(length(trim(p_title)), 0) < 3 or length(p_title) > 120 or p_from is null or p_to is null or p_from > p_to or p_from < 1 or p_to > 40
     or p_per_tag not between 1 and 4 or p_minutes not between 15 and 240 or p_weight is null or p_weight < 0 or p_weight > 1 or p_opens is null or p_closes is null or p_closes <= p_opens
     or p_closes - p_opens > interval '14 days' or p_closes < now() then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  if exists (select 1 from public.ma_exam where course_id = p_course and lower(title) = lower(trim(p_title))) then return jsonb_build_object('ok', false, 'reason', 'title_exists'); end if;
  select jsonb_agg(jsonb_build_object('n', least(p_per_tag, t.cnt), 'pts', t.pts, 'tag', t.tag) order by t.chapter, t.tag), sum(least(p_per_tag, t.cnt) * t.pts), sum(least(p_per_tag, t.cnt))
    into recipe, total, nq
    from (select chapter, concept_tag tag, count(*) cnt, round(avg(points))::numeric pts from public.ma_bank_items where is_active and chapter between p_from and p_to and concept_tag is not null group by chapter, concept_tag) t;
  if recipe is null or nq < 10 then return jsonb_build_object('ok', false, 'reason', 'not_enough_questions', 'found', coalesce(nq, 0)); end if;
  insert into public.ma_exam (course_id, kind, title, description, instructions, item_ids, total_points, weight, time_limit_minutes, max_attempts, attempt_scoring, shuffle_questions, is_published, opens_at, closes_at, proctored, camera_mode, random_per_student, random_recipe, created_by, is_manual)
    values (p_course, p_kind::public.ma_exam_kind, trim(p_title), 'Chapters ' || p_from || '-' || p_to, 'Camera must stay on for the whole exam. One attempt. Questions differ by student.', '{}', total, p_weight, p_minutes, 1, 'highest', true, coalesce(p_publish, true), p_opens, p_closes,
            coalesce(p_proctored, true), 'block', true, recipe, 'asha:' || p_user::text, false) returning id into eid;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'exam_create', 'exam:' || eid, jsonb_build_object('title', trim(p_title), 'chapters', p_from || '-' || p_to, 'questions', nq, 'points', total), null, jsonb_build_object('id', eid), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'exam_id', eid, 'questions', nq, 'points', total);
end $$;

-- ---- final grades: same components as the console's student view, over the work the course has (all of it is due at term end) -------------------
create or replace function public.ma_ai_final_calc(p_course uuid, p_student text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.ma_course%rowtype; nch int; nar int; reading numeric := 0; quizzes numeric := 0; arenas numeric := 0; assigns numeric := 0; comps jsonb := '[]'::jsonb; wsum numeric := 0; tot numeric := 0; e record; sc numeric; poss numeric; got numeric; w numeric; ntasg int;
begin
  select * into c from public.ma_course where id = p_course;
  select count(*) into nch from public.ma_quiz_deadline where course_id = p_course;
  select count(*) into nar from public.ma_arena_deadline where course_id = p_course;
  if nch > 0 then
    select coalesce(count(*) filter (where reading_done), 0)::numeric / nch, coalesce(sum(least(1, greatest(0, coalesce(quiz_score, 0)))), 0) / nch into reading, quizzes
      from public.ma_chapter_progress where course_id = p_course and student_id = p_student and chapter in (select chapter from public.ma_quiz_deadline where course_id = p_course);
  end if;
  if nar > 0 then
    select coalesce(sum(best), 0) / nar into arenas from (select max(case when r.pct > 1 then r.pct / 100 else r.pct end) best from public.ma_arena_attempt_rollup r
      where r.course_id = p_course and r.user_id = p_student and r.arena_slug in (select arena_slug from public.ma_arena_deadline where course_id = p_course) group by r.arena_slug) q;
  end if;
  select count(*) into ntasg from public.ma_assignment where course_id = p_course and is_published;
  if ntasg > 0 then
    select coalesce(sum(least(1, greatest(0, s.score / nullif(a.points, 0)))), 0) / ntasg into assigns
      from public.ma_assignment a left join public.ma_submission s on s.assignment_id = a.id and s.student_id = p_student where a.course_id = p_course and a.is_published;
  end if;
  comps := comps || jsonb_build_array(jsonb_build_object('name', 'Reading', 'score', reading, 'w', coalesce(c.weight_reading, 0)), jsonb_build_object('name', 'Quizzes', 'score', quizzes, 'w', coalesce(c.weight_quizzes, 0)),
    jsonb_build_object('name', 'Arenas', 'score', arenas, 'w', coalesce(c.weight_arenas, 0)), jsonb_build_object('name', 'Assignments', 'score', assigns, 'w', coalesce(c.weight_assignments, 0)));
  for e in select * from public.ma_exam where course_id = p_course and is_published and kind::text in ('midterm', 'final', 'exam') order by (kind::text = 'final'), closes_at loop
    w := coalesce(e.weight, case when e.kind::text = 'final' then c.weight_final else c.weight_midterm end, 0);
    select coalesce(sum(best), 0), coalesce(sum(pt), 0) into got, poss from (select max(coalesce(a.points_earned, 0)) best, coalesce(max(a.points_possible), 0) pt
      from public.ma_exam_attempt a where a.exam_id = e.id and a.student_id = p_student and a.graded_at is not null group by a.item_id) z;
    sc := case when poss > 0 then least(1, got / poss) else 0 end;
    comps := comps || jsonb_build_array(jsonb_build_object('name', e.title, 'score', sc, 'w', w));
  end loop;
  select coalesce(sum((x ->> 'w')::numeric), 0), coalesce(sum((x ->> 'score')::numeric * (x ->> 'w')::numeric), 0) into wsum, tot from jsonb_array_elements(comps) x where (x ->> 'w')::numeric > 0;
  return jsonb_build_object('pct', case when wsum > 0 then round(tot / wsum * 100, 2) else 0 end, 'comps', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(comps) x where (x ->> 'w')::numeric > 0));
end $$;

create or replace function public.ma_ai_prof_final_preview(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.ma_ai_prof_read_ok(p_user, p_course, 'grade') then jsonb_build_object('allowed', false)
    else jsonb_build_object('allowed', true, 'students', coalesce((select jsonb_agg(jsonb_build_object('student_id', e.user_id, 'name', coalesce(nullif(p.full_name, ''), nullif(p.display_name, ''), 'student'), 'calc', public.ma_ai_final_calc(p_course, e.user_id)) order by p.full_name)
      from public.ma_enrollment e left join public.ma_person p on p.user_id = e.user_id where e.course_id = p_course and e.status::text = 'active'), '[]'::jsonb)) end;
$$;

create or replace function public.ma_ai_prof_final_grades_run(p_user uuid, p_course uuid, p_hold_hours int, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'grade', 'final_grades'); r record; calc jsonb; ids bigint[] := '{}'; pid bigint; at timestamptz; aid bigint; n int := 0;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if p_hold_hours is null or p_hold_hours not between 1 and 168 then return jsonb_build_object('ok', false, 'reason', 'bad_hold'); end if;
  if exists (select 1 from public.ma_exam x where x.course_id = p_course and x.is_published and x.closes_at > now()) then return jsonb_build_object('ok', false, 'reason', 'exam_still_open'); end if;
  at := now() + make_interval(hours => p_hold_hours);
  for r in select e.user_id from public.ma_enrollment e where e.course_id = p_course and e.status::text = 'active' loop
    calc := public.ma_ai_final_calc(p_course, r.user_id);
    update public.ma_ai_pending set status = 'cancelled', resolved_at = now() where course_id = p_course and action = 'grade_override' and status = 'pending' and params ->> 'student_id' = r.user_id;
    insert into public.ma_ai_pending (course_id, actor_user, action, params, apply_at) values (p_course, p_user, 'grade_override', jsonb_build_object('student_id', r.user_id, 'pct', calc ->> 'pct', 'note', 'Final grade computed by Asha from the syllabus weights'), at) returning id into pid;
    ids := ids || pid; n := n + 1;
  end loop;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'final_grades_queued', 'course:' || p_course, jsonb_build_object('students', n, 'hold_hours', p_hold_hours), null, jsonb_build_object('pending_ids', to_jsonb(ids), 'apply_at', at), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'students', n, 'applies_at', at);
end $$;

-- ---- undo for the new action types (everything else goes to the existing function) ----------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'ma_ai_prof_undo_base') then alter function public.ma_ai_prof_undo(uuid, uuid, bigint) rename to ma_ai_prof_undo_base; end if;
end $$;
create or replace function public.ma_ai_prof_undo(p_user uuid, p_course uuid, p_action bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.ma_ai_actions%rowtype; cap text; w jsonb; s jsonb; pids bigint[];
begin
  select * into a from public.ma_ai_actions where id = p_action and course_id = p_course;
  if not found or a.action not in ('syllabus_save', 'lectures_plan', 'exam_create', 'final_grades_queued') then return public.ma_ai_prof_undo_base(p_user, p_course, p_action); end if;
  cap := case when a.action = 'final_grades_queued' then 'grade' else 'edit_exams' end;
  if not public.ma_ai_prof_can(p_user, p_course, cap) then return jsonb_build_object('ok', false, 'reason', 'not_staff'); end if;
  if a.status <> 'done' then return jsonb_build_object('ok', false, 'reason', 'not_undoable'); end if;
  if a.action = 'syllabus_save' then
    if (a.before ->> 'had')::boolean then update public.ma_ai_syllabus set title = a.before ->> 'title', body = a.before ->> 'body', updated_at = now() where course_id = p_course; else delete from public.ma_ai_syllabus where course_id = p_course; end if;
    w := a.before -> 'weights';
    if w is not null and jsonb_typeof(w) = 'object' then
      update public.ma_course set weight_reading = (w ->> 'reading')::numeric, weight_quizzes = (w ->> 'quizzes')::numeric, weight_arenas = (w ->> 'arenas')::numeric, weight_assignments = (w ->> 'assignments')::numeric,
        weight_midterm = (w ->> 'midterm')::numeric, weight_final = (w ->> 'final')::numeric, weight_attendance = (w ->> 'attendance')::numeric, weight_capstone = (w ->> 'capstone')::numeric where id = p_course;
    end if;
  elsif a.action = 'lectures_plan' then
    delete from public.ma_ai_class_session where course_id = p_course and status = 'planned';
    insert into public.ma_ai_class_session (course_id, seq, title, outline, starts_at, duration_min)
      select p_course, (x ->> 'seq')::int, x ->> 'title', x -> 'outline', (x ->> 'starts_at')::timestamptz, (x ->> 'duration_min')::int from jsonb_array_elements(coalesce(a.before -> 'sessions', '[]'::jsonb)) x;
  elsif a.action = 'exam_create' then
    if exists (select 1 from public.ma_exam_attempt where exam_id = (a.after ->> 'id')::uuid) then return jsonb_build_object('ok', false, 'reason', 'not_undoable'); end if;
    delete from public.ma_exam where id = (a.after ->> 'id')::uuid and course_id = p_course;
  else
    select array(select (jsonb_array_elements_text(a.after -> 'pending_ids'))::bigint) into pids;
    update public.ma_ai_pending set status = 'cancelled', resolved_at = now() where id = any(pids) and status = 'pending';
  end if;
  update public.ma_ai_actions set status = 'undone', undone_at = now() where id = p_action;
  return jsonb_build_object('ok', true);
end $$;

-- ---- the engine tick (every minute): planned lectures start, run, end with a recap; the final grades queue themselves after the term -------------
create or replace function public.ma_ai_class_tick()
returns jsonb language plpgsql security definer set search_path = public as $$
declare sc record; c public.ma_ai_class%rowtype; owner uuid; loc timestamp; start_ts timestamptz; n int; want int; started int := 0; ended int := 0; stepped int := 0; fin int := 0; nxt record; res jsonb;
begin
  for c in select * from public.ma_ai_class where status = 'live' and scheduled and ends_at is not null and ends_at <= now() loop
    update public.ma_ai_class set status = 'ended', ended_at = now() where id = c.id;
    begin owner := c.started_by; perform public.ma_ai_prof_log(c.course_id, owner, 'schedule', 'class_end', 'class:' || c.id, '{}'::jsonb, jsonb_build_object('step', c.step), null, null); exception when others then null; end;
    update public.ma_ai_class_session set status = 'done' where class_id = c.id;
    begin
      select s.title, s.starts_at into nxt from public.ma_ai_class_session s where s.course_id = c.course_id and s.status = 'planned' and s.starts_at > now() order by s.starts_at limit 1;
      perform public.ma_ai_prof_announce(owner, c.course_id, 'Class recap: ' || left(c.title, 120),
        'Today we covered: ' || (select string_agg(x ->> 'title', '; ') from jsonb_array_elements(c.outline) x) || '.' || case when nxt.title is null then ' That was the last scheduled class.' else E'\nNext class: ' || nxt.title || ' on ' || to_char(nxt.starts_at at time zone 'UTC', 'Mon DD, HH24:MI') || ' UTC.' end || E'\nQuestions are welcome in the AI Instructor any time.', null, 'schedule');
    exception when others then null; end;
    ended := ended + 1;
  end loop;
  for c in select * from public.ma_ai_class where status = 'live' and scheduled and ends_at is not null loop
    n := jsonb_array_length(c.outline);
    want := least(n - 1, greatest(0, floor(extract(epoch from now() - c.started_at) / nullif(extract(epoch from c.ends_at - c.started_at), 0) * n)::int));
    if want <> c.step then update public.ma_ai_class set step = want where id = c.id; stepped := stepped + 1; end if;
  end loop;
  -- recurring weekly template
  for sc in select s.*, co.owner_id from public.ma_ai_class_schedule s join public.ma_course co on co.id = s.course_id
             join public.ma_ai_settings st on st.course_id = s.course_id and st.enabled and st.professor_mode and not st.prof_paused and coalesce((st.prof_actions ->> 'class')::boolean, false)
            where s.auto loop
    loc := now() at time zone sc.tz;
    if extract(dow from loc)::int = any (sc.days) and loc::time >= sc.start_local and loc::time < sc.start_local + make_interval(mins => sc.duration_min) then
      start_ts := (loc::date + sc.start_local) at time zone sc.tz;
      if exists (select 1 from public.ma_ai_class where course_id = sc.course_id and (status = 'live' or started_at >= start_ts - interval '1 minute')) then continue; end if;
      begin owner := sc.owner_id::uuid; exception when others then continue; end;
      insert into public.ma_ai_class (course_id, title, outline, started_by, scheduled, ends_at, duration_min)
        values (sc.course_id, sc.title, sc.outline, owner, true, start_ts + make_interval(mins => sc.duration_min), sc.duration_min) returning * into c;
      perform public.ma_ai_prof_log(sc.course_id, owner, 'schedule', 'class_start', 'class:' || c.id, jsonb_build_object('title', sc.title, 'scheduled', true), null, jsonb_build_object('id', c.id), null);
      started := started + 1;
    end if;
  end loop;
  -- planned individual lectures: start the one that is due, mark the ones that were missed
  update public.ma_ai_class_session set status = 'missed' where status = 'planned' and starts_at + make_interval(mins => duration_min) <= now();
  for sc in select s.*, co.owner_id from public.ma_ai_class_session s join public.ma_course co on co.id = s.course_id
             join public.ma_ai_settings st on st.course_id = s.course_id and st.enabled and st.professor_mode and not st.prof_paused and coalesce((st.prof_actions ->> 'class')::boolean, false)
            where s.status = 'planned' and s.starts_at <= now() order by s.starts_at loop
    if exists (select 1 from public.ma_ai_class where course_id = sc.course_id and status = 'live') then continue; end if;
    begin owner := sc.owner_id::uuid; exception when others then continue; end;
    insert into public.ma_ai_class (course_id, title, outline, started_by, scheduled, ends_at, duration_min)
      values (sc.course_id, sc.title, sc.outline, owner, true, sc.starts_at + make_interval(mins => sc.duration_min), sc.duration_min) returning * into c;
    update public.ma_ai_class_session set status = 'live', class_id = c.id where id = sc.id;
    perform public.ma_ai_prof_log(sc.course_id, owner, 'schedule', 'class_start', 'class:' || c.id, jsonb_build_object('title', sc.title, 'lecture', sc.seq), null, jsonb_build_object('id', c.id), null);
    started := started + 1;
  end loop;
  -- term over: queue the final grades once the exams are scored (they then wait out the hold, and the owner can veto)
  for sc in select t.*, co.owner_id from public.ma_ai_term t join public.ma_course co on co.id = t.course_id
             join public.ma_ai_settings st on st.course_id = t.course_id and st.enabled and st.professor_mode and not st.prof_paused
            where t.auto_final and t.final_queued_at is null and t.ends_at <= now() loop
    if exists (select 1 from public.ma_exam_attempt a join public.ma_exam x on x.id = a.exam_id where x.course_id = sc.course_id and a.graded_at is null and a.ai_score is not null) then continue; end if;
    begin owner := sc.owner_id::uuid; exception when others then continue; end;
    res := public.ma_ai_prof_final_grades_run(owner, sc.course_id, sc.hold_hours, null, 'schedule');
    if (res ->> 'ok')::boolean then update public.ma_ai_term set final_queued_at = now() where course_id = sc.course_id; fin := fin + 1; end if;
  end loop;
  return jsonb_build_object('started', started, 'ended', ended, 'stepped', stepped, 'finals_queued', fin);
end $$;

do $$ declare f text; begin
  foreach f in array array['ma_ai_prof_syllabus_save(uuid,uuid,text,text,jsonb,timestamptz,int,boolean,uuid,text)','ma_ai_prof_syllabus_get(uuid,uuid)','ma_ai_prof_lectures_plan(uuid,uuid,jsonb,uuid,text)','ma_ai_prof_lectures_get(uuid,uuid)',
    'ma_ai_prof_exam_create(uuid,uuid,text,text,int,int,int,timestamptz,timestamptz,int,numeric,boolean,boolean,uuid,text)','ma_ai_final_calc(uuid,text)','ma_ai_prof_final_preview(uuid,uuid)','ma_ai_prof_final_grades_run(uuid,uuid,int,uuid,text)','ma_ai_prof_undo(uuid,uuid,bigint)','ma_ai_prof_undo_base(uuid,uuid,bigint)','ma_ai_class_tick()','ma_ai_prof_gate(uuid,uuid,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
