-- 113_ma_ai_professor2.sql -- Asha as professor, phase 2: assignments + feedback, quiz/arena deadlines, 1-hour hold on grade changes,
-- office hours (question queue), live class state, standing instructions ("autopilot") and a tick. Same rules as 112: fixed SECURITY DEFINER
-- functions, service_role only, each re-checks staff capability, professor mode, pause, per-action toggle and the daily cap; every action is logged and undoable.

update public.ma_ai_settings set prof_actions = '{"exam_window":true,"announce":true,"finalize":true,"assignment":true,"feedback":true,"deadline":true,"grade_final":true,"office_hours":true,"class":true,"standing":true}'::jsonb || prof_actions;
alter table public.ma_ai_settings alter column prof_actions set default '{"exam_window":true,"announce":true,"finalize":true,"assignment":true,"feedback":true,"deadline":true,"grade_final":true,"office_hours":true,"class":true,"standing":true}'::jsonb;

-- delayed changes (final-grade overrides wait one hour so the professor can cancel)
create table if not exists public.ma_ai_pending (
  id bigserial primary key, course_id uuid not null, actor_user uuid not null, action text not null, params jsonb not null default '{}'::jsonb,
  apply_at timestamptz not null, status text not null default 'pending' check (status in ('pending','applied','cancelled','failed')),
  queued_action bigint, created_at timestamptz not null default now(), resolved_at timestamptz);
create table if not exists public.ma_ai_question (
  id uuid primary key default gen_random_uuid(), course_id uuid not null, student_id text not null, question text not null check (length(question) between 3 and 1500),
  answer text, status text not null default 'open' check (status in ('open','answered')), class_id uuid, created_at timestamptz not null default now(), answered_at timestamptz, answered_by text);
create index if not exists ma_ai_question_idx on public.ma_ai_question (course_id, status, created_at desc);
create table if not exists public.ma_ai_class (
  id uuid primary key default gen_random_uuid(), course_id uuid not null, title text not null, outline jsonb not null default '[]'::jsonb, step integer not null default 0,
  status text not null default 'live' check (status in ('live','ended')), started_by uuid not null, started_at timestamptz not null default now(), ended_at timestamptz);
create unique index if not exists ma_ai_class_one_live on public.ma_ai_class (course_id) where status = 'live';
create table if not exists public.ma_ai_standing (
  id bigserial primary key, course_id uuid not null, actor_user uuid not null, kind text not null check (kind in ('finalize_after_close','remind_before_close')),
  target uuid not null, params jsonb not null default '{}'::jsonb, enabled boolean not null default true, last_run timestamptz, created_at timestamptz not null default now());
