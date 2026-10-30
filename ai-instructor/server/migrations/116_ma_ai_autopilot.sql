-- 116_ma_ai_autopilot.sql -- course-wide autopilot switches for professor mode. Reminders and exam-score finalizing run in SQL (ma_ai_prof_tick);
-- assignment grading and question answering need the AI, so the scheduler also calls the function (see the pg_net job).
alter table public.ma_ai_settings add column if not exists autopilot jsonb not null default
  '{"remind":false,"remind_hours":24,"finalize_exams":false,"finalize_delay_min":60,"grade_assignments":false,"grade_delay_min":60,"answer_questions":false}'::jsonb;

create table if not exists public.ma_ai_autolog (
  course_id uuid not null, kind text not null, target text not null, at timestamptz not null default now(), primary key (course_id, kind, target));
alter table public.ma_ai_autolog enable row level security;
revoke all on public.ma_ai_autolog from anon, authenticated;
grant select, insert, update, delete on public.ma_ai_autolog to service_role;

-- courses where something AI-driven is switched on
create or replace function public.ma_ai_prof_autopilot_courses()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('course_id', s.course_id, 'owner_id', c.owner_id)), '[]'::jsonb)
    from public.ma_ai_settings s join public.ma_course c on c.id = s.course_id
   where s.enabled and s.professor_mode and not s.prof_paused
     and (coalesce((s.autopilot ->> 'grade_assignments')::boolean, false) or coalesce((s.autopilot ->> 'answer_questions')::boolean, false));
$$;

-- the next small batch of AI work for one course
create or replace function public.ma_ai_prof_autopilot_work(p_course uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.ma_ai_settings%rowtype; gd int; subs jsonb := '[]'::jsonb; ready jsonb := '[]'::jsonb; qs jsonb := '[]'::jsonb;
begin
  select * into s from public.ma_ai_settings where course_id = p_course;
  if not found or not s.enabled or not s.professor_mode or s.prof_paused then return jsonb_build_object('subs', subs, 'ready', ready, 'questions', qs); end if;
  gd := coalesce((s.autopilot ->> 'grade_delay_min')::int, 60);
  if coalesce((s.autopilot ->> 'grade_assignments')::boolean, false) then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'assignment', x.aid, 'title', x.title, 'instructions', x.instructions, 'points', x.points, 'text', x.txt)), '[]'::jsonb) into subs
      from (select sub.id, a.id aid, a.title, left(coalesce(a.instructions, ''), 6000) instructions, a.points, left(sub.text_response, 6000) txt
              from public.ma_submission sub join public.ma_assignment a on a.id = sub.assignment_id
             where sub.course_id = p_course and a.is_published and a.due_at is not null and a.due_at + make_interval(mins => gd) <= now()
               and sub.graded_at is null and sub.ai_score is null and length(trim(coalesce(sub.text_response, ''))) > 0
             order by sub.submitted_at limit 5) x;
    select coalesce(jsonb_agg(a.id), '[]'::jsonb) into ready from public.ma_assignment a
     where a.course_id = p_course and a.is_published and a.due_at is not null and a.due_at + make_interval(mins => gd) <= now()
       and exists (select 1 from public.ma_submission z where z.assignment_id = a.id and z.graded_at is null and z.ai_score is not null)
       and not exists (select 1 from public.ma_submission z where z.assignment_id = a.id and z.graded_at is null and z.ai_score is null and length(trim(coalesce(z.text_response, ''))) > 0);
  end if;
  if coalesce((s.autopilot ->> 'answer_questions')::boolean, false) then
    select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'question', q.question)), '[]'::jsonb) into qs
      from (select id, question from public.ma_ai_question where course_id = p_course and status = 'open' order by created_at limit 5) q;
  end if;
  return jsonb_build_object('subs', subs, 'ready', ready, 'questions', qs);
end $$;

