-- 126: rollout features: appeals + review inbox, mute/remove in live class, makeup eligibility, usage report, higher default cost cap
alter table public.ma_ai_review_requests add column if not exists kind text not null default 'meeting', add column if not exists item_kind text, add column if not exists resolution text;
alter table public.ma_ai_attendance add column if not exists muted boolean not null default false, add column if not exists removed boolean not null default false;
alter table public.ma_ai_settings add column if not exists makeup_requires_approval boolean not null default false;
create table if not exists public.ma_ai_makeup_approval (course_id uuid not null, student_id text not null, reason text, approved_by uuid, created_at timestamptz not null default now(), primary key (course_id, student_id));
alter table public.ma_ai_makeup_approval enable row level security;
alter table public.ma_ai_settings alter column course_monthly_usd set default 200;
update public.ma_ai_settings set course_monthly_usd = 200 where course_monthly_usd < 200;

-- name resolver used by several functions: exact user id, else email, else name (enrolled students only)
create or replace function public.ma_ai_find_student(p_course uuid, p_text text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare n int; r record; t text := lower(trim(coalesce(p_text, '')));
begin
  if t = '' then return jsonb_build_object('ok', false, 'reason', 'no_student'); end if;
  select count(*) into n from public.ma_enrollment e left join public.ma_person p on p.user_id = e.user_id
    where e.course_id = p_course and e.status::text in ('active', 'comped') and (lower(e.user_id) = t or lower(coalesce(p.email, '')) = t or lower(coalesce(p.full_name, '')) like '%' || t || '%' or lower(coalesce(p.display_name, '')) = t);
  if n = 0 then return jsonb_build_object('ok', false, 'reason', 'student_not_found'); end if;
  if n > 1 then return jsonb_build_object('ok', false, 'reason', 'ambiguous', 'next_step', 'More than one student matches. Use the exact email address.'); end if;
  select e.user_id, coalesce(nullif(p.full_name, ''), nullif(p.display_name, ''), p.email, 'student') nm into r from public.ma_enrollment e left join public.ma_person p on p.user_id = e.user_id
    where e.course_id = p_course and e.status::text in ('active', 'comped') and (lower(e.user_id) = t or lower(coalesce(p.email, '')) = t or lower(coalesce(p.full_name, '')) like '%' || t || '%' or lower(coalesce(p.display_name, '')) = t) limit 1;
  return jsonb_build_object('ok', true, 'id', r.user_id, 'name', r.nm);
end $$;

-- appeals (student) -------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_appeal_create(p_user uuid, p_course uuid, p_item_kind text, p_item_title text, p_note text) returns jsonb language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if not public.ma_ai_can_read(p_user, p_course) then return jsonb_build_object('ok', false, 'reason', 'not_enrolled'); end if;
  if p_item_kind not in ('exam', 'quiz', 'assignment', 'arena', 'final_grade', 'other') then return jsonb_build_object('ok', false, 'reason', 'bad_kind'); end if;
  if coalesce(length(trim(p_note)), 0) < 10 then return jsonb_build_object('ok', false, 'reason', 'note_too_short'); end if;
  if (select count(*) from public.ma_ai_review_requests where user_id = p_user and course_id = p_course and status = 'open') >= 5 then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  insert into public.ma_ai_review_requests (user_id, course_id, with_whom, topic, note, kind, item_kind)
    values (p_user, p_course, 'professor', left('Grade appeal: ' || trim(coalesce(nullif(p_item_title, ''), p_item_kind)), 200), left(trim(p_note), 500), 'appeal', p_item_kind) returning id into rid;
  return jsonb_build_object('ok', true, 'id', rid);
end $$;

create or replace function public.ma_ai_review_request_resolve(p_user uuid, p_course uuid, p_id uuid, p_resolution text, p_now timestamptz default now()) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.ma_ai_is_staff(p_user, p_course) then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  update public.ma_ai_review_requests set status = 'done', done_at = p_now, done_by = p_user, resolution = nullif(left(trim(coalesce(p_resolution, '')), 1000), '') where id = p_id and course_id = p_course and status = 'open';
  return jsonb_build_object('ok', found);
end $$;

create or replace function public.ma_ai_review_requests_list(p_user uuid, p_course uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ma_ai_is_staff(p_user, p_course) then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  return jsonb_build_object('ok', true, 'requests', coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'with', r.with_whom, 'topic', r.topic, 'note', r.note, 'status', r.status, 'created_at', r.created_at, 'kind', r.kind, 'item_kind', r.item_kind, 'resolution', r.resolution,
      'student', coalesce(nullif(p.full_name, ''), p.email, 'student')) order by (r.status = 'open') desc, r.created_at desc)
      from (select * from public.ma_ai_review_requests where course_id = p_course order by (status = 'open') desc, created_at desc limit 100) r
      left join public.ma_person p on p.user_id = r.user_id::text), '[]'::jsonb));