do $$ declare t text; begin
  foreach t in array array['ma_ai_pending','ma_ai_question','ma_ai_class','ma_ai_standing'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
  grant usage, select on sequence public.ma_ai_pending_id_seq, public.ma_ai_standing_id_seq to service_role;
end $$;

create or replace function public.ma_ai_prof_log(p_course uuid, p_user uuid, p_trigger text, p_action text, p_target text, p_params jsonb, p_before jsonb, p_after jsonb, p_session uuid)
returns bigint language sql security definer set search_path = public as $$
  insert into public.ma_ai_actions (course_id, actor_user, trigger, action, target, params, before, after, session_id)
  values (p_course, p_user, p_trigger, p_action, p_target, coalesce(p_params, '{}'::jsonb), p_before, p_after, p_session) returning id;
$$;

-- read gate: staff + professor mode on and not paused (no per-action toggle, no cap)
create or replace function public.ma_ai_prof_read_ok(p_user uuid, p_course uuid, p_cap text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.ma_ai_prof_can(p_user, p_course, p_cap) and coalesce((select enabled and professor_mode and not prof_paused from public.ma_ai_settings where course_id = p_course), false);
$$;
-- student gate: active student of the course, professor mode on, office hours action on
create or replace function public.ma_ai_student_ok(p_user uuid, p_course uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ma_enrollment e where e.course_id = p_course and e.user_id = p_user::text and e.status::text = 'active')
     and coalesce((select enabled and professor_mode and not prof_paused and coalesce((prof_actions ->> 'office_hours')::boolean, false) from public.ma_ai_settings where course_id = p_course), false);
$$;

-- ---- assignments: create / change ------------------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_assignment_save(p_user uuid, p_course uuid, p_assignment uuid, p_title text, p_instructions text, p_points numeric, p_due timestamptz, p_publish boolean, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'assignment'); a public.ma_assignment%rowtype; b jsonb; n jsonb; aid bigint; nid uuid;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if p_points is not null and (p_points <= 0 or p_points > 1000) then return jsonb_build_object('ok', false, 'reason', 'bad_points'); end if;
  if p_assignment is null then
    if coalesce(length(trim(p_title)), 0) < 3 or length(p_title) > 160 or length(coalesce(p_instructions, '')) > 8000 then return jsonb_build_object('ok', false, 'reason', 'bad_text'); end if;
    insert into public.ma_assignment (course_id, title, instructions, points, due_at, is_published, created_by)
      values (p_course, trim(p_title), p_instructions, coalesce(p_points, 100), p_due, coalesce(p_publish, false), 'asha:' || p_user::text) returning id into nid;
    aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'assignment_create', 'assignment:' || nid, jsonb_build_object('title', trim(p_title)), null, jsonb_build_object('id', nid, 'published', coalesce(p_publish, false), 'due_at', p_due), p_session);
    return jsonb_build_object('ok', true, 'action_id', aid, 'assignment_id', nid, 'created', true);
  end if;
  select * into a from public.ma_assignment where id = p_assignment and course_id = p_course;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  b := jsonb_build_object('title', a.title, 'instructions', a.instructions, 'points', a.points, 'due_at', a.due_at, 'is_published', a.is_published);
  update public.ma_assignment set title = coalesce(nullif(trim(p_title), ''), title), instructions = coalesce(p_instructions, instructions), points = coalesce(p_points, points), due_at = coalesce(p_due, due_at), is_published = coalesce(p_publish, is_published) where id = p_assignment;
  select jsonb_build_object('title', title, 'instructions', instructions, 'points', points, 'due_at', due_at, 'is_published', is_published) into n from public.ma_assignment where id = p_assignment;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'assignment_update', 'assignment:' || p_assignment, jsonb_build_object('title', a.title), b, n, p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'assignment_id', p_assignment, 'before', b, 'after', n);
end $$;

-- ---- quiz / arena closing dates -------------------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_deadline(p_user uuid, p_course uuid, p_kind text, p_key text, p_closes timestamptz, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'deadline'); old timestamptz; aid bigint; ch int;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if p_kind not in ('quiz', 'arena') or p_closes is null then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  if p_kind = 'quiz' then
    ch := p_key::int;
    if ch < 1 or ch > 60 then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
    select closes_at into old from public.ma_quiz_deadline where course_id = p_course and chapter = ch;
    insert into public.ma_quiz_deadline (course_id, chapter, closes_at, updated_at) values (p_course, ch, p_closes, now())
      on conflict (course_id, chapter) do update set closes_at = excluded.closes_at, updated_at = now();
  else
    if p_key !~ '^[a-z0-9_-]{2,60}$' then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
    select closes_at into old from public.ma_arena_deadline where course_id = p_course and arena_slug = p_key;
    insert into public.ma_arena_deadline (course_id, arena_slug, closes_at, updated_at) values (p_course, p_key, p_closes, now())
      on conflict (course_id, arena_slug) do update set closes_at = excluded.closes_at, updated_at = now();
  end if;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'deadline', p_kind || ':' || p_key, jsonb_build_object('kind', p_kind, 'key', p_key), jsonb_build_object('closes_at', old), jsonb_build_object('closes_at', p_closes), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'before', old, 'after', p_closes);
end $$;

