-- 122: term schedule in bulk, late policy, makeup rule, audit export
alter table public.ma_ai_term add column if not exists late_pct_per_day numeric not null default 0, add column if not exists late_max_days int not null default 0;
drop function if exists public.ma_ai_prof_syllabus_save(uuid,uuid,text,text,jsonb,timestamptz,int,boolean,uuid,text);
create or replace function public.ma_ai_prof_syllabus_save(p_user uuid, p_course uuid, p_title text, p_body text, p_weights jsonb, p_ends_at timestamptz, p_hold_hours int, p_announce boolean, p_session uuid default null, p_trigger text default 'professor', p_late_pct numeric default null, p_late_days int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'syllabus'); old public.ma_ai_syllabus%rowtype; c public.ma_course%rowtype; k text; sumw numeric := 0; aid bigint; ann jsonb;
  keys text[] := array['reading','quizzes','arenas','assignments','midterm','final','attendance','capstone'];
begin
  if g is not null then return jsonb_build_object('ok', false, 'reason', g); end if;
  if coalesce(length(trim(p_title)), 0) < 3 or length(p_title) > 160 or coalesce(length(p_body), 0) < 50 or length(p_body) > 12000 then return jsonb_build_object('ok', false, 'reason', 'bad_text'); end if;
  select * into c from public.ma_course where id = p_course;
  if p_weights is not null then
    if jsonb_typeof(p_weights) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'bad_weights'); end if;
    foreach k in array keys loop
      if p_weights ? k then
        if (p_weights ->> k)::numeric < 0 or (p_weights ->> k)::numeric > 1 then return jsonb_build_object('ok', false, 'reason', 'bad_weights'); end if;
        sumw := sumw + (p_weights ->> k)::numeric;
      end if;
    end loop;
    if abs(sumw - 1) > 0.011 then return jsonb_build_object('ok', false, 'reason', 'weights_must_sum_to_1', 'sum', sumw); end if;
  end if;
  if p_late_pct is not null and (p_late_pct < 0 or p_late_pct > 100 or p_late_days is null or p_late_days not between 0 and 30) then return jsonb_build_object('ok', false, 'reason', 'bad_late'); end if;
  if p_ends_at is not null and (p_hold_hours is null or p_hold_hours not between 1 and 168) then return jsonb_build_object('ok', false, 'reason', 'bad_hold'); end if;
  select * into old from public.ma_ai_syllabus where course_id = p_course;
  insert into public.ma_ai_syllabus (course_id, title, body, updated_at) values (p_course, trim(p_title), p_body, now())
    on conflict (course_id) do update set title = excluded.title, body = excluded.body, updated_at = now();
  if p_weights is not null then
    update public.ma_course set weight_reading = coalesce((p_weights ->> 'reading')::numeric, 0), weight_quizzes = coalesce((p_weights ->> 'quizzes')::numeric, 0), weight_arenas = coalesce((p_weights ->> 'arenas')::numeric, 0),
      weight_assignments = coalesce((p_weights ->> 'assignments')::numeric, 0), weight_midterm = coalesce((p_weights ->> 'midterm')::numeric, 0), weight_final = coalesce((p_weights ->> 'final')::numeric, 0),
      weight_attendance = coalesce((p_weights ->> 'attendance')::numeric, 0), weight_capstone = coalesce((p_weights ->> 'capstone')::numeric, 0) where id = p_course;
  end if;
  if p_ends_at is not null then
    insert into public.ma_ai_term (course_id, ends_at, hold_hours, auto_final) values (p_course, p_ends_at, p_hold_hours, true)
      on conflict (course_id) do update set ends_at = excluded.ends_at, hold_hours = excluded.hold_hours, final_queued_at = case when excluded.ends_at > now() then null else public.ma_ai_term.final_queued_at end;
  end if;
  if p_late_pct is not null then
    insert into public.ma_ai_term (course_id, ends_at, hold_hours, late_pct_per_day, late_max_days) values (p_course, coalesce(p_ends_at, now() + interval '90 days'), coalesce(p_hold_hours, 48), p_late_pct, p_late_days)
      on conflict (course_id) do update set late_pct_per_day = excluded.late_pct_per_day, late_max_days = excluded.late_max_days;
  end if;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'syllabus_save', 'syllabus:' || p_course, jsonb_build_object('title', trim(p_title), 'ends_at', p_ends_at),
    jsonb_build_object('had', old.course_id is not null, 'title', old.title, 'body', old.body, 'weights', case when p_weights is null then null else jsonb_build_object('reading', c.weight_reading, 'quizzes', c.weight_quizzes, 'arenas', c.weight_arenas, 'assignments', c.weight_assignments, 'midterm', c.weight_midterm, 'final', c.weight_final, 'attendance', c.weight_attendance, 'capstone', c.weight_capstone) end),
    null, p_session);
  if coalesce(p_announce, true) then
    ann := public.ma_ai_prof_announce(p_user, p_course, 'Syllabus: ' || trim(p_title), left(p_body, 3900), p_session, p_trigger);
  end if;
  return jsonb_build_object('ok', true, 'action_id', aid, 'announced', coalesce((ann ->> 'ok')::boolean, false), 'announce_reason', ann ->> 'reason');