end $$;

create or replace function public.ma_ai_review_requests_mine(p_user uuid, p_course uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'with', with_whom, 'topic', topic, 'status', status, 'created_at', created_at, 'kind', kind, 'resolution', resolution) order by created_at desc), '[]'::jsonb)
    from (select * from public.ma_ai_review_requests where user_id = p_user and course_id = p_course order by created_at desc limit 20) t;
$$;

-- review inbox (staff): everything waiting on a human ----------------------------------------------------------------
create or replace function public.ma_ai_prof_inbox(p_user uuid, p_course uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ma_ai_prof_read_ok(p_user, p_course, 'grade') then return jsonb_build_object('allowed', false); end if;
  return jsonb_build_object('allowed', true,
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'with', r.with_whom, 'topic', r.topic, 'note', r.note, 'created_at', r.created_at, 'student', coalesce(nullif(p.full_name, ''), p.email, 'student')) order by r.created_at)
        from public.ma_ai_review_requests r left join public.ma_person p on p.user_id = r.user_id::text where r.course_id = p_course and r.status = 'open'), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'question', left(q.question, 400), 'during_class', q.class_id is not null, 'asked_at', q.created_at) order by q.created_at)
        from (select * from public.ma_ai_question where course_id = p_course and status = 'open' order by created_at limit 25) q), '[]'::jsonb),
    'held_grade_changes', (select count(*) from public.ma_ai_pending where course_id = p_course and status not in ('applied', 'cancelled')));
end $$;

create or replace function public.ma_ai_prof_resolve_request(p_user uuid, p_course uuid, p_id uuid, p_resolution text, p_session uuid default null, p_trigger text default 'professor') returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'grade', 'feedback'); r public.ma_ai_review_requests%rowtype; aid bigint;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if coalesce(length(trim(p_resolution)), 0) < 5 then return jsonb_build_object('ok', false, 'reason', 'bad_text'); end if;
  select * into r from public.ma_ai_review_requests where id = p_id and course_id = p_course and status = 'open';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  update public.ma_ai_review_requests set status = 'done', done_at = now(), done_by = p_user, resolution = left(trim(p_resolution), 1000) where id = p_id;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'resolve_request', 'request:' || p_id, jsonb_build_object('kind', r.kind, 'topic', r.topic), '{}'::jsonb, jsonb_build_object('resolution', left(trim(p_resolution), 200)), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid);
end $$;

-- mute / remove a student in the live class ---------------------------------------------------------------------------
create or replace function public.ma_ai_prof_class_mute(p_user uuid, p_course uuid, p_student text, p_mode text, p_session uuid default null, p_trigger text default 'professor') returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'class'); c public.ma_ai_class%rowtype; f jsonb; aid bigint;
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if p_mode not in ('mute', 'unmute', 'remove', 'restore') then return jsonb_build_object('ok', false, 'reason', 'bad_mode'); end if;
  select * into c from public.ma_ai_class where course_id = p_course and status = 'live';
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_live_class'); end if;
  f := public.ma_ai_find_student(p_course, p_student);
  if (f ->> 'ok')::boolean is not true then return f; end if;
  insert into public.ma_ai_attendance (class_id, course_id, student_id, seconds) values (c.id, p_course, f ->> 'id', 0) on conflict (class_id, student_id) do nothing;
  update public.ma_ai_attendance set muted = case p_mode when 'mute' then true when 'unmute' then false else muted end, removed = case p_mode when 'remove' then true when 'restore' then false else removed end
    where class_id = c.id and student_id = f ->> 'id';
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'class_' || p_mode, 'student:' || (f ->> 'id'), jsonb_build_object('name', f ->> 'name'), '{}'::jsonb, jsonb_build_object('mode', p_mode), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'student', f ->> 'name', 'mode', p_mode);
end $$;

