-- 119_ma_ai_class_student_access.sql -- enrolled students can follow a live class when the 'class' action is on (office hours not required).
create or replace function public.ma_ai_prof_class_current(p_user uuid, p_course uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not (
      (exists (select 1 from public.ma_enrollment e where e.course_id = p_course and e.user_id = p_user::text and e.status::text = 'active')
        and coalesce((select enabled and professor_mode and not prof_paused and coalesce((prof_actions ->> 'class')::boolean, false) from public.ma_ai_settings where course_id = p_course), false))
      or public.ma_ai_student_ok(p_user, p_course) or public.ma_ai_prof_read_ok(p_user, p_course, 'edit_exams') or public.ma_ai_prof_read_ok(p_user, p_course, 'grade')) then jsonb_build_object('live', false)
    else coalesce((select jsonb_build_object('live', true, 'class_id', c.id, 'title', c.title, 'step', c.step, 'sections', jsonb_array_length(c.outline), 'outline', c.outline, 'current', c.outline -> c.step,
        'open_questions', (select count(*) from public.ma_ai_question q where q.class_id = c.id and q.status = 'open'))
      from public.ma_ai_class c where c.course_id = p_course and c.status = 'live'), jsonb_build_object('live', false)) end;
$$;
revoke all on function public.ma_ai_prof_class_current(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ma_ai_prof_class_current(uuid, uuid) to service_role;
