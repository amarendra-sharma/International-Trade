-- 124: syllabus_get returns the full body and the late policy (applied as a patch of the function).
do $$ declare d text; begin
  d := pg_get_functiondef('public.ma_ai_prof_syllabus_get(uuid,uuid)'::regprocedure);
  d := replace(d, 'left(s.body, 5000)', 'left(s.body, 12000)');
  d := replace(d, '''ends_at'', (select ends_at from public.ma_ai_term t where t.course_id = p_course)', '''ends_at'', (select ends_at from public.ma_ai_term t where t.course_id = p_course), ''late_pct_per_day'', (select late_pct_per_day from public.ma_ai_term t where t.course_id = p_course), ''late_max_days'', (select late_max_days from public.ma_ai_term t where t.course_id = p_course)');
  execute d;
end $$;