do $$ declare d text; begin
  d := pg_get_functiondef('public.ma_ai_class_turn_gate'::regproc);
  if position('a.removed' in d) = 0 then
    d := replace(d, E'  if p_kind = ''teach'' and a.taught_step < c.step then', E'  if a.removed then return jsonb_build_object(''live'', true, ''ok'', false, ''reason'', ''removed''); end if;\n  if a.muted and p_kind <> ''teach'' then return jsonb_build_object(''live'', true, ''ok'', false, ''reason'', ''muted''); end if;\n  if p_kind = ''teach'' and a.taught_step < c.step then');
    execute d;
  end if;
  d := pg_get_functiondef('public.ma_ai_class_ping'::regproc);
  if position('removed' in d) = 0 then
    d := replace(d, E'  if isstu and p_join then', E'  if isstu and exists (select 1 from public.ma_ai_attendance a where a.class_id = c.id and a.student_id = p_user::text and a.removed) then return jsonb_build_object(''live'', false, ''removed'', true); end if;\n  if isstu and p_join then');
    execute d;
  end if;
  d := pg_get_functiondef('public.ma_ai_prof_attendance'::regproc);
  if position('''muted''' in d) = 0 then
    d := replace(d, 'jsonb_build_object(''name'', coalesce(', 'jsonb_build_object(''id'', a.student_id, ''muted'', a.muted, ''removed'', a.removed, ''name'', coalesce(');
    execute d;
  end if;
  d := pg_get_functiondef('public.ma_ai_final_calc'::regproc);
  if position('makeup_approval' in d) = 0 then
    d := replace(d, 'x.title ~* ''^makeup'' and lower(x.title) like', '(not coalesce((select t.makeup_requires_approval from public.ma_ai_settings t where t.course_id = p_course), false) or exists (select 1 from public.ma_ai_makeup_approval m where m.course_id = p_course and m.student_id = p_student)) and x.title ~* ''^makeup'' and lower(x.title) like');
    execute d;
  end if;
end $$;

-- makeup eligibility ---------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_prof_makeup(p_user uuid, p_course uuid, p_action text, p_student text default null, p_reason text default null, p_session uuid default null, p_trigger text default 'professor') returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'grade', 'grade_final'); f jsonb; aid bigint;
begin
  if p_action = 'list' then
    if not public.ma_ai_prof_read_ok(p_user, p_course, 'grade') then return jsonb_build_object('ok', false, 'reason', 'not_staff'); end if;
    return jsonb_build_object('ok', true, 'requires_approval', coalesce((select makeup_requires_approval from public.ma_ai_settings where course_id = p_course), false),
      'approved', coalesce((select jsonb_agg(jsonb_build_object('student', coalesce(nullif(p.full_name, ''), p.email, m.student_id), 'reason', m.reason, 'since', m.created_at)) from public.ma_ai_makeup_approval m left join public.ma_person p on p.user_id = m.student_id where m.course_id = p_course), '[]'::jsonb));
  end if;
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if p_action in ('require_on', 'require_off') then
    update public.ma_ai_settings set makeup_requires_approval = (p_action = 'require_on') where course_id = p_course;
    aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'makeup_policy', 'course:' || p_course, jsonb_build_object('requires_approval', p_action = 'require_on'), '{}'::jsonb, '{}'::jsonb, p_session);
    return jsonb_build_object('ok', true, 'action_id', aid, 'requires_approval', p_action = 'require_on');
  end if;
  if p_action not in ('approve', 'revoke') then return jsonb_build_object('ok', false, 'reason', 'bad_action'); end if;
  f := public.ma_ai_find_student(p_course, p_student);
  if (f ->> 'ok')::boolean is not true then return f; end if;
  if p_action = 'approve' then
    insert into public.ma_ai_makeup_approval (course_id, student_id, reason, approved_by) values (p_course, f ->> 'id', left(p_reason, 300), p_user) on conflict (course_id, student_id) do update set reason = excluded.reason, approved_by = excluded.approved_by;
  else delete from public.ma_ai_makeup_approval where course_id = p_course and student_id = f ->> 'id'; end if;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'makeup_' || p_action, 'student:' || (f ->> 'id'), jsonb_build_object('name', f ->> 'name', 'reason', left(p_reason, 200)), '{}'::jsonb, '{}'::jsonb, p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'student', f ->> 'name');
