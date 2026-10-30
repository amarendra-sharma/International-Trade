-- 112_ma_ai_professor.sql -- Macroeconomics AI Instructor: "professor mode" (Asha acts for the course staff).
-- Design: Asha never writes tables directly. Every professor action is one of the fixed SECURITY DEFINER functions below, callable by service_role only.
-- Each re-checks, inside the database: the caller is course staff with the right capability, professor mode is ON for the course, it is not paused,
-- the specific action is enabled, and the daily cap. Every action is written to ma_ai_actions with before/after so it can be undone.
-- Student sessions never get these tools (the server only exposes them to staff sessions) and the database refuses non-staff anyway.

alter table public.ma_ai_settings
  add column if not exists professor_mode boolean not null default false,
  add column if not exists prof_paused    boolean not null default false,
  add column if not exists prof_actions   jsonb   not null default '{"exam_window":true,"announce":true,"finalize":true}'::jsonb,
  add column if not exists prof_daily_cap integer not null default 200 check (prof_daily_cap between 0 and 5000);

create table if not exists public.ma_ai_actions (
  id         bigserial primary key,
  course_id  uuid not null,
  actor_user uuid not null,            -- the professor / TA whose request (or standing authority) triggered it
  trigger    text not null default 'professor' check (trigger in ('professor','schedule','class')),
  action     text not null,
  target     text,
  params     jsonb not null default '{}'::jsonb,
  before     jsonb,
  after      jsonb,
  status     text not null default 'done' check (status in ('done','undone','failed')),
  session_id uuid,
  created_at timestamptz not null default now(),
  undone_at  timestamptz
);
create index if not exists ma_ai_actions_course_idx on public.ma_ai_actions (course_id, created_at desc);
alter table public.ma_ai_actions enable row level security;
revoke all on public.ma_ai_actions from anon, authenticated;
grant select, insert, update on public.ma_ai_actions to service_role;
grant usage, select on sequence public.ma_ai_actions_id_seq to service_role;

-- capability check: owner / platform admin always; other staff by their ma_course_staff flag
create or replace function public.ma_ai_prof_can(p_user uuid, p_course uuid, p_cap text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ma_course c where c.id = p_course and c.owner_id = p_user::text)
      or exists (select 1 from public.ma_person p where p.user_id = p_user::text and p.role = 'admin')
      or exists (select 1 from public.ma_course_staff s where s.course_id = p_course and s.user_id = p_user::text
                 and case p_cap when 'edit_exams' then s.can_edit_exams when 'grade' then s.can_grade else false end);
$$;

-- the gate every professor function starts with: returns NULL when allowed, otherwise a reason
create or replace function public.ma_ai_prof_gate(p_user uuid, p_course uuid, p_cap text, p_action text)
returns text language plpgsql stable security definer set search_path = public as $$
declare s public.ma_ai_settings%rowtype; used int;
begin
  if not public.ma_ai_prof_can(p_user, p_course, p_cap) then return 'not_staff'; end if;
  select * into s from public.ma_ai_settings where course_id = p_course;
  if not found or not s.enabled then return 'ai_off'; end if;
  if not s.professor_mode then return 'prof_off'; end if;
  if s.prof_paused then return 'paused'; end if;
  if coalesce((s.prof_actions ->> p_action)::boolean, false) is not true then return 'action_off'; end if;
  select count(*) into used from public.ma_ai_actions where course_id = p_course and created_at > now() - interval '1 day' and status = 'done';
  if used >= s.prof_daily_cap then return 'daily_cap'; end if;
  return null;
end $$;

-- ---- read: a compact snapshot of the course (no student answers) ------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_overview(p_user uuid, p_course uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare g text; res jsonb;
begin
  if not public.ma_ai_prof_can(p_user, p_course, 'grade') and not public.ma_ai_prof_can(p_user, p_course, 'edit_exams') then return jsonb_build_object('allowed', false, 'reason', 'not_staff'); end if;
  g := (select case when not professor_mode then 'prof_off' when prof_paused then 'paused' end from public.ma_ai_settings where course_id = p_course);
  if g is not null then return jsonb_build_object('allowed', false, 'reason', g); end if;
  select jsonb_build_object('allowed', true,
    'course', (select jsonb_build_object('title', title, 'term', term) from public.ma_course where id = p_course),
    'students', (select count(*) from public.ma_enrollment where course_id = p_course and status = 'active'),
    'exams', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'kind', e.kind, 'published', e.is_published, 'opens_at', e.opens_at, 'closes_at', e.closes_at,
         'time_limit_minutes', e.time_limit_minutes, 'attempt_rows', (select count(*) from public.ma_exam_attempt a where a.exam_id = e.id),
         'students_attempted', (select count(distinct a.student_id) from public.ma_exam_attempt a where a.exam_id = e.id),
         'ungraded_written', (select count(*) from public.ma_exam_attempt a where a.exam_id = e.id and a.graded_at is null and a.submitted_value is not null and a.points_earned is null),
         'ai_proposals_waiting', (select count(*) from public.ma_exam_attempt a where a.exam_id = e.id and a.graded_at is null and a.ai_score is not null)) order by e.created_at desc)
       from public.ma_exam e where e.course_id = p_course), '[]'::jsonb),
    'assignments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'due_at', a.due_at, 'published', a.is_published,
         'submissions', (select count(*) from public.ma_submission s where s.assignment_id = a.id),
         'ungraded', (select count(*) from public.ma_submission s where s.assignment_id = a.id and s.graded_at is null)) order by a.created_at desc) from public.ma_assignment a where a.course_id = p_course), '[]'::jsonb),
    'recent_announcements', coalesce((select jsonb_agg(jsonb_build_object('title', x.title, 'at', x.created_at)) from (select title, created_at from public.ma_announcement where course_id = p_course order by created_at desc limit 5) x), '[]'::jsonb)
  ) into res;
  return res;
