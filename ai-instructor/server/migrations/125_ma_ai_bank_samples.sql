-- 125: sample bank questions (style reference for assignments), staff only
create or replace function public.ma_ai_prof_bank_samples(p_user uuid, p_course uuid, p_chapter int, p_limit int default 6)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.ma_ai_prof_read_ok(p_user, p_course, 'edit_exams') then jsonb_build_object('allowed', false)
    else jsonb_build_object('allowed', true, 'chapter', p_chapter, 'samples', coalesce((
      select jsonb_agg(jsonb_build_object('type', x.item_type, 'points', x.points, 'topic', x.concept_tag, 'prompt', left(x.prompt, 700)))
        from (select * from public.ma_bank_items b where b.is_active and b.chapter = p_chapter and b.item_type in ('free_response', 'parameterized_numeric') order by random() limit least(greatest(coalesce(p_limit, 6), 1), 10)) x), '[]'::jsonb)) end;
$$;
revoke all on function public.ma_ai_prof_bank_samples(uuid,uuid,int,int) from public, anon, authenticated;
grant execute on function public.ma_ai_prof_bank_samples(uuid,uuid,int,int) to service_role;