-- ---- assignment feedback: read submissions, propose score + feedback, finalize ---------------------------------------------------------------
create or replace function public.ma_ai_prof_submissions(p_user uuid, p_course uuid, p_assignment uuid, p_limit int default 10)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a public.ma_assignment%rowtype;
begin
  if not public.ma_ai_prof_read_ok(p_user, p_course, 'grade') then return jsonb_build_object('allowed', false, 'reason', 'not_allowed'); end if;
  select * into a from public.ma_assignment where id = p_assignment and course_id = p_course;
  if not found then return jsonb_build_object('allowed', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('allowed', true, 'title', a.title, 'instructions', a.instructions, 'points', a.points,
    'submissions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'text', left(coalesce(s.text_response, ''), 4000), 'link', s.link_url, 'has_file', s.file_path is not null,
        'proposed_score', s.ai_score, 'proposed_feedback', s.ai_feedback) order by s.submitted_at)
      from (select * from public.ma_submission where assignment_id = p_assignment and course_id = p_course and graded_at is null order by submitted_at limit least(greatest(p_limit, 1), 25)) s), '[]'::jsonb),
    'ungraded_total', (select count(*) from public.ma_submission where assignment_id = p_assignment and course_id = p_course and graded_at is null));
end $$;

create or replace function public.ma_ai_prof_propose_feedback(p_user uuid, p_course uuid, p_submission uuid, p_score numeric, p_feedback text, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'grade', 'feedback'); s public.ma_submission%rowtype; pts numeric; aid bigint;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  select * into s from public.ma_submission where id = p_submission and course_id = p_course;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if s.graded_at is not null then return jsonb_build_object('ok', false, 'reason', 'already_graded'); end if;
  select points into pts from public.ma_assignment where id = s.assignment_id;
  if p_score is null or p_score < 0 or p_score > pts then return jsonb_build_object('ok', false, 'reason', 'bad_score', 'max', pts); end if;
  if coalesce(length(trim(p_feedback)), 0) < 5 or length(p_feedback) > 3000 then return jsonb_build_object('ok', false, 'reason', 'bad_text'); end if;
  update public.ma_submission set ai_score = p_score, ai_feedback = trim(p_feedback), ai_graded_at = now() where id = p_submission;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'feedback_propose', 'submission:' || p_submission, jsonb_build_object('assignment', s.assignment_id),
    jsonb_build_object('ai_score', s.ai_score, 'ai_feedback', s.ai_feedback, 'ai_graded_at', s.ai_graded_at), jsonb_build_object('ai_score', p_score), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid);
end $$;

create or replace function public.ma_ai_prof_finalize_assignment(p_user uuid, p_course uuid, p_assignment uuid, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'grade', 'feedback'); ids uuid[]; n int; aid bigint; cap int;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if not exists (select 1 from public.ma_assignment where id = p_assignment and course_id = p_course) then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select coalesce(array_agg(id), '{}') into ids from public.ma_submission where assignment_id = p_assignment and course_id = p_course and graded_at is null and ai_score is not null;
  n := coalesce(array_length(ids, 1), 0);
  select prof_daily_cap into cap from public.ma_ai_settings where course_id = p_course;
  if n = 0 then return jsonb_build_object('ok', true, 'graded', 0); end if;
  if n > cap then return jsonb_build_object('ok', false, 'reason', 'daily_cap'); end if;
  update public.ma_submission set score = ai_score, feedback = ai_feedback, graded_at = now(), graded_by = 'asha:' || p_user::text where id = any(ids);
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'feedback_finalize', 'assignment:' || p_assignment, jsonb_build_object('count', n), jsonb_build_object('submission_ids', to_jsonb(ids)), jsonb_build_object('graded', n), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'graded', n);
end $$;