end $$;

-- ---- action: change when an exam/quiz is open ------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_set_exam_window(p_user uuid, p_course uuid, p_exam uuid, p_opens timestamptz, p_closes timestamptz, p_publish boolean, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'exam_window'); e public.ma_exam%rowtype; b jsonb; a jsonb; aid bigint;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  select * into e from public.ma_exam where id = p_exam and course_id = p_course;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_opens is not null and p_closes is not null and p_closes <= p_opens then return jsonb_build_object('ok', false, 'reason', 'bad_window'); end if;
  if p_closes is not null and p_closes < now() - interval '1 minute' and exists (select 1 from public.ma_exam_attempt where exam_id = p_exam) then
    return jsonb_build_object('ok', false, 'reason', 'would_close_in_past'); end if;   -- never retro-close an exam that students already took
  b := jsonb_build_object('opens_at', e.opens_at, 'closes_at', e.closes_at, 'is_published', e.is_published);
  update public.ma_exam set opens_at = coalesce(p_opens, opens_at), closes_at = coalesce(p_closes, closes_at), is_published = coalesce(p_publish, is_published) where id = p_exam;
  select jsonb_build_object('opens_at', opens_at, 'closes_at', closes_at, 'is_published', is_published) into a from public.ma_exam where id = p_exam;
  insert into public.ma_ai_actions (course_id, actor_user, trigger, action, target, params, before, after, session_id)
    values (p_course, p_user, p_trigger, 'exam_window', 'exam:' || p_exam, jsonb_build_object('title', e.title), b, a, p_session) returning id into aid;
  return jsonb_build_object('ok', true, 'action_id', aid, 'title', e.title, 'before', b, 'after', a);
end $$;

-- ---- action: post an announcement ------------------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_announce(p_user uuid, p_course uuid, p_title text, p_body text, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'announce'); nid uuid; aid bigint;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if coalesce(length(trim(p_title)), 0) < 3 or length(p_title) > 160 or length(coalesce(p_body, '')) > 4000 then return jsonb_build_object('ok', false, 'reason', 'bad_text'); end if;
  if (select count(*) from public.ma_ai_actions where course_id = p_course and action = 'announce' and status = 'done' and created_at > now() - interval '1 day') >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'announce_limit'); end if;
  insert into public.ma_announcement (course_id, title, body, created_by) values (p_course, trim(p_title), p_body, 'asha:' || p_user::text) returning id into nid;
  insert into public.ma_ai_actions (course_id, actor_user, trigger, action, target, params, after, session_id)
    values (p_course, p_user, p_trigger, 'announce', 'announcement:' || nid, jsonb_build_object('title', trim(p_title)), jsonb_build_object('id', nid), p_session) returning id into aid;
  return jsonb_build_object('ok', true, 'action_id', aid);
end $$;

-- ---- action: accept the AI's proposed scores on a class's ungraded written answers ---------------------------------------------------------------
-- Only rows that already carry an AI proposal (produced by the existing grader) and are not yet graded. Never overwrites a human grade.
create or replace function public.ma_ai_prof_finalize(p_user uuid, p_course uuid, p_exam uuid, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'grade', 'finalize'); ids uuid[]; n int; aid bigint; s public.ma_ai_settings%rowtype;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  select * into s from public.ma_ai_settings where course_id = p_course;
  select coalesce(array_agg(id), '{}') into ids from public.ma_exam_attempt
   where course_id = p_course and (p_exam is null or exam_id = p_exam) and graded_at is null and ai_score is not null and points_earned is null;
  n := coalesce(array_length(ids, 1), 0);
  if n = 0 then return jsonb_build_object('ok', true, 'graded', 0); end if;
  if n > s.prof_daily_cap then return jsonb_build_object('ok', false, 'reason', 'daily_cap'); end if;
  update public.ma_exam_attempt set points_earned = ai_score, graded_at = now(), graded_by = 'asha:' || p_user::text where id = any(ids);
  insert into public.ma_ai_actions (course_id, actor_user, trigger, action, target, params, before, after, session_id)
    values (p_course, p_user, p_trigger, 'finalize', coalesce('exam:' || p_exam, 'course'), jsonb_build_object('count', n), jsonb_build_object('attempt_ids', to_jsonb(ids)), jsonb_build_object('graded', n), p_session) returning id into aid;
  return jsonb_build_object('ok', true, 'action_id', aid, 'graded', n);
