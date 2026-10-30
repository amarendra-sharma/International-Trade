-- 109: review walkthrough state for Macroeconomics (same shape as the live im_ai_review_walk). Service role only.
create table if not exists public.ma_ai_review_walk (
  session_id uuid primary key, user_id uuid not null, course_id uuid not null, ref text not null, title text not null,
  missed integer[] not null default '{}', solutions boolean not null default false, updated_at timestamptz not null default now(),
  items jsonb not null default '[]'::jsonb, pos integer not null default 0, score numeric, max_score numeric, scan jsonb);
alter table public.ma_ai_review_walk enable row level security;
revoke all on public.ma_ai_review_walk from public, anon, authenticated;
grant all on public.ma_ai_review_walk to service_role;

create or replace function public.ma_ai_review_walk_set(p_session uuid, p_user uuid, p_course uuid, p_ref text, p_title text, p_items jsonb, p_solutions boolean, p_pos integer, p_score numeric, p_max numeric, p_scan jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into public.ma_ai_review_walk (session_id, user_id, course_id, ref, title, items, solutions, pos, score, max_score, scan, updated_at)
  values (p_session, p_user, p_course, left(p_ref,120), left(p_title,160), p_items, p_solutions, p_pos, p_score, p_max, p_scan, now())
  on conflict (session_id) do update set ref = excluded.ref, title = excluded.title, items = excluded.items, solutions = excluded.solutions, pos = excluded.pos, score = excluded.score, max_score = excluded.max_score, scan = excluded.scan, updated_at = now()
  where public.ma_ai_review_walk.user_id = excluded.user_id;
$$;
create or replace function public.ma_ai_review_walk_get(p_session uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ref', ref, 'title', title, 'items', items, 'solutions', solutions, 'pos', pos, 'score', score, 'max_score', max_score, 'scan', scan)
    from public.ma_ai_review_walk where session_id = p_session and user_id = p_user and updated_at > now() - interval '6 hours';
$$;
create or replace function public.ma_ai_review_walk_pos(p_session uuid, p_user uuid, p_pos integer)
returns void language sql security definer set search_path = public as $$
  update public.ma_ai_review_walk set pos = p_pos, updated_at = now() where session_id = p_session and user_id = p_user;
$$;
revoke all on function public.ma_ai_review_walk_set(uuid,uuid,uuid,text,text,jsonb,boolean,integer,numeric,numeric,jsonb) from public, anon, authenticated;
revoke all on function public.ma_ai_review_walk_get(uuid,uuid) from public, anon, authenticated;
revoke all on function public.ma_ai_review_walk_pos(uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.ma_ai_review_walk_set(uuid,uuid,uuid,text,text,jsonb,boolean,integer,numeric,numeric,jsonb) to service_role;
grant execute on function public.ma_ai_review_walk_get(uuid,uuid) to service_role;
grant execute on function public.ma_ai_review_walk_pos(uuid,uuid,integer) to service_role;
