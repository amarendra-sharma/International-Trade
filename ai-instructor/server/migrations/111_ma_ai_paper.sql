-- 111_ma_ai_paper.sql -- Macroeconomics AI Instructor: paper (bubble-sheet) exam review, same rules as Microeconomics (102).
-- Sheetwise is not deployed for Macroeconomics yet, so this creates the minimal tables it will write (ma_paper_sheet, ma_paper_release),
-- shaped exactly like im_paper_sheet / im_paper_release, and teaches ma_ai_review_list / ma_ai_review_get about them.
-- Until a sheet is graded AND released with a window that is open, nothing paper-related is ever listed.
-- A later Sheetwise migration must use "create table if not exists" for these two tables.

create table if not exists public.ma_paper_release (like public.im_paper_release including all);
create table if not exists public.ma_paper_sheet   (like public.im_paper_sheet   including all);
do $$ begin
  begin alter table public.ma_paper_release add constraint ma_paper_release_exam_id_fkey foreign key (exam_id) references public.ma_exam(id) on delete cascade; exception when duplicate_object then null; end;
  begin alter table public.ma_paper_sheet   add constraint ma_paper_sheet_exam_id_fkey   foreign key (exam_id) references public.ma_exam(id) on delete cascade; exception when duplicate_object then null; end;
end $$;
alter table public.ma_paper_release enable row level security;
alter table public.ma_paper_sheet enable row level security;
revoke all on public.ma_paper_release, public.ma_paper_sheet from anon, authenticated;
grant select, insert, update, delete on public.ma_paper_release, public.ma_paper_sheet to service_role;

create or replace function public.ma_ai_paper_open(p_exam uuid, p_now timestamptz)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ma_paper_release r where r.exam_id = p_exam and r.released_at is not null
                   and (r.opens_at is null or r.opens_at <= p_now) and (r.closes_at is null or r.closes_at > p_now));
$$;
revoke all on function public.ma_ai_paper_open(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.ma_ai_paper_open(uuid, timestamptz) to service_role;

-- patch the two review functions in place (idempotent: skipped when already patched)
do $$
declare d text;
begin
  d := pg_get_functiondef('public.ma_ai_review_list(uuid,uuid,timestamptz)'::regprocedure);
  if position('ma_paper_sheet' in d) = 0 then
    d := replace(d, '  with rows as (' || E'\n', '  with rows as (' || E'\n' ||
      $p$    select 'paper:' || s.id as ref, 'paper' as kind, e.title as title, r.closes_at as closes, s.graded_at as at,
           case when jsonb_typeof(s.review -> 'items') = 'array' then jsonb_array_length(s.review -> 'items') else 0 end as n
      from public.ma_paper_sheet s join public.ma_paper_release r on r.exam_id = s.exam_id join public.ma_exam e on e.id = s.exam_id
     where s.student_id = p_user::text and s.course_id = p_course and s.status = 'graded'
       and r.released_at is not null and public.ma_ai_paper_open(s.exam_id, p_now)
    union all
$p$);
    d := replace(d, '''reviewable'', case when kind = ''exam''', '''reviewable'', case when kind = ''paper'' then true when kind = ''exam''');
    d := replace(d, '''reason'', case when kind = ''exam''', '''reason'', case when kind = ''paper'' then null when kind = ''exam''');
    execute d;
  end if;

  d := pg_get_functiondef('public.ma_ai_review_get(uuid,uuid,text,boolean,uuid,timestamptz)'::regprocedure);
  if position('ma_paper_sheet' in d) = 0 then
    d := replace(d, '(exam|asg):', '(paper|exam|asg):');
    d := replace(d, 'e public.ma_exam%rowtype;', 'e public.ma_exam%rowtype; s public.ma_paper_sheet%rowtype; r public.ma_paper_release%rowtype; v_items jsonb; v_title text;');
    d := replace(d, '  if v_kind = ''exam'' then', $p$  if v_kind = 'paper' then
    v_id := v_key::uuid;
    select * into s from public.ma_paper_sheet where id = v_id and student_id = p_user::text and course_id = p_course and status = 'graded';
    if not found then return jsonb_build_object('allowed', false, 'reason', 'not_found'); end if;
    select * into r from public.ma_paper_release where exam_id = s.exam_id;
    if not found or r.released_at is null or not public.ma_ai_paper_open(s.exam_id, p_now) then return jsonb_build_object('allowed', false, 'reason', 'not_released'); end if;
    select title into v_title from public.ma_exam where id = s.exam_id;
    if r.mode = 'score' then v_items := '[]'::jsonb;
    elsif r.mode = 'answers' then
      select coalesce(jsonb_agg(x - 'prompt' - 'options' - 'figure' order by (x ->> 'q')::int), '[]'::jsonb) into v_items from jsonb_array_elements(coalesce(s.review -> 'items', '[]'::jsonb)) x;
    else v_items := coalesce(s.review -> 'items', '[]'::jsonb);
    end if;
    if not p_solutions then
      select coalesce(jsonb_agg(x - 'correct' order by (x ->> 'q')::int), '[]'::jsonb) into v_items from jsonb_array_elements(v_items) x;
    end if;
    res := jsonb_build_object('allowed', true, 'kind', 'paper', 'title', v_title, 'closes_at', r.closes_at, 'solutions_included', p_solutions and r.mode <> 'score',
      'mode', r.mode, 'layout', s.review -> 'layout', 'versions', s.review -> 'versions', 'version', s.review -> 'version', 'score', s.score, 'max_score', s.max_score, 'sheet_id', s.id, 'scan_paths', coalesce(to_jsonb(s.scan_paths), '[]'::jsonb),
      'course_id', p_course, 'exam_id', s.exam_id, 'items', v_items);
  elsif v_kind = 'exam' then$p$);
    execute d;
  end if;
end $$;