-- tick: previous behaviour + course-wide reminders and exam-score finalizing
create or replace function public.ma_ai_prof_tick()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.ma_ai_standing%rowtype; e public.ma_exam%rowtype; res jsonb; done int := 0; applied jsonb := public.ma_ai_prof_apply_due(); hrs numeric; mins numeric;
  c record; items text; n int; owner uuid; fin int := 0; rem int := 0; fmins int; rh int;
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

  for c in select s.course_id, s.autopilot, co.owner_id from public.ma_ai_settings s join public.ma_course co on co.id = s.course_id
            where s.enabled and s.professor_mode and not s.prof_paused loop
    begin owner := c.owner_id::uuid; exception when others then continue; end;
    if coalesce((c.autopilot ->> 'finalize_exams')::boolean, false) then
      fmins := coalesce((c.autopilot ->> 'finalize_delay_min')::int, 60);
      for e in select x.* from public.ma_exam x where x.course_id = c.course_id and x.closes_at is not null and x.closes_at + make_interval(mins => fmins) <= now()
                 and exists (select 1 from public.ma_exam_attempt a where a.exam_id = x.id and a.graded_at is null and a.ai_score is not null and a.points_earned is null) loop
        res := public.ma_ai_prof_finalize(owner, c.course_id, e.id, null, 'schedule');
        if (res ->> 'ok')::boolean and coalesce((res ->> 'graded')::int, 0) > 0 then fin := fin + 1; end if;
      end loop;
    end if;
    if coalesce((c.autopilot ->> 'remind')::boolean, false) then
      rh := coalesce((c.autopilot ->> 'remind_hours')::int, 24);
      select string_agg(t.label, E'\n' order by t.at), count(*) into items, n from (
        select 'exam:' || x.id as k, x.title || ' closes ' || to_char(x.closes_at at time zone 'UTC', 'Mon DD HH24:MI') || ' UTC' as label, x.closes_at as at
          from public.ma_exam x where x.course_id = c.course_id and x.is_published and x.closes_at > now() and x.closes_at <= now() + make_interval(hours => rh)
           and not exists (select 1 from public.ma_ai_autolog l where l.course_id = c.course_id and l.kind = 'remind' and l.target = 'exam:' || x.id)
        union all
        select 'assignment:' || x.id, x.title || ' is due ' || to_char(x.due_at at time zone 'UTC', 'Mon DD HH24:MI') || ' UTC', x.due_at
          from public.ma_assignment x where x.course_id = c.course_id and x.is_published and x.due_at > now() and x.due_at <= now() + make_interval(hours => rh)
           and not exists (select 1 from public.ma_ai_autolog l where l.course_id = c.course_id and l.kind = 'remind' and l.target = 'assignment:' || x.id)
        union all
        select 'quiz:' || q.chapter, 'The Chapter ' || q.chapter || ' quiz closes ' || to_char(q.closes_at at time zone 'UTC', 'Mon DD HH24:MI') || ' UTC', q.closes_at
          from public.ma_quiz_deadline q where q.course_id = c.course_id and q.closes_at > now() and q.closes_at <= now() + make_interval(hours => rh)
           and not exists (select 1 from public.ma_ai_autolog l where l.course_id = c.course_id and l.kind = 'remind' and l.target = 'quiz:' || q.chapter)
      ) t;
      if n > 0 then
        res := public.ma_ai_prof_announce(owner, c.course_id, 'Coming up: deadlines in the next ' || rh || ' hours', E'Reminder from your instructor''s AI assistant:\n' || items, null, 'schedule');
        if (res ->> 'ok')::boolean then
          insert into public.ma_ai_autolog (course_id, kind, target)
            select c.course_id, 'remind', x.id::text from (
              select 'exam:' || id as id from public.ma_exam where course_id = c.course_id and is_published and closes_at > now() and closes_at <= now() + make_interval(hours => rh)
              union all select 'assignment:' || id from public.ma_assignment where course_id = c.course_id and is_published and due_at > now() and due_at <= now() + make_interval(hours => rh)
              union all select 'quiz:' || chapter from public.ma_quiz_deadline where course_id = c.course_id and closes_at > now() and closes_at <= now() + make_interval(hours => rh)) x
            on conflict do nothing;
          rem := rem + 1;
        end if;
      end if;
    end if;
  end loop;
  return jsonb_build_object('rules_run', done, 'holds', applied, 'exams_finalized', fin, 'reminders_posted', rem);
end $$;

do $$
declare f text;
begin
  foreach f in array array['ma_ai_prof_autopilot_courses()','ma_ai_prof_autopilot_work(uuid)','ma_ai_prof_tick()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