end $$;

-- ---- read: how a class did on one exam (aggregates only) -------------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_exam_results(p_user uuid, p_course uuid, p_exam uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not public.ma_ai_prof_can(p_user, p_course, 'grade') then return jsonb_build_object('allowed', false, 'reason', 'not_staff'); end if;
  if not coalesce((select professor_mode and not prof_paused from public.ma_ai_settings where course_id = p_course), false) then return jsonb_build_object('allowed', false, 'reason', 'prof_off'); end if;
  with per as (select student_id, sum(coalesce(points_earned, 0)) earned, sum(coalesce(points_possible, 0)) possible, bool_or(graded_at is null and submitted_value is not null and points_earned is null) pending
                 from public.ma_exam_attempt where exam_id = p_exam and course_id = p_course group by student_id)
  select jsonb_build_object('allowed', true, 'students', count(*), 'mean_pct', round(avg(case when possible > 0 then 100 * earned / possible end)::numeric, 1),
      'min_pct', round(min(case when possible > 0 then 100 * earned / possible end)::numeric, 1), 'max_pct', round(max(case when possible > 0 then 100 * earned / possible end)::numeric, 1),
      'students_with_ungraded_answers', count(*) filter (where pending)) into res from per;
  return res;
end $$;

-- ---- undo ------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_undo(p_user uuid, p_course uuid, p_action bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.ma_ai_actions%rowtype; cap text; ids uuid[];
begin
  select * into a from public.ma_ai_actions where id = p_action and course_id = p_course;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  cap := case a.action when 'finalize' then 'grade' else 'edit_exams' end;
  if not public.ma_ai_prof_can(p_user, p_course, cap) then return jsonb_build_object('ok', false, 'reason', 'not_staff'); end if;
  if a.status <> 'done' then return jsonb_build_object('ok', false, 'reason', 'not_undoable'); end if;
  if a.action = 'exam_window' then
    update public.ma_exam set opens_at = (a.before ->> 'opens_at')::timestamptz, closes_at = (a.before ->> 'closes_at')::timestamptz, is_published = (a.before ->> 'is_published')::boolean
     where id = split_part(a.target, ':', 2)::uuid and course_id = p_course;
  elsif a.action = 'announce' then
    delete from public.ma_announcement where id = (a.after ->> 'id')::uuid and course_id = p_course;
  elsif a.action = 'finalize' then
    select array(select (jsonb_array_elements_text(a.before -> 'attempt_ids'))::uuid) into ids;
    update public.ma_exam_attempt set points_earned = null, graded_at = null, graded_by = null where id = any(ids) and graded_by = 'asha:' || a.actor_user::text;
  else return jsonb_build_object('ok', false, 'reason', 'not_undoable');
  end if;
  update public.ma_ai_actions set status = 'undone', undone_at = now() where id = p_action;
  return jsonb_build_object('ok', true);
end $$;

-- ---- recent actions (for "what did you do?" and the professor's audit view) ---------------------------------------------------------------------
create or replace function public.ma_ai_prof_recent(p_user uuid, p_course uuid, p_limit int default 20)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not (public.ma_ai_prof_can(p_user, p_course, 'grade') or public.ma_ai_prof_can(p_user, p_course, 'edit_exams')) then jsonb_build_object('allowed', false)
    else jsonb_build_object('allowed', true, 'actions', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'action', action, 'target', target, 'status', status, 'at', created_at, 'trigger', trigger, 'params', params) order by id desc)
      from (select * from public.ma_ai_actions where course_id = p_course order by id desc limit least(greatest(p_limit, 1), 50)) z), '[]'::jsonb)) end;
$$;

do $$
declare f text;
begin
  foreach f in array array['ma_ai_prof_can(uuid,uuid,text)','ma_ai_prof_gate(uuid,uuid,text,text)','ma_ai_prof_overview(uuid,uuid)',
    'ma_ai_prof_set_exam_window(uuid,uuid,uuid,timestamptz,timestamptz,boolean,uuid,text)','ma_ai_prof_announce(uuid,uuid,text,text,uuid,text)',
    'ma_ai_prof_finalize(uuid,uuid,uuid,uuid,text)','ma_ai_prof_exam_results(uuid,uuid,uuid)','ma_ai_prof_undo(uuid,uuid,bigint)','ma_ai_prof_recent(uuid,uuid,int)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
