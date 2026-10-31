-- 123: attendance (live-class presence share) joins the final-grade calculation. Applied as a patch of ma_ai_final_calc.
do $$ declare d text; begin
  d := pg_get_functiondef('public.ma_ai_final_calc(uuid,text)'::regprocedure);
  d := replace(d, 'mk record; msc numeric;', 'mk record; msc numeric; att numeric := 0; natt int := 0;');
  d := replace(d, '  select coalesce(late_pct_per_day, 0), coalesce(late_max_days, 0) into lp, ld', E'  select count(*) into natt from public.ma_ai_class where course_id = p_course and scheduled and status = ''ended'';\n  if natt > 0 then\n    select count(*)::numeric / natt into att from public.ma_ai_class k join public.ma_ai_attendance t on t.class_id = k.id and t.student_id = p_student where k.course_id = p_course and k.scheduled and k.status = ''ended'' and t.seconds >= coalesce(c.att_presence_share, 0.5) * k.duration_min * 60;\n  end if;\n  select coalesce(late_pct_per_day, 0), coalesce(late_max_days, 0) into lp, ld');
  d := replace(d, '''w'', coalesce(c.weight_assignments, 0)));', '''w'', coalesce(c.weight_assignments, 0)), jsonb_build_object(''name'', ''Attendance'', ''score'', att, ''w'', case when natt > 0 then coalesce(c.weight_attendance, 0) else 0 end));');
  execute d;
end $$;