end $$;


create or replace function public.ma_ai_prof_term_schedule(p_user uuid, p_course uuid, p_quizzes jsonb, p_arenas jsonb, p_assignments jsonb, p_session uuid default null, p_trigger text default 'professor')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g1 text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'deadline'); g2 text := public.ma_ai_prof_gate(p_user, p_course, 'edit_exams', 'assignment'); x jsonb; qold jsonb := '[]'::jsonb; aold jsonb := '[]'::jsonb; qnew jsonb := '[]'::jsonb; anew jsonb := '[]'::jsonb;
  ids jsonb := '[]'::jsonb; o timestamptz; aid bigint; nid uuid; nq int := 0; na int := 0; ns int := 0;
begin
  if g1 is not null then return jsonb_build_object('ok', false, 'reason', g1); end if;
  p_quizzes := coalesce(p_quizzes, '[]'::jsonb); p_arenas := coalesce(p_arenas, '[]'::jsonb); p_assignments := coalesce(p_assignments, '[]'::jsonb);
  if jsonb_typeof(p_quizzes) <> 'array' or jsonb_typeof(p_arenas) <> 'array' or jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_quizzes) > 40 or jsonb_array_length(p_arenas) > 40 or jsonb_array_length(p_assignments) > 25 then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  if jsonb_array_length(p_assignments) > 0 and g2 is not null then return jsonb_build_object('ok', false, 'reason', g2); end if;
  for x in select * from jsonb_array_elements(p_quizzes) loop
    if (x ->> 'chapter')::int not between 1 and 60 or (x ->> 'closes_at') is null then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  end loop;
  for x in select * from jsonb_array_elements(p_arenas) loop
    if coalesce(x ->> 'slug', '') !~ '^[a-z0-9_-]{2,60}$' or (x ->> 'closes_at') is null then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  end loop;
  for x in select * from jsonb_array_elements(p_assignments) loop
    if coalesce(length(trim(x ->> 'title')), 0) < 3 or length(x ->> 'title') > 160 or coalesce(length(x ->> 'instructions'), 0) < 10 or length(x ->> 'instructions') > 6000 or (x ->> 'points')::numeric not between 1 and 1000 or (x ->> 'due_at') is null then return jsonb_build_object('ok', false, 'reason', 'bad_text'); end if;
  end loop;
  for x in select * from jsonb_array_elements(p_quizzes) loop
    select closes_at into o from public.ma_quiz_deadline where course_id = p_course and chapter = (x ->> 'chapter')::int;
    if found then qold := qold || jsonb_build_object('key', x ->> 'chapter', 'closes_at', o); else qnew := qnew || to_jsonb((x ->> 'chapter')::int); end if;
    insert into public.ma_quiz_deadline (course_id, chapter, closes_at, updated_at) values (p_course, (x ->> 'chapter')::int, (x ->> 'closes_at')::timestamptz, now())
      on conflict (course_id, chapter) do update set closes_at = excluded.closes_at, updated_at = now();
    nq := nq + 1;
  end loop;
  for x in select * from jsonb_array_elements(p_arenas) loop
    select closes_at into o from public.ma_arena_deadline where course_id = p_course and arena_slug = x ->> 'slug';
    if found then aold := aold || jsonb_build_object('key', x ->> 'slug', 'closes_at', o); else anew := anew || to_jsonb(x ->> 'slug'); end if;
    insert into public.ma_arena_deadline (course_id, arena_slug, closes_at, updated_at) values (p_course, x ->> 'slug', (x ->> 'closes_at')::timestamptz, now())
      on conflict (course_id, arena_slug) do update set closes_at = excluded.closes_at, updated_at = now();
    na := na + 1;
  end loop;
  for x in select * from jsonb_array_elements(p_assignments) loop
    insert into public.ma_assignment (course_id, title, instructions, points, due_at, is_published, created_by) values (p_course, trim(x ->> 'title'), x ->> 'instructions', (x ->> 'points')::numeric, (x ->> 'due_at')::timestamptz, true, 'asha:' || p_user::text) returning id into nid;
    ids := ids || to_jsonb(nid); ns := ns + 1;
  end loop;
  aid := public.ma_ai_prof_log(p_course, p_user, p_trigger, 'term_schedule', 'course:' || p_course, jsonb_build_object('quizzes', nq, 'arenas', na, 'assignments', ns),
    jsonb_build_object('quiz_old', qold, 'quiz_new', qnew, 'arena_old', aold, 'arena_new', anew), jsonb_build_object('assignment_ids', ids), p_session);
  return jsonb_build_object('ok', true, 'action_id', aid, 'quizzes', nq, 'arenas', na, 'assignments', ns);
