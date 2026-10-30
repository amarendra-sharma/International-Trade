-- 118_ma_ai_class_schedule.sql -- scheduled live classes + attendance for Asha (Macroeconomics).
create table if not exists public.ma_ai_class_schedule (
  course_id uuid primary key, title text not null, outline jsonb not null, days int[] not null, start_local time not null, duration_min int not null,
  tz text not null default 'America/New_York', auto boolean not null default true, updated_by uuid, updated_at timestamptz not null default now());
alter table public.ma_ai_class add column if not exists scheduled boolean not null default false;
alter table public.ma_ai_class add column if not exists ends_at timestamptz;
alter table public.ma_ai_class add column if not exists duration_min int;
create table if not exists public.ma_ai_attendance (
  class_id uuid not null, course_id uuid not null, student_id text not null, first_seen timestamptz not null default now(), last_seen timestamptz not null default now(), seconds int not null default 0,
  primary key (class_id, student_id));
do $$ declare t text; begin
  foreach t in array array['ma_ai_class_schedule','ma_ai_attendance'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

create or replace function public.ma_ai_prof_schedule_get(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.ma_ai_prof_read_ok(p_user, p_course, 'edit_exams') then jsonb_build_object('allowed', false)
    else jsonb_build_object('allowed', true, 'schedule', (select to_jsonb(s) from public.ma_ai_class_schedule s where s.course_id = p_course)) end;
$$;

create or replace function public.ma_ai_prof_schedule_set(p_user uuid, p_course uuid, p_title text, p_outline jsonb, p_days int[], p_start text, p_minutes int, p_tz text, p_auto boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare st time;
begin
  if not public.ma_ai_prof_read_ok(p_user, p_course, 'edit_exams') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  begin st := p_start::time; exception when others then return jsonb_build_object('ok', false, 'reason', 'bad_time'); end;
  if not exists (select 1 from pg_timezone_names where name = p_tz) then return jsonb_build_object('ok', false, 'reason', 'bad_tz'); end if;
  if coalesce(length(trim(p_title)), 0) < 3 or length(p_title) > 160 or jsonb_typeof(p_outline) <> 'array' or jsonb_array_length(p_outline) not between 1 and 20 or length(p_outline::text) > 8000
     or p_days is null or cardinality(p_days) not between 1 and 7 or exists (select 1 from unnest(p_days) d where d not between 0 and 6) or p_minutes not between 10 and 240 then
    return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  insert into public.ma_ai_class_schedule (course_id, title, outline, days, start_local, duration_min, tz, auto, updated_by, updated_at)
    values (p_course, trim(p_title), p_outline, p_days, st, p_minutes, p_tz, coalesce(p_auto, true), p_user, now())
    on conflict (course_id) do update set title = excluded.title, outline = excluded.outline, days = excluded.days, start_local = excluded.start_local,
      duration_min = excluded.duration_min, tz = excluded.tz, auto = excluded.auto, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.ma_ai_prof_schedule_clear(p_user uuid, p_course uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.ma_ai_prof_read_ok(p_user, p_course, 'edit_exams') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  delete from public.ma_ai_class_schedule where course_id = p_course;
  return jsonb_build_object('ok', true);
end $$;

-- student or staff asks "is there a live class?"; an enrolled student's call also records attendance (call it only while the student has the class open)
create or replace function public.ma_ai_class_ping(p_user uuid, p_course uuid, p_join boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.ma_ai_class%rowtype; isstu boolean; isstaff boolean; sec int := 0; present boolean := false;
begin
  isstu := exists (select 1 from public.ma_enrollment e where e.course_id = p_course and e.user_id = p_user::text and e.status::text = 'active')
    and coalesce((select enabled and professor_mode and not prof_paused and coalesce((prof_actions ->> 'class')::boolean, false) from public.ma_ai_settings where course_id = p_course), false);
  isstaff := public.ma_ai_prof_read_ok(p_user, p_course, 'edit_exams');
  if not isstu and not isstaff then return jsonb_build_object('live', false); end if;
  select * into c from public.ma_ai_class where course_id = p_course and status = 'live';
  if not found then return jsonb_build_object('live', false); end if;
  if isstu and p_join then
    insert into public.ma_ai_attendance (class_id, course_id, student_id) values (c.id, p_course, p_user::text)
      on conflict (class_id, student_id) do update set seconds = public.ma_ai_attendance.seconds + least(greatest(extract(epoch from now() - public.ma_ai_attendance.last_seen)::int, 0), 150), last_seen = now()
      returning seconds into sec;
    present := sec >= 0.5 * coalesce(c.duration_min, 60) * 60;
  end if;
  return jsonb_build_object('live', true, 'class_id', c.id, 'title', c.title, 'step', c.step, 'sections', jsonb_array_length(c.outline), 'current', c.outline -> c.step,
    'ends_at', c.ends_at, 'student', isstu, 'joined', isstu and p_join, 'seconds', sec, 'present', present);
end $$;

create or replace function public.ma_ai_prof_attendance(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.ma_ai_prof_read_ok(p_user, p_course, 'grade') then jsonb_build_object('allowed', false)
   else jsonb_build_object('allowed', true,
     'enrolled', (select count(*) from public.ma_enrollment e where e.course_id = p_course and e.status::text = 'active'),
     'classes', coalesce((select jsonb_agg(x order by x.started_at desc) from (
        select c.id, c.title, c.started_at, c.status, coalesce(c.duration_min, 60) duration_min,
          (select count(*) from public.ma_ai_attendance a where a.class_id = c.id) joined,
          (select count(*) from public.ma_ai_attendance a where a.class_id = c.id and a.seconds >= 0.5 * coalesce(c.duration_min, 60) * 60) present,
          (select count(*) from public.ma_ai_question q where q.class_id = c.id) questions,
          (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(nullif(p.full_name, ''), nullif(p.display_name, ''), 'student'), 'minutes', round(a.seconds / 60.0), 'present', a.seconds >= 0.5 * coalesce(c.duration_min, 60) * 60) order by p.full_name), '[]'::jsonb)
             from public.ma_ai_attendance a left join public.ma_person p on p.user_id::text = a.student_id where a.class_id = c.id) students
        from public.ma_ai_class c where c.course_id = p_course order by c.started_at desc limit 10) x), '[]'::jsonb)) end;
$$;

-- tick: auto-start, pace and end scheduled classes (runs inside ma_ai_prof_tick; owner acts; only start and end are logged so steps do not use the daily action cap)
create or replace function public.ma_ai_class_tick()
returns jsonb language plpgsql security definer set search_path = public as $$
declare sc record; c public.ma_ai_class%rowtype; owner uuid; loc timestamp; start_ts timestamptz; n int; want int; started int := 0; ended int := 0; stepped int := 0; res jsonb;
begin
  -- end overdue scheduled classes
  for c in select * from public.ma_ai_class where status = 'live' and scheduled and ends_at is not null and ends_at <= now() loop
    update public.ma_ai_class set status = 'ended', ended_at = now() where id = c.id;
    begin owner := c.started_by; perform public.ma_ai_prof_log(c.course_id, owner, 'schedule', 'class_end', 'class:' || c.id, '{}'::jsonb, jsonb_build_object('step', c.step), null, null); exception when others then null; end;
    ended := ended + 1;
  end loop;
  -- pace live scheduled classes by elapsed time
  for c in select * from public.ma_ai_class where status = 'live' and scheduled and ends_at is not null loop
    n := jsonb_array_length(c.outline);
    want := least(n - 1, greatest(0, floor(extract(epoch from now() - c.started_at) / nullif(extract(epoch from c.ends_at - c.started_at), 0) * n)::int));
    if want <> c.step then update public.ma_ai_class set step = want where id = c.id; stepped := stepped + 1; end if;
  end loop;
  -- start due classes
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
  return jsonb_build_object('started', started, 'ended', ended, 'stepped', stepped);
end $$;

do $$ declare f text; begin
  foreach f in array array['ma_ai_prof_schedule_get(uuid,uuid)','ma_ai_prof_schedule_set(uuid,uuid,text,jsonb,int[],text,int,text,boolean)','ma_ai_prof_schedule_clear(uuid,uuid)','ma_ai_class_ping(uuid,uuid,boolean)','ma_ai_prof_attendance(uuid,uuid)','ma_ai_class_tick()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- run it every minute (the existing 5-minute tick keeps doing deadlines and standing rules)
select cron.schedule('ma-ai-class-tick', '* * * * *', 'select public.ma_ai_class_tick()');
