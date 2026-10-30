-- 114_ma_ai_roster.sql -- staff-only roster for professor mode (names and ids only, no emails), needed to target a held grade change.
create or replace function public.ma_ai_prof_roster(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.ma_ai_prof_read_ok(p_user, p_course, 'grade') then jsonb_build_object('allowed', false)
    else jsonb_build_object('allowed', true, 'students', coalesce((select jsonb_agg(jsonb_build_object('student_id', e.student_id, 'name', coalesce(nullif(p.full_name, ''), nullif(p.display_name, ''), 'student')) order by p.full_name)
      from public.ma_enrollment e left join public.ma_person p on p.user_id = e.user_id where e.course_id = p_course and e.status::text = 'active'), '[]'::jsonb)) end;
$$;
revoke all on function public.ma_ai_prof_roster(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ma_ai_prof_roster(uuid, uuid) to service_role;