end $$;

create or replace function public.ma_ai_prof_audit_export(p_user uuid, p_course uuid, p_days int default 120)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.ma_ai_prof_read_ok(p_user, p_course, 'edit_exams') then jsonb_build_object('allowed', false)
    else jsonb_build_object('allowed', true, 'actions', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'at', a.created_at, 'by', a.trigger, 'action', a.action, 'target', a.target, 'status', a.status, 'params', a.params) order by a.id desc)
      from public.ma_ai_actions a where a.course_id = p_course and a.created_at > now() - make_interval(days => least(greatest(p_days, 1), 400))), '[]'::jsonb)) end;
$$;

create or replace function public.ma_ai_final_calc(p_course uuid, p_student text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.ma_course%rowtype; nch int; nar int; reading numeric := 0; quizzes numeric := 0; arenas numeric := 0; assigns numeric := 0; comps jsonb := '[]'::jsonb; wsum numeric := 0; tot numeric := 0; e record; sc numeric; poss numeric; got numeric; w numeric; ntasg int; lp numeric := 0; ld int := 0; mk record; msc numeric;
begin
  select * into c from public.ma_course where id = p_course;
  select count(*) into nch from public.ma_quiz_deadline where course_id = p_course;
  select count(*) into nar from public.ma_arena_deadline where course_id = p_course;
  if nch > 0 then
    select coalesce(count(*) filter (where reading_done), 0)::numeric / nch, coalesce(sum(least(1, greatest(0, coalesce(quiz_score, 0)))), 0) / nch into reading, quizzes
      from public.ma_chapter_progress where course_id = p_course and student_id = p_student and chapter in (select chapter from public.ma_quiz_deadline where course_id = p_course);
  end if;
  if nar > 0 then
    select coalesce(sum(best), 0) / nar into arenas from (select max(case when r.pct > 1 then r.pct / 100 else r.pct end) best from public.ma_arena_attempt_rollup r
      where r.course_id = p_course and r.user_id = p_student and r.arena_slug in (select arena_slug from public.ma_arena_deadline where course_id = p_course) group by r.arena_slug) q;
  end if;
  select coalesce(late_pct_per_day, 0), coalesce(late_max_days, 0) into lp, ld from public.ma_ai_term where course_id = p_course;
  select count(*) into ntasg from public.ma_assignment where course_id = p_course and is_published;
  if ntasg > 0 then
    select coalesce(sum(least(1, greatest(0, s.score / nullif(a.points, 0))) * case
        when s.submitted_at is null or a.due_at is null or s.submitted_at <= a.due_at then 1
        when ceil(extract(epoch from s.submitted_at - a.due_at) / 86400) > ld then 0
        else greatest(0, 1 - lp / 100 * ceil(extract(epoch from s.submitted_at - a.due_at) / 86400)) end), 0) / ntasg into assigns
      from public.ma_assignment a left join public.ma_submission s on s.assignment_id = a.id and s.student_id = p_student where a.course_id = p_course and a.is_published;
  end if;
  comps := comps || jsonb_build_array(jsonb_build_object('name', 'Reading', 'score', reading, 'w', coalesce(c.weight_reading, 0)), jsonb_build_object('name', 'Quizzes', 'score', quizzes, 'w', coalesce(c.weight_quizzes, 0)),
    jsonb_build_object('name', 'Arenas', 'score', arenas, 'w', coalesce(c.weight_arenas, 0)), jsonb_build_object('name', 'Assignments', 'score', assigns, 'w', coalesce(c.weight_assignments, 0)));
  for e in select * from public.ma_exam where course_id = p_course and is_published and kind::text in ('midterm', 'final', 'exam') and title !~* '^makeup' order by (kind::text = 'final'), closes_at loop
    w := coalesce(e.weight, case when e.kind::text = 'final' then c.weight_final else c.weight_midterm end, 0);
    select coalesce(sum(best), 0), coalesce(sum(pt), 0) into got, poss from (select max(coalesce(a.points_earned, 0)) best, coalesce(max(a.points_possible), 0) pt
      from public.ma_exam_attempt a where a.exam_id = e.id and a.student_id = p_student and a.graded_at is not null group by a.item_id) z;
    sc := case when poss > 0 then least(1, got / poss) else 0 end;
    -- a makeup exam ("Makeup <title>") replaces the score only if it is better
    for mk in select x.id from public.ma_exam x where x.course_id = p_course and x.is_published and x.title ~* '^makeup' and lower(x.title) like '%' || lower(e.title) || '%' loop
      select coalesce(sum(best), 0) / nullif(sum(pt), 0) into msc from (select max(coalesce(a.points_earned, 0)) best, coalesce(max(a.points_possible), 0) pt
        from public.ma_exam_attempt a where a.exam_id = mk.id and a.student_id = p_student and a.graded_at is not null group by a.item_id) z;
      if msc is not null and msc > sc then sc := least(1, msc); end if;
    end loop;
    comps := comps || jsonb_build_array(jsonb_build_object('name', e.title, 'score', sc, 'w', w));
  end loop;
  select coalesce(sum((x ->> 'w')::numeric), 0), coalesce(sum((x ->> 'score')::numeric * (x ->> 'w')::numeric), 0) into wsum, tot from jsonb_array_elements(comps) x where (x ->> 'w')::numeric > 0;
  return jsonb_build_object('pct', case when wsum > 0 then round(tot / wsum * 100, 2) else 0 end, 'comps', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(comps) x where (x ->> 'w')::numeric > 0));