-- ---- final-grade adjustment: held for one hour, then applied by the tick (cancel = undo) ---------------------------------------------------------
create or replace function public.ma_ai_prof_grade_override(p_user uuid, p_course uuid, p_student text, p_pct numeric, p_note text, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'grade', 'grade_final'); pid bigint; aid bigint; at timestamptz := now() + interval '1 hour';
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if p_pct is null or p_pct < 0 or p_pct > 100 or coalesce(length(p_note), 0) > 500 then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  if not exists (select 1 from public.ma_enrollment where course_id = p_course and student_id = p_student) then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  insert into public.ma_ai_pending (course_id, actor_user, action, params, apply_at) values (p_course, p_user, 'grade_override', jsonb_build_object('student_id', p_student, 'pct', p_pct, 'note', p_note), at) returning id into pid;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'grade_override_queued', 'student:' || p_student, jsonb_build_object('pct', p_pct), null, jsonb_build_object('pending_id', pid, 'apply_at', at), p_session);
  update public.ma_ai_pending set queued_action = aid where id = pid;
  return jsonb_build_object('ok', true, 'action_id', aid, 'applies_at', at, 'held_for', '1 hour');
end $$;

create or replace function public.ma_ai_prof_apply_due()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.ma_ai_pending%rowtype; ok int := 0; bad int := 0; old numeric; aid bigint;
begin
  for r in select * from public.ma_ai_pending where status = 'pending' and apply_at <= now() order by id for update skip locked loop
    if public.ma_ai_prof_gate(r.actor_user, r.course_id, 'grade', 'grade_final') is not null then
      update public.ma_ai_pending set status = 'failed', resolved_at = now() where id = r.id; bad := bad + 1; continue;
    end if;
    select override_pct into old from public.ma_grade_override where course_id = r.course_id and student_id = r.params ->> 'student_id';
    insert into public.ma_grade_override (course_id, student_id, override_pct, note, set_by, updated_at)
      values (r.course_id, r.params ->> 'student_id', (r.params ->> 'pct')::numeric, r.params ->> 'note', 'asha:' || r.actor_user::text, now())
      on conflict (course_id, student_id) do update set override_pct = excluded.override_pct, note = excluded.note, set_by = excluded.set_by, updated_at = now();
    aid := public.ma_ai_prof_log(r.course_id, r.actor_user, 'schedule', 'grade_override', 'student:' || (r.params ->> 'student_id'), jsonb_build_object('pct', r.params -> 'pct'),
      jsonb_build_object('override_pct', old), jsonb_build_object('override_pct', r.params -> 'pct', 'pending_id', r.id), null);
    update public.ma_ai_pending set status = 'applied', resolved_at = now() where id = r.id; ok := ok + 1;
  end loop;
  return jsonb_build_object('applied', ok, 'failed', bad);
end $$;

-- ---- office hours: students leave questions for the professor, the professor (or Asha for them) answers ------------------------------------------
create or replace function public.ma_ai_prof_student_ask(p_user uuid, p_course uuid, p_question text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cid uuid; qid uuid;
begin
  if not public.ma_ai_student_ok(p_user, p_course) then return jsonb_build_object('ok', false, 'reason', 'not_available'); end if;
  if coalesce(length(trim(p_question)), 0) < 3 or length(p_question) > 1500 then return jsonb_build_object('ok', false, 'reason', 'bad_text'); end if;
  if (select count(*) from public.ma_ai_question where course_id = p_course and student_id = p_user::text and status = 'open') >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_open'); end if;
  select id into cid from public.ma_ai_class where course_id = p_course and status = 'live';
  insert into public.ma_ai_question (course_id, student_id, question, class_id) values (p_course, p_user::text, trim(p_question), cid) returning id into qid;
  return jsonb_build_object('ok', true, 'question_id', qid, 'during_class', cid is not null);
end $$;
create or replace function public.ma_ai_prof_student_questions(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.ma_ai_student_ok(p_user, p_course) then jsonb_build_object('allowed', false)
    else jsonb_build_object('allowed', true, 'questions', coalesce((select jsonb_agg(jsonb_build_object('question', q.question, 'status', q.status, 'answer', q.answer, 'asked_at', q.created_at) order by q.created_at desc)
      from (select * from public.ma_ai_question where course_id = p_course and student_id = p_user::text order by created_at desc limit 10) q), '[]'::jsonb)) end;
$$;
create or replace function public.ma_ai_prof_questions(p_user uuid, p_course uuid, p_status text default 'open')
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.ma_ai_prof_read_ok(p_user, p_course, 'grade') then jsonb_build_object('allowed', false)
    else jsonb_build_object('allowed', true, 'questions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'question', q.question, 'status', q.status, 'answer', q.answer, 'during_class', q.class_id is not null, 'asked_at', q.created_at) order by q.created_at)
      from (select * from public.ma_ai_question where course_id = p_course and status = coalesce(p_status, 'open') order by created_at limit 25) q), '[]'::jsonb)) end;