end $$;

-- usage report (staff of the course) and a platform-wide billing view --------------------------------------------------
create or replace function public.ma_ai_prof_usage(p_user uuid, p_course uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ma_ai_prof_read_ok(p_user, p_course, 'grade') then return jsonb_build_object('allowed', false); end if;
  return jsonb_build_object('allowed', true,
    'budget_usd', (select course_monthly_usd from public.ma_ai_settings where course_id = p_course),
    'month_cost_usd', coalesce((select round(sum(cost_micro_usd) / 1e6, 4) from public.ma_ai_usage where course_id = p_course and created_at >= date_trunc('month', now())), 0),
    'total_cost_usd', coalesce((select round(sum(cost_micro_usd) / 1e6, 4) from public.ma_ai_usage where course_id = p_course), 0),
    'turns', (select count(*) from public.ma_ai_usage where course_id = p_course),
    'enrolled', (select count(*) from public.ma_enrollment e where e.course_id = p_course and e.status::text in ('active', 'comped')),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'turns', n, 'cost_usd', c) order by d) from (select created_at::date d, count(*) n, round(sum(cost_micro_usd) / 1e6, 4) c from public.ma_ai_usage where course_id = p_course and created_at > now() - interval '45 days' group by 1) z), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('name', nm, 'turns', n, 'cost_usd', c) order by c desc) from (select coalesce(nullif(p.full_name, ''), p.email, 'user') nm, count(*) n, round(sum(u.cost_micro_usd) / 1e6, 4) c from public.ma_ai_usage u left join public.ma_person p on p.user_id = u.user_id::text where u.course_id = p_course group by 1 order by 3 desc limit 200) y), '[]'::jsonb));
end $$;

create or replace view public.ma_ai_v_billing with (security_invoker = true) as
  select c.id as course_id, c.title, c.term, date_trunc('month', u.created_at) as month, count(*) as turns, count(distinct u.user_id) as users, round(sum(u.cost_micro_usd) / 1e6, 4) as cost_usd,
    (select count(*) from public.ma_enrollment e where e.course_id = c.id and e.status::text in ('active', 'comped')) as enrolled
  from public.ma_ai_usage u join public.ma_course c on c.id = u.course_id group by c.id, c.title, c.term, 2;
revoke all on public.ma_ai_v_billing from public, anon, authenticated;
grant select on public.ma_ai_v_billing to service_role;

do $$ declare f text; begin
  foreach f in array array['ma_ai_find_student(uuid,text)', 'ma_ai_appeal_create(uuid,uuid,text,text,text)', 'ma_ai_review_request_resolve(uuid,uuid,uuid,text,timestamptz)', 'ma_ai_prof_inbox(uuid,uuid)', 'ma_ai_prof_resolve_request(uuid,uuid,uuid,text,uuid,text)',
    'ma_ai_prof_class_mute(uuid,uuid,text,text,uuid,text)', 'ma_ai_prof_makeup(uuid,uuid,text,text,text,uuid,text)', 'ma_ai_prof_usage(uuid,uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