end $$;

create or replace function public.ma_ai_prof_undo(p_user uuid, p_course uuid, p_action bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.ma_ai_actions%rowtype; cap text; w jsonb; s jsonb; pids bigint[];
begin
  select * into a from public.ma_ai_actions where id = p_action and course_id = p_course;
  if not found or a.action not in ('syllabus_save', 'lectures_plan', 'exam_create', 'final_grades_queued', 'term_schedule') then return public.ma_ai_prof_undo_base(p_user, p_course, p_action); end if;
  cap := case when a.action = 'final_grades_queued' then 'grade' else 'edit_exams' end;
  if not public.ma_ai_prof_can(p_user, p_course, cap) then return jsonb_build_object('ok', false, 'reason', 'not_staff'); end if;
  if a.status <> 'done' then return jsonb_build_object('ok', false, 'reason', 'not_undoable'); end if;
  if a.action = 'syllabus_save' then
    if (a.before ->> 'had')::boolean then update public.ma_ai_syllabus set title = a.before ->> 'title', body = a.before ->> 'body', updated_at = now() where course_id = p_course; else delete from public.ma_ai_syllabus where course_id = p_course; end if;
    w := a.before -> 'weights';
    if w is not null and jsonb_typeof(w) = 'object' then
      update public.ma_course set weight_reading = (w ->> 'reading')::numeric, weight_quizzes = (w ->> 'quizzes')::numeric, weight_arenas = (w ->> 'arenas')::numeric, weight_assignments = (w ->> 'assignments')::numeric,
        weight_midterm = (w ->> 'midterm')::numeric, weight_final = (w ->> 'final')::numeric, weight_attendance = (w ->> 'attendance')::numeric, weight_capstone = (w ->> 'capstone')::numeric where id = p_course;
    end if;
  elsif a.action = 'lectures_plan' then
    delete from public.ma_ai_class_session where course_id = p_course and status = 'planned';
    insert into public.ma_ai_class_session (course_id, seq, title, outline, starts_at, duration_min)
      select p_course, (x ->> 'seq')::int, x ->> 'title', x -> 'outline', (x ->> 'starts_at')::timestamptz, (x ->> 'duration_min')::int from jsonb_array_elements(coalesce(a.before -> 'sessions', '[]'::jsonb)) x;
  elsif a.action = 'term_schedule' then
    if exists (select 1 from public.ma_submission where assignment_id in (select (jsonb_array_elements_text(a.after -> 'assignment_ids'))::uuid)) then return jsonb_build_object('ok', false, 'reason', 'not_undoable'); end if;
    delete from public.ma_assignment where course_id = p_course and id in (select (jsonb_array_elements_text(a.after -> 'assignment_ids'))::uuid);
    delete from public.ma_quiz_deadline where course_id = p_course and chapter in (select (jsonb_array_elements_text(a.before -> 'quiz_new'))::int);
    delete from public.ma_arena_deadline where course_id = p_course and arena_slug in (select jsonb_array_elements_text(a.before -> 'arena_new'));
    update public.ma_quiz_deadline q set closes_at = (x ->> 'closes_at')::timestamptz from jsonb_array_elements(coalesce(a.before -> 'quiz_old', '[]'::jsonb)) x where q.course_id = p_course and q.chapter = (x ->> 'key')::int;
    update public.ma_arena_deadline q set closes_at = (x ->> 'closes_at')::timestamptz from jsonb_array_elements(coalesce(a.before -> 'arena_old', '[]'::jsonb)) x where q.course_id = p_course and q.arena_slug = x ->> 'key';
  elsif a.action = 'exam_create' then
    if exists (select 1 from public.ma_exam_attempt where exam_id = (a.after ->> 'id')::uuid) then return jsonb_build_object('ok', false, 'reason', 'not_undoable'); end if;
    delete from public.ma_exam where id = (a.after ->> 'id')::uuid and course_id = p_course;
  else
    select array(select (jsonb_array_elements_text(a.after -> 'pending_ids'))::bigint) into pids;
    update public.ma_ai_pending set status = 'cancelled', resolved_at = now() where id = any(pids) and status = 'pending';
  end if;
  update public.ma_ai_actions set status = 'undone', undone_at = now() where id = p_action;
  return jsonb_build_object('ok', true);
end $$;

do $$ declare f text; begin
  foreach f in array array['ma_ai_prof_syllabus_save(uuid,uuid,text,text,jsonb,timestamptz,int,boolean,uuid,text,numeric,int)','ma_ai_prof_term_schedule(uuid,uuid,jsonb,jsonb,jsonb,uuid,text)','ma_ai_prof_audit_export(uuid,uuid,int)','ma_ai_final_calc(uuid,text)','ma_ai_prof_undo(uuid,uuid,bigint)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