$$;
create or replace function public.ma_ai_prof_answer_question(p_user uuid, p_course uuid, p_question uuid, p_answer text, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'grade', 'office_hours'); q public.ma_ai_question%rowtype; aid bigint;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  select * into q from public.ma_ai_question where id = p_question and course_id = p_course;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if coalesce(length(trim(p_answer)), 0) < 2 or length(p_answer) > 4000 then return jsonb_build_object('ok', false, 'reason', 'bad_text'); end if;
  update public.ma_ai_question set answer = trim(p_answer), status = 'answered', answered_at = now(), answered_by = 'asha:' || p_user::text where id = p_question;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'answer_question', 'question:' || p_question, '{}'::jsonb, jsonb_build_object('answer', q.answer, 'status', q.status), jsonb_build_object('status', 'answered'), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid);
end $$;

-- ---- live class: shared state every student's Asha follows ---------------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_class_start(p_user uuid, p_course uuid, p_title text, p_outline jsonb, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'class'); cid uuid; aid bigint;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if coalesce(length(trim(p_title)), 0) < 3 or length(p_title) > 160 or jsonb_typeof(p_outline) <> 'array' or jsonb_array_length(p_outline) not between 1 and 20 or length(p_outline::text) > 8000 then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  if exists (select 1 from public.ma_ai_class where course_id = p_course and status = 'live') then return jsonb_build_object('ok', false, 'reason', 'already_live'); end if;
  insert into public.ma_ai_class (course_id, title, outline, started_by) values (p_course, trim(p_title), p_outline, p_user) returning id into cid;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'class_start', 'class:' || cid, jsonb_build_object('title', trim(p_title)), null, jsonb_build_object('id', cid), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'class_id', cid);
end $$;
create or replace function public.ma_ai_prof_class_step(p_user uuid, p_course uuid, p_step integer, p_end boolean default false, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'class'); c public.ma_ai_class%rowtype; aid bigint;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  select * into c from public.ma_ai_class where course_id = p_course and status = 'live';
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_live_class'); end if;
  if p_end then
    update public.ma_ai_class set status = 'ended', ended_at = now() where id = c.id;
    aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'class_end', 'class:' || c.id, '{}'::jsonb, jsonb_build_object('step', c.step), null, p_session);
    return jsonb_build_object('ok', true, 'action_id', aid, 'ended', true);
  end if;
  if p_step is null or p_step < 0 or p_step >= jsonb_array_length(c.outline) then return jsonb_build_object('ok', false, 'reason', 'bad_step', 'sections', jsonb_array_length(c.outline)); end if;
  update public.ma_ai_class set step = p_step where id = c.id;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'class_step', 'class:' || c.id, '{}'::jsonb, jsonb_build_object('step', c.step), jsonb_build_object('step', p_step), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'step', p_step);
