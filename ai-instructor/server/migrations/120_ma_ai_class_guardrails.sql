-- 120_ma_ai_class_guardrails.sql -- live-class guardrails: per-student question cap (6), spacing (20 s), length (600 chars); the automatic section cue is free once per section.
alter table public.ma_ai_attendance add column if not exists questions int not null default 0, add column if not exists last_q_at timestamptz, add column if not exists taught_step int not null default -1, add column if not exists blocked int not null default 0;
create or replace function public.ma_ai_class_turn_gate(p_user uuid, p_course uuid, p_kind text, p_len int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.ma_ai_class%rowtype; a public.ma_ai_attendance%rowtype; gap numeric;
begin
  select * into c from public.ma_ai_class where course_id = p_course and status = 'live';
  if not found then return jsonb_build_object('live', false, 'ok', true); end if;
  if not exists (select 1 from public.ma_enrollment e where e.course_id = p_course and e.user_id = p_user::text and e.status::text = 'active') then return jsonb_build_object('live', false, 'ok', true); end if;
  insert into public.ma_ai_attendance (class_id, course_id, student_id, seconds) values (c.id, p_course, p_user::text, 0) on conflict (class_id, student_id) do nothing;
  select * into a from public.ma_ai_attendance where class_id = c.id and student_id = p_user::text for update;
  if p_kind = 'teach' and a.taught_step < c.step then
    update public.ma_ai_attendance set taught_step = c.step where class_id = c.id and student_id = p_user::text;
    return jsonb_build_object('live', true, 'ok', true);
  end if;
  if coalesce(p_len, 0) > 600 then return jsonb_build_object('live', true, 'ok', false, 'reason', 'too_long'); end if;
  if a.questions >= 6 then
    update public.ma_ai_attendance set blocked = blocked + 1 where class_id = c.id and student_id = p_user::text;
    return jsonb_build_object('live', true, 'ok', false, 'reason', 'limit');
  end if;
  gap := case when a.last_q_at is null then 999 else extract(epoch from now() - a.last_q_at) end;
  if gap < 20 then
    update public.ma_ai_attendance set blocked = blocked + 1 where class_id = c.id and student_id = p_user::text;
    return jsonb_build_object('live', true, 'ok', false, 'reason', 'too_fast', 'retry_after_s', ceil(20 - gap)::int);
  end if;
  update public.ma_ai_attendance set questions = questions + 1, last_q_at = now() where class_id = c.id and student_id = p_user::text;
  return jsonb_build_object('live', true, 'ok', true);
end $$;
revoke all on function public.ma_ai_class_turn_gate(uuid, uuid, text, int) from public, anon, authenticated;
grant execute on function public.ma_ai_class_turn_gate(uuid, uuid, text, int) to service_role;