end $$;
-- readable by enrolled students and staff (so each student's Asha knows what the class is on)
create or replace function public.ma_ai_prof_class_current(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not (public.ma_ai_student_ok(p_user, p_course) or public.ma_ai_prof_read_ok(p_user, p_course, 'edit_exams') or public.ma_ai_prof_read_ok(p_user, p_course, 'grade')) then jsonb_build_object('live', false)
    else coalesce((select jsonb_build_object('live', true, 'class_id', c.id, 'title', c.title, 'step', c.step, 'sections', jsonb_array_length(c.outline), 'outline', c.outline, 'current', c.outline -> c.step,
        'open_questions', (select count(*) from public.ma_ai_question q where q.class_id = c.id and q.status = 'open'))
      from public.ma_ai_class c where c.course_id = p_course and c.status = 'live'), jsonb_build_object('live', false)) end;
$$;

-- ---- standing instructions ("autopilot") ----------------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_standing_set(p_user uuid, p_course uuid, p_kind text, p_target uuid, p_params jsonb, p_enabled boolean, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'standing'); sid bigint; aid bigint; prev public.ma_ai_standing%rowtype;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if p_kind not in ('finalize_after_close', 'remind_before_close') or not exists (select 1 from public.ma_exam where id = p_target and course_id = p_course) then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  select * into prev from public.ma_ai_standing where course_id = p_course and kind = p_kind and target = p_target order by id desc limit 1;
  if found then
    update public.ma_ai_standing set enabled = coalesce(p_enabled, true), params = coalesce(p_params, params), last_run = case when coalesce(p_enabled, true) and not prev.enabled then null else last_run end where id = prev.id; sid := prev.id;
  else
    insert into public.ma_ai_standing (course_id, actor_user, kind, target, params, enabled) values (p_course, p_user, p_kind, p_target, coalesce(p_params, '{}'::jsonb), coalesce(p_enabled, true)) returning id into sid;
  end if;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'standing_set', 'standing:' || sid, jsonb_build_object('kind', p_kind, 'exam', p_target), case when prev.id is not null then jsonb_build_object('enabled', prev.enabled) end, jsonb_build_object('enabled', coalesce(p_enabled, true)), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'standing_id', sid);
end $$;
create or replace function public.ma_ai_prof_standing_list(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.ma_ai_prof_read_ok(p_user, p_course, 'edit_exams') then jsonb_build_object('allowed', false)
    else jsonb_build_object('allowed', true, 'rules', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'exam', target, 'params', params, 'enabled', enabled, 'last_run', last_run) order by id) from public.ma_ai_standing where course_id = p_course), '[]'::jsonb)) end;
$$;

create or replace function public.ma_ai_prof_tick()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.ma_ai_standing%rowtype; e public.ma_exam%rowtype; res jsonb; done int := 0; applied jsonb := public.ma_ai_prof_apply_due(); hrs numeric; mins numeric;
begin
  for r in select * from public.ma_ai_standing where enabled and last_run is null order by id loop
    select * into e from public.ma_exam where id = r.target and course_id = r.course_id;
    if not found or e.closes_at is null then continue; end if;
    if r.kind = 'finalize_after_close' then
      mins := coalesce((r.params ->> 'delay_minutes')::numeric, 60);
      if e.closes_at + make_interval(mins => mins::int) <= now() then
        res := public.ma_ai_prof_finalize(r.actor_user, r.course_id, r.target, null, 'schedule');
        if (res ->> 'ok')::boolean then update public.ma_ai_standing set last_run = now() where id = r.id; done := done + 1; end if;
      end if;
    elsif r.kind = 'remind_before_close' then
      hrs := coalesce((r.params ->> 'hours')::numeric, 24);
      if e.closes_at > now() and e.closes_at <= now() + make_interval(hours => hrs::int) then
        res := public.ma_ai_prof_announce(r.actor_user, r.course_id, 'Reminder: ' || e.title || ' closes soon', e.title || ' closes on ' || to_char(e.closes_at at time zone 'UTC', 'Mon DD, YYYY HH24:MI') || ' UTC. Please complete it before then.', null, 'schedule');
        if (res ->> 'ok')::boolean then update public.ma_ai_standing set last_run = now() where id = r.id; done := done + 1; end if;
      end if;
    end if;
  end loop;
  return jsonb_build_object('rules_run', done, 'holds', applied);
end $$;

-- ---- overview (replaces 112's) + undo (replaces 112's) + recent ------------------------------------------------------------------------------
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
    'assignments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'points', a.points, 'due_at', a.due_at, 'published', a.is_published,
         'submissions', (select count(*) from public.ma_submission s where s.assignment_id = a.id),
         'ungraded', (select count(*) from public.ma_submission s where s.assignment_id = a.id and s.graded_at is null),
         'ai_proposals_waiting', (select count(*) from public.ma_submission s where s.assignment_id = a.id and s.graded_at is null and s.ai_score is not null)) order by a.created_at desc) from public.ma_assignment a where a.course_id = p_course), '[]'::jsonb),
    'quiz_deadlines', coalesce((select jsonb_agg(jsonb_build_object('chapter', chapter, 'closes_at', closes_at) order by chapter) from public.ma_quiz_deadline where course_id = p_course), '[]'::jsonb),
    'arena_deadlines', coalesce((select jsonb_agg(jsonb_build_object('arena', arena_slug, 'closes_at', closes_at) order by arena_slug) from public.ma_arena_deadline where course_id = p_course), '[]'::jsonb),
    'grade_changes_on_hold', coalesce((select jsonb_agg(jsonb_build_object('pending_id', id, 'student_id', params ->> 'student_id', 'pct', params -> 'pct', 'applies_at', apply_at) order by apply_at) from public.ma_ai_pending where course_id = p_course and status = 'pending'), '[]'::jsonb),
    'open_student_questions', (select count(*) from public.ma_ai_question where course_id = p_course and status = 'open'),
    'live_class', public.ma_ai_prof_class_current(p_user, p_course),
    'standing_rules', (public.ma_ai_prof_standing_list(p_user, p_course) -> 'rules'),
    'recent_announcements', coalesce((select jsonb_agg(jsonb_build_object('title', x.title, 'at', x.created_at)) from (select title, created_at from public.ma_announcement where course_id = p_course order by created_at desc limit 5) x), '[]'::jsonb)
  ) into res;
  return res;
end $$;

create or replace function public.ma_ai_prof_undo(p_user uuid, p_course uuid, p_action bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.ma_ai_actions%rowtype; cap text; ids uuid[]; pid bigint; pend public.ma_ai_pending%rowtype; k text; key text; sub_n int;
begin
  select * into a from public.ma_ai_actions where id = p_action and course_id = p_course;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  cap := case when a.action in ('finalize','feedback_propose','feedback_finalize','grade_override_queued','grade_override','answer_question') then 'grade' else 'edit_exams' end;
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
  elsif a.action = 'assignment_create' then
    select count(*) into sub_n from public.ma_submission where assignment_id = split_part(a.target, ':', 2)::uuid;
    if sub_n > 0 then update public.ma_assignment set is_published = false where id = split_part(a.target, ':', 2)::uuid and course_id = p_course;
    else delete from public.ma_assignment where id = split_part(a.target, ':', 2)::uuid and course_id = p_course; end if;
  elsif a.action = 'assignment_update' then
    update public.ma_assignment set title = a.before ->> 'title', instructions = a.before ->> 'instructions', points = (a.before ->> 'points')::numeric,
      due_at = (a.before ->> 'due_at')::timestamptz, is_published = (a.before ->> 'is_published')::boolean where id = split_part(a.target, ':', 2)::uuid and course_id = p_course;
  elsif a.action = 'deadline' then
    k := split_part(a.target, ':', 1); key := split_part(a.target, ':', 2);
    if k = 'quiz' then
      if a.before ->> 'closes_at' is null then delete from public.ma_quiz_deadline where course_id = p_course and chapter = key::int;
      else update public.ma_quiz_deadline set closes_at = (a.before ->> 'closes_at')::timestamptz, updated_at = now() where course_id = p_course and chapter = key::int; end if;
    else
      if a.before ->> 'closes_at' is null then delete from public.ma_arena_deadline where course_id = p_course and arena_slug = key;
      else update public.ma_arena_deadline set closes_at = (a.before ->> 'closes_at')::timestamptz, updated_at = now() where course_id = p_course and arena_slug = key; end if;
    end if;
  elsif a.action = 'feedback_propose' then
    update public.ma_submission set ai_score = (a.before ->> 'ai_score')::numeric, ai_feedback = a.before ->> 'ai_feedback', ai_graded_at = (a.before ->> 'ai_graded_at')::timestamptz
     where id = split_part(a.target, ':', 2)::uuid and course_id = p_course and graded_at is null;
  elsif a.action = 'feedback_finalize' then
    select array(select (jsonb_array_elements_text(a.before -> 'submission_ids'))::uuid) into ids;
    update public.ma_submission set score = null, feedback = null, graded_at = null, graded_by = null where id = any(ids) and graded_by = 'asha:' || a.actor_user::text;
  elsif a.action = 'grade_override_queued' then
    pid := (a.after ->> 'pending_id')::bigint;
    select * into pend from public.ma_ai_pending where id = pid;
    if pend.status = 'pending' then update public.ma_ai_pending set status = 'cancelled', resolved_at = now() where id = pid;
    else return jsonb_build_object('ok', false, 'reason', 'already_applied_undo_the_applied_change'); end if;
  elsif a.action = 'grade_override' then
    if a.before ->> 'override_pct' is null then delete from public.ma_grade_override where course_id = p_course and student_id = split_part(a.target, ':', 2) and set_by like 'asha:%';
    else update public.ma_grade_override set override_pct = (a.before ->> 'override_pct')::numeric, set_by = 'asha-undo:' || p_user::text, updated_at = now() where course_id = p_course and student_id = split_part(a.target, ':', 2); end if;
  elsif a.action = 'answer_question' then
    update public.ma_ai_question set answer = a.before ->> 'answer', status = coalesce(a.before ->> 'status', 'open'), answered_at = null, answered_by = null where id = split_part(a.target, ':', 2)::uuid and course_id = p_course;
  elsif a.action = 'class_start' then
    update public.ma_ai_class set status = 'ended', ended_at = now() where id = split_part(a.target, ':', 2)::uuid and status = 'live';
  elsif a.action = 'class_step' then
    update public.ma_ai_class set step = (a.before ->> 'step')::int where id = split_part(a.target, ':', 2)::uuid and status = 'live';
  elsif a.action = 'standing_set' then
    update public.ma_ai_standing set enabled = coalesce((a.before ->> 'enabled')::boolean, false) where id = split_part(a.target, ':', 2)::bigint and course_id = p_course;
  else return jsonb_build_object('ok', false, 'reason', 'not_undoable');
  end if;
  update public.ma_ai_actions set status = 'undone', undone_at = now() where id = p_action;
  return jsonb_build_object('ok', true);
end $$;

do $$
declare f text;
begin
  foreach f in array array['ma_ai_prof_log(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,uuid)','ma_ai_prof_read_ok(uuid,uuid,text)','ma_ai_student_ok(uuid,uuid)',
    'ma_ai_prof_assignment_save(uuid,uuid,uuid,text,text,numeric,timestamptz,boolean,uuid,text)','ma_ai_prof_deadline(uuid,uuid,text,text,timestamptz,uuid,text)',
    'ma_ai_prof_submissions(uuid,uuid,uuid,int)','ma_ai_prof_propose_feedback(uuid,uuid,uuid,numeric,text,uuid,text)','ma_ai_prof_finalize_assignment(uuid,uuid,uuid,uuid,text)',
    'ma_ai_prof_grade_override(uuid,uuid,text,numeric,text,uuid,text)','ma_ai_prof_apply_due()','ma_ai_prof_student_ask(uuid,uuid,text)','ma_ai_prof_student_questions(uuid,uuid)',
    'ma_ai_prof_questions(uuid,uuid,text)','ma_ai_prof_answer_question(uuid,uuid,uuid,text,uuid,text)','ma_ai_prof_class_start(uuid,uuid,text,jsonb,uuid,text)',
    'ma_ai_prof_class_step(uuid,uuid,integer,boolean,uuid,text)','ma_ai_prof_class_current(uuid,uuid)','ma_ai_prof_standing_set(uuid,uuid,text,uuid,jsonb,boolean,uuid,text)',
    'ma_ai_prof_standing_list(uuid,uuid)','ma_ai_prof_tick()','ma_ai_prof_overview(uuid,uuid)','ma_ai_prof_undo(uuid,uuid,bigint)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
