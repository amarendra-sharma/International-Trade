-- it_30_self_study: paid per-student self-study with Asha for International Trade (same design as fd_09..fd_13).
-- Additive: new columns/tables/functions; the free "Self-Study" courses students created for themselves are left as they are.

-- ===== schema =====
alter table public.it_courses add column if not exists is_self_study boolean not null default false;
alter table public.it_platform_settings add column if not exists ai_key_owner uuid;
alter table public.it_materials add column if not exists body text;

create or replace function public.it_ss_is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from it_profiles p where p.id = auth.uid() and p.role = 'admin')
$$;
create or replace function public.it__h(t text) returns text language sql immutable as $$
  select replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

create table if not exists public.it_selfstudy_section (chapter int not null, sec int not null, title text not null, primary key (chapter, sec));
alter table public.it_selfstudy_section enable row level security;
drop policy if exists it_selfstudy_section_read on public.it_selfstudy_section;
create policy it_selfstudy_section_read on public.it_selfstudy_section for select using (true);
grant select on public.it_selfstudy_section to anon, authenticated;
delete from public.it_selfstudy_section;
insert into public.it_selfstudy_section (chapter, sec, title) values
(1, 1, 'A short history of trade thought'),
(1, 2, 'The scale of world trade'),
(1, 3, 'Production possibilities and opportunity cost'),
(1, 4, 'Absolute advantage is not the answer'),
(1, 5, 'Comparative advantage'),
(1, 6, 'The gains from trade'),
(1, 7, 'Where does comparative advantage come from?'),
(1, 8, 'Three fallacies about trade'),
(2, 1, 'A one-factor economy'),
(2, 2, 'Prices, wages, and production in autarky'),
(2, 3, 'World relative supply and demand'),
(2, 4, 'Relative wages'),
(2, 5, 'Money wages, exchange rates, and who exports what'),
(2, 6, 'Many goods: the chain of comparative advantage'),
(2, 7, 'Many countries'),
(2, 8, 'Measuring the gains from trade'),
(2, 9, 'Productivity and wages in the data'),
(2, 10, 'Testing the Ricardian prediction'),
(2, 11, 'Many goods: the Dornbusch–Fischer–Samuelson model'),
(3, 1, 'Mobile and specific factors'),
(3, 2, 'The allocation of labor'),
(3, 3, 'How a price change redistributes income'),
(3, 4, 'Trade, winners, and losers'),
(3, 5, 'Gains from trade despite the losers'),
(3, 6, 'Adjustment in the data'),
(4, 1, 'Factor intensity and factor abundance'),
(4, 2, 'The Heckscher–Ohlin theorem'),
(4, 3, 'Trade and the Stolper–Samuelson theorem'),
(4, 4, 'The Rybczynski theorem'),
(4, 5, 'Factor price equalization'),
(4, 6, 'Endowments and exports in the data'),
(4, 7, 'The Leontief paradox and after'),
(4, 8, 'When the assumptions break down'),
(5, 1, 'Production, prices, and relative supply'),
(5, 2, 'Relative demand and the terms of trade'),
(5, 3, 'The terms of trade and national welfare'),
(5, 4, 'Decomposing the gains from trade: consumption and production gains'),
(5, 5, 'Where the gains come from: two pure cases'),
(5, 6, 'Economic growth and the terms of trade'),
(5, 7, 'Tariffs, subsidies, and the terms of trade'),
(5, 8, 'Terms of trade in the data'),
(5, 9, 'Offer curves and reciprocal demand'),
(6, 1, 'Internal and external economies of scale'),
(6, 2, 'Monopolistic competition'),
(6, 3, 'Trade in the model: variety and scale'),
(6, 4, 'Intra-industry trade and how to measure it'),
(6, 5, 'External economies, history, and lock-in'),
(6, 6, 'From varieties to the gravity equation'),
(7, 1, 'The Melitz model: heterogeneity and cutoffs'),
(7, 2, 'Trade liberalization as natural selection'),
(7, 3, 'Multinationals: the proximity–concentration tradeoff'),
(7, 4, 'The gravity equation'),
(7, 5, 'Multinationals in the data'),
(8, 1, 'The tariff diagram for a small country'),
(8, 2, 'The large country and the terms-of-trade argument'),
(8, 3, 'Effective protection'),
(8, 4, 'Quotas, subsidies, and voluntary restraints'),
(8, 5, 'Tariffs in the data'),
(9, 1, 'Arguments for protection: the honest list'),
(9, 2, 'The theory of the second best'),
(9, 3, 'Concentrated benefits, diffuse costs'),
(9, 4, 'Protection for sale'),
(10, 1, 'Offer curves and the optimal tariff, geometrically'),
(10, 2, 'Retaliation and the trade-war dilemma'),
(10, 3, 'Strategic trade policy: the Brander–Spencer temptation'),
(11, 1, 'The GATT/WTO architecture'),
(11, 2, 'Preferential agreements: creation versus diversion'),
(11, 3, 'FTAs, customs unions, and rules of origin'),
(11, 4, 'Multilateralism, regionalism, and the system under strain'),
(12, 1, 'Nominal and real exchange rates'),
(12, 2, 'Does depreciation improve the trade balance? Marshall–Lerner'),
(12, 3, 'The J-curve'),
(12, 4, 'Currency manipulation and devaluation as trade policy'),
(12, 5, 'Exchange rates in the data'),
(13, 1, 'The Prebisch–Singer hypothesis'),
(13, 2, 'Two strategies: inward and outward'),
(13, 3, 'Global value chains'),
(13, 4, 'Two shocks: China and the pandemic'),
(14, 1, 'Solving the Ricardian model'),
(14, 2, 'Tariff algebra and the optimal tariff'),
(14, 3, 'Index-number toolkit'),
(14, 4, 'Estimating gravity'),
(14, 5, 'A capstone worked problem');

create table if not exists public.it_selfstudy_plan (
  course_id uuid primary key references public.it_courses(id) on delete cascade,
  student_id uuid not null unique,
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment','awaiting_setup','active','completed','cancelled')),
  weeks int, days int[], start_local time, minutes int, tz text, starts_on date, ends_at timestamptz, classes int,
  midterm_id uuid, final_id uuid,
  created_at timestamptz not null default now(), paid_at timestamptz, configured_at timestamptz, paid_by text
);
alter table public.it_selfstudy_plan enable row level security;
drop policy if exists it_selfstudy_plan_read on public.it_selfstudy_plan;
create policy it_selfstudy_plan_read on public.it_selfstudy_plan for select using (student_id = auth.uid() or it_ss_is_admin());
revoke insert, update, delete, truncate on public.it_selfstudy_plan from anon, authenticated;
grant select on public.it_selfstudy_plan to authenticated;

-- Integrity records of camera-proctored self-study quizzes (it_proctor_events only takes exam ids).
create table if not exists public.it_ss_proctor_events (
  exam_id text not null,
  course_id uuid references public.it_courses(id) on delete cascade,
  student_id uuid not null,
  violations int not null default 0,
  events text,
  updated_at timestamptz not null default now(),
  primary key (exam_id, student_id)
);
alter table public.it_ss_proctor_events enable row level security;
drop policy if exists it_ssp_ins on public.it_ss_proctor_events;
create policy it_ssp_ins on public.it_ss_proctor_events for insert with check (student_id = auth.uid());
drop policy if exists it_ssp_upd on public.it_ss_proctor_events;
create policy it_ssp_upd on public.it_ss_proctor_events for update using (student_id = auth.uid()) with check (student_id = auth.uid());
drop policy if exists it_ssp_sel on public.it_ss_proctor_events;
create policy it_ssp_sel on public.it_ss_proctor_events for select using (student_id = auth.uid() or it_ss_is_admin());
drop policy if exists it_ssp_del on public.it_ss_proctor_events;
create policy it_ssp_del on public.it_ss_proctor_events for delete using (it_ss_is_admin());
grant select, insert, update, delete on public.it_ss_proctor_events to authenticated;
-- Snapshots of those quizzes live under quiz-ch<N>-<course>/<student>/...: readable by an administrator.
drop policy if exists it_ss_quiz_snap_read on storage.objects;
create policy it_ss_quiz_snap_read on storage.objects for select using (
  bucket_id = 'proctor-snapshots' and (storage.foldername(name))[1] ~ '^quiz-ch[0-9]+-' and it_ss_is_admin()
  and exists (select 1 from it_courses c where c.is_self_study and c.id::text = regexp_replace((storage.foldername(name))[1], '^quiz-ch[0-9]+-', '')));

-- The notify email is kept out of the publicly readable settings row.
create table if not exists public.it_platform_private (id int primary key default 1 check (id = 1), notify_email text, updated_at timestamptz not null default now(), updated_by uuid);
alter table public.it_platform_private enable row level security;
drop policy if exists it_platform_private_admin on public.it_platform_private;
create policy it_platform_private_admin on public.it_platform_private for all using (it_ss_is_admin()) with check (it_ss_is_admin());
revoke all on public.it_platform_private from anon;
grant select, insert, update on public.it_platform_private to authenticated;
insert into public.it_platform_private (id, notify_email)
select 1, notify_email from public.it_platform_settings where notify_email is not null and notify_email <> '' order by id limit 1
on conflict (id) do update set notify_email = excluded.notify_email, updated_at = now();
create or replace function public.it__platform_setting_hide_email() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.notify_email is not null then
    if new.notify_email <> '' then
      insert into it_platform_private (id, notify_email, updated_at, updated_by) values (1, new.notify_email, now(), new.updated_by)
      on conflict (id) do update set notify_email = excluded.notify_email, updated_at = now(), updated_by = excluded.updated_by;
    end if;
    new.notify_email := null;
  end if;
  return new;
end $$;
drop trigger if exists it_platform_setting_hide_email on public.it_platform_settings;
create trigger it_platform_setting_hide_email before insert or update on public.it_platform_settings for each row execute function public.it__platform_setting_hide_email();
update public.it_platform_settings set notify_email = null where notify_email is not null;

-- Only an administrator (or the self-study RPC) may mark a course self-study.
create or replace function public.it_course_ss_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce(current_setting('it.selfstudy', true), '') = '1' or it_ss_is_admin() then return new; end if;
  if tg_op = 'INSERT' then new.is_self_study := false;
  elsif new.is_self_study is distinct from old.is_self_study then new.is_self_study := old.is_self_study; end if;
  return new;
end $$;
drop trigger if exists it_course_ss_guard on public.it_courses;
create trigger it_course_ss_guard before insert or update on public.it_courses for each row execute function public.it_course_ss_guard();

-- ===== functions =====
create or replace function public.it__selfstudy_owner() returns uuid language sql stable security definer set search_path = public as $$
  select p.id from it_profiles p where p.role = 'admin' order by p.created_at, p.id limit 1
$$;

create or replace function public.it__selfstudy_status(p_student uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare pl it_selfstudy_plan; nxt record; ps it_platform_settings;
begin
  select * into ps from it_platform_settings order by id limit 1;
  select * into pl from it_selfstudy_plan where student_id = p_student;
  if not found then
    return jsonb_build_object('status', 'none', 'enabled', coalesce(ps.self_study_enabled, false), 'price_cents', ps.price_cents, 'currency', ps.currency);
  end if;
  select s.title, s.starts_at, s.duration_min into nxt from it_ai_class_session s
   where s.course_id = pl.course_id and s.status in ('planned','live') and s.starts_at + make_interval(mins => s.duration_min) > now() order by s.starts_at limit 1;
  return jsonb_build_object('status', pl.status, 'enabled', coalesce(ps.self_study_enabled, false), 'course_id', pl.course_id,
    'enrollment', (select status from it_enrollments where course_id = pl.course_id and student_id = p_student),
    'price_cents', ps.price_cents, 'currency', ps.currency, 'weeks', pl.weeks, 'days', to_jsonb(pl.days), 'start_local', to_char(pl.start_local, 'HH24:MI'),
    'minutes', pl.minutes, 'tz', pl.tz, 'starts_on', pl.starts_on, 'ends_at', pl.ends_at, 'classes', pl.classes,
    'next_title', nxt.title, 'next_at', nxt.starts_at, 'next_minutes', nxt.duration_min,
    'started', exists (select 1 from it_ai_class_session s where s.course_id = pl.course_id and s.status <> 'planned'),
    'midterm', (select jsonb_build_object('opens', opens_at, 'closes', closes_at) from it_exams where id = pl.midterm_id),
    'final', (select jsonb_build_object('opens', opens_at, 'closes', closes_at) from it_exams where id = pl.final_id));
end $$;

create or replace function public.it_selfstudy_status() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then return jsonb_build_object('status', 'signed_out'); end if;
  return it__selfstudy_status(auth.uid());
end $$;

-- Paid (Stripe link carrying client_reference_id = student__course), fee waiver, or comped by the administrator.
create or replace function public.it__selfstudy_activate(p_student uuid, p_comp boolean default false) returns boolean language plpgsql security definer set search_path = public as $$
declare pl it_selfstudy_plan; pay text;
begin
  select * into pl from it_selfstudy_plan where student_id = p_student and status = 'awaiting_payment';
  if not found then return false; end if;
  if p_comp then pay := 'admin';
  elsif exists (select 1 from it_fee_waivers w where w.course_id = pl.course_id and (w.student_id is null or w.student_id = p_student)) then pay := 'waiver';
  else
    select m.id into pay from mp_payments m
     where m.client_reference_id = p_student::text || '__' || pl.course_id::text and m.amount_cents - coalesce(m.refunded_cents, 0) > 0
     order by m.created_at_stripe desc limit 1;
  end if;
  if pay is null then return false; end if;
  insert into it_enrollments (course_id, student_id, status) values (pl.course_id, p_student, 'active')
    on conflict (course_id, student_id) do update set status = 'active';
  insert into it_subscriptions (student_id, course_id, status, source, started_at) values (p_student, pl.course_id, 'active', 'self_study', now())
    on conflict (student_id, course_id) do update set status = 'active', source = 'self_study', started_at = coalesce(it_subscriptions.started_at, now());
  update it_selfstudy_plan set status = 'awaiting_setup', paid_at = now(), paid_by = pay where course_id = pl.course_id;
  return true;
end $$;

create or replace function public.it_selfstudy_check_payment() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'reason', 'signed_out'); end if;
  perform it__selfstudy_activate(auth.uid());
  return it__selfstudy_status(auth.uid());
end $$;

create or replace function public.it_selfstudy_start() returns jsonb language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); owner uuid; cid uuid; ps it_platform_settings;
begin
  if u is null then return jsonb_build_object('ok', false, 'reason', 'signed_out'); end if;
  if exists (select 1 from it_selfstudy_plan where student_id = u) then return it__selfstudy_status(u); end if;
  select * into ps from it_platform_settings order by id limit 1;
  if not coalesce(ps.self_study_enabled, false) then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;
  if exists (select 1 from it_profiles p where p.id = u and p.role in ('instructor', 'admin')) then return jsonb_build_object('ok', false, 'reason', 'staff'); end if;
  owner := it__selfstudy_owner();
  if owner is null then return jsonb_build_object('ok', false, 'reason', 'no_admin'); end if;
  insert into it_profiles (id, email, full_name, role) select u, coalesce(au.email, ''), coalesce(au.raw_user_meta_data ->> 'full_name', ''), 'student' from auth.users au where au.id = u on conflict (id) do nothing;
  perform set_config('it.selfstudy', '1', true);
  insert into it_courses (owner_id, title, term, description, requires_payment, is_self_study, weight_reading, weight_quizzes, weight_arenas, weight_midterm, weight_final, required_arenas)
  values (owner, 'International Trade — Self-Study', 'Self-study with Asha', 'A private self-study section taught by Asha, the AI professor, on the schedule the student chose.',
          true, true, 0.05, 0.25, 0.20, 0.20, 0.30, 13)
  returning id into cid;
  perform set_config('it.selfstudy', '', true);
  insert into it_selfstudy_plan (course_id, student_id) values (cid, u);
  insert into it_ai_settings (course_id, enabled, professor_mode, prof_paused, payer, review_enabled, course_monthly_usd)
  values (cid, true, true, true, 'platform', true, 10) on conflict (course_id) do update set enabled = true, professor_mode = true, prof_paused = true, payer = 'platform', review_enabled = true, course_monthly_usd = 10;
  insert into it_ai_course_sources (course_id, source_id, max_chapter) values (cid, 'it-textbook', null) on conflict do nothing;
  perform it__selfstudy_activate(u);
  return it__selfstudy_status(u);
end $$;

create or replace function public.it__selfstudy_post_syllabus(p_course uuid) returns void language plpgsql security definer set search_path = public as $$
declare pl it_selfstudy_plan; owner uuid; tz text; html text; rows text := ''; r record; ex record; dn text;
begin
  select * into pl from it_selfstudy_plan where course_id = p_course;
  if not found or pl.status <> 'active' then return; end if;
  tz := coalesce(pl.tz, 'UTC');
  owner := (select owner_id from it_courses where id = p_course);
  dn := (select string_agg((array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])[x + 1], ', ' order by x) from unnest(pl.days) x);
  html := '<h1>International Trade &mdash; Self-Study Syllabus</h1>'
    || '<p><b>Instructor:</b> Asha, AI professor &nbsp;&middot;&nbsp; <b>Term:</b> '
    || to_char(pl.starts_on, 'FMMonth DD, YYYY') || ' &ndash; ' || to_char(pl.ends_at at time zone tz, 'FMMonth DD, YYYY') || ' (' || pl.weeks || ' weeks)</p>'
    || '<p><b>Live classes:</b> ' || pl.classes || ' classes, ' || dn || ' at ' || to_char(pl.start_local, 'HH24:MI') || ' (' || it__h(tz) || '), '
    || pl.minutes || ' minutes each. All times in this syllabus are ' || it__h(tz) || '.</p>'
    || '<h2>About the course</h2>'
    || '<p>This course is a full introduction to international trade: why nations trade, the Ricardian, specific-factors and Heckscher&ndash;Ohlin models, the standard trade model, scale economies and firms in the global economy, tariffs and the political economy of protection, trade wars and trade agreements, exchange rates, trade and development, and quantitative trade models. It follows the 14 chapters of the course textbook in order.</p>'
    || '<h2>How the course works</h2><ul>'
    || '<li>Read the chapter before its class. Asha teaches each class live at the scheduled time; open the <i>AI Instructor</i> at class time to join.</li>'
    || '<li>Ask Asha questions at any time between classes.</li>'
    || '<li>Each chapter has a graded quiz and an arena. Both are due three days after the class that finishes the chapter.</li>'
    || '<li>There is a midterm and a final exam, each open for a window of several days. You take each once.</li></ul>';
  for r in select seq, title, starts_at from it_ai_class_session where course_id = p_course order by seq loop
    rows := rows || '<tr><td>' || r.seq || '</td><td>' || to_char(r.starts_at at time zone tz, 'Dy Mon DD, HH24:MI') || '</td><td>' || it__h(r.title) || '</td></tr>';
  end loop;
  html := html || '<h2>Class schedule</h2><table><thead><tr><th>#</th><th>When</th><th>Topic</th></tr></thead><tbody>' || rows || '</tbody></table>';
  rows := '';
  for r in
    select c.number, c.title, q.closes_at as qdue,
           (select string_agg(v.nm || ' (' || to_char(a.closes_at at time zone tz, 'Mon DD') || ')', ', ')
              from it_arena_deadlines a join (values ('ricardian',2,'Comparative Advantage Workshop'), ('specific-factors',3,'Distribution Battle'), ('heckscher-ohlin',4,'Endowment Exchange'), ('terms-of-trade',5,'Terms-of-Trade Simulator'), ('scale-economies',6,'Variety Market'), ('firm-export',7,'Export or Die'), ('tariff-lab',8,'Tariff Laboratory'), ('lobby',9,'Protection for Sale'), ('trade-war',10,'Trade War Tournament'), ('negotiation',11,'The Negotiation Table'), ('currency',12,'Currency Room'), ('supply-chain',13,'Supply Chain Architect'), ('quant-lab',14,'Trade Model Solver')) v(slug, ch, nm) on v.slug = a.arena_slug
             where a.course_id = p_course and v.ch = c.number) as arenas
      from it_chapters c left join it_quiz_deadlines q on q.course_id = p_course and q.chapter = c.number
     where c.number between 1 and 14 order by c.number loop
    rows := rows || '<tr><td>' || r.number || '</td><td>' || it__h(r.title) || '</td><td>'
         || coalesce(to_char(r.qdue at time zone tz, 'Mon DD, HH24:MI'), '&mdash;') || '</td><td>' || coalesce(nullif(it__h(r.arenas), ''), '&mdash;') || '</td></tr>';
  end loop;
  html := html || '<h2>Quiz and arena deadlines</h2><table><thead><tr><th>Ch.</th><th>Chapter</th><th>Quiz due</th><th>Arena due</th></tr></thead><tbody>' || rows || '</tbody></table>';
  html := html || '<h2>Exams</h2><ul>';
  for ex in select title, opens_at, closes_at, time_limit_minutes, jsonb_array_length(item_ids) as nq from it_exams where id in (pl.midterm_id, pl.final_id) order by opens_at loop
    html := html || '<li><b>' || it__h(ex.title) || '</b>: open ' || to_char(ex.opens_at at time zone tz, 'Dy Mon DD, HH24:MI') || ' to '
         || to_char(ex.closes_at at time zone tz, 'Dy Mon DD, HH24:MI') || '; ' || ex.nq || ' questions, ' || ex.time_limit_minutes || ' minutes, one attempt.</li>';
  end loop;
  html := html || '</ul>'
    || '<h2>Grading</h2><table><tbody>'
    || '<tr><td>Reading</td><td>5%</td></tr><tr><td>Chapter quizzes</td><td>25%</td></tr><tr><td>Arenas</td><td>20%</td></tr>'
    || '<tr><td>Midterm exam</td><td>20%</td></tr><tr><td>Final exam</td><td>30%</td></tr></tbody></table>'
    || '<p>Late quizzes and arenas lose 10% per day for up to 3 days, after which they close.</p>'
    || '<h2>Academic integrity and proctoring</h2><ul>'
    || '<li>All graded chapter quizzes and both exams are proctored on camera. You need a working webcam and microphone; a quiz or exam will not start without the camera.</li>'
    || '<li>Before each quiz or exam you show your photo ID to the camera. The session runs in fullscreen; leaving the window, switching tabs, copying or pasting is recorded.</li>'
    || '<li>A photo is saved when a rule is broken, and a short clip is recorded if talking is detected. Repeated violations submit the quiz or exam automatically. Recordings are deleted after 30 days.</li>'
    || '<li>A calculator and one blank sheet of scratch paper are allowed; show both to the camera before you begin.</li></ul>';
  delete from it_materials where course_id = p_course and kind = 'syllabus';
  insert into it_materials (course_id, title, url, kind, position, created_by, body) values (p_course, 'Course syllabus', null, 'syllabus', -1, owner, html);
end $$;

create or replace function public.it_selfstudy_configure(p_weeks int, p_start_date date, p_days int[], p_start text, p_minutes int, p_tz text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid(); pl it_selfstudy_plan; owner uuid; st time; today date; term_end timestamptz; cutoff date; d date; ts timestamptz;
  slots timestamptz[] := '{}'; n int; rev int; l int; m int; total int; i int; j int; a int; b int; k int; cfirst int; clast int;
  srow record; secs_c int[] := '{}'; secs_s int[] := '{}'; secs_t text[] := '{}'; outl jsonb; ttl text; ctitle text;
  ch_done timestamptz[]; mid_ch int := 0; mid_open timestamptz; mid_close timestamptz; fin_open timestamptz; seq int := 0; slot int := 0;
  mid_items bigint[]; fin_items bigint[]; mid_id uuid; fin_id uuid; due timestamptz; arena record; dl timestamptz;
begin
  if u is null then return jsonb_build_object('ok', false, 'reason', 'signed_out'); end if;
  select * into pl from it_selfstudy_plan where student_id = u for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_plan'); end if;
  if pl.status = 'awaiting_payment' then return jsonb_build_object('ok', false, 'reason', 'not_paid'); end if;
  if pl.status not in ('awaiting_setup', 'active') then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if pl.status = 'active' and exists (select 1 from it_ai_class_session s where s.course_id = pl.course_id and s.status <> 'planned') then
    return jsonb_build_object('ok', false, 'reason', 'already_started'); end if;
  if p_weeks not in (4, 6, 8, 10, 12, 16) then return jsonb_build_object('ok', false, 'reason', 'bad_weeks'); end if;
  if p_minutes is null or p_minutes not between 30 and 120 then return jsonb_build_object('ok', false, 'reason', 'bad_minutes'); end if;
  if p_tz is null or not exists (select 1 from pg_timezone_names where name = p_tz) then return jsonb_build_object('ok', false, 'reason', 'bad_tz'); end if;
  begin st := p_start::time; exception when others then return jsonb_build_object('ok', false, 'reason', 'bad_time'); end;
  if p_days is null or cardinality(p_days) not between 1 and 7 or exists (select 1 from unnest(p_days) x where x not between 0 and 6)
     or (select count(distinct x) from unnest(p_days) x) <> cardinality(p_days) then return jsonb_build_object('ok', false, 'reason', 'bad_days'); end if;
  today := (now() at time zone p_tz)::date;
  if p_start_date is null or p_start_date < today or p_start_date > today + 30 then return jsonb_build_object('ok', false, 'reason', 'bad_start'); end if;
  owner := (select owner_id from it_courses where id = pl.course_id);
  term_end := ((p_start_date + p_weeks * 7 - 1)::timestamp + time '23:59') at time zone p_tz;
  cutoff := p_start_date + p_weeks * 7 - 7;
  d := p_start_date;
  while d <= cutoff loop
    if extract(dow from d)::int = any (p_days) then
      ts := (d::timestamp + st) at time zone p_tz;
      if ts > now() + interval '15 minutes' then slots := slots || ts; end if;
    end if;
    d := d + 1;
  end loop;
  n := coalesce(cardinality(slots), 0);
  if n < 12 then return jsonb_build_object('ok', false, 'reason', 'too_few_classes', 'classes', n, 'needed', 12); end if;
  if n > 120 then return jsonb_build_object('ok', false, 'reason', 'too_many_classes', 'classes', n); end if;
  for srow in select z.chapter as zc, z.sec as zs, z.title as zt from it_selfstudy_section z order by z.chapter, z.sec loop
    secs_c := secs_c || srow.zc; secs_s := secs_s || srow.zs; secs_t := secs_t || srow.zt;
  end loop;
  total := cardinality(secs_c);
  rev := case when n >= 24 then 2 else 0 end;
  l := n - rev; m := ceil(l / 2.0)::int;
  delete from it_ai_class_session where course_id = pl.course_id and status = 'planned';
  if pl.midterm_id is not null and not exists (select 1 from it_attempts where exam_id = pl.midterm_id) then delete from it_exams where id = pl.midterm_id; end if;
  if pl.final_id is not null and not exists (select 1 from it_attempts where exam_id = pl.final_id) then delete from it_exams where id = pl.final_id; end if;
  ch_done := array_fill(null::timestamptz, array[14]);
  for i in 1 .. l loop
    a := floor((i - 1) * total / l::numeric)::int + 1;
    b := floor(i * total / l::numeric)::int;
    slot := slot + 1;
    outl := '[]'::jsonb;
    for j in a .. b loop
      outl := outl || jsonb_build_array(jsonb_build_object('title', secs_c[j] || '.' || secs_s[j] || ' ' || secs_t[j]));
    end loop;
    cfirst := secs_c[a]; clast := secs_c[b];
    select title into ctitle from it_chapters where number = cfirst;
    if cfirst = clast then
      ttl := 'Chapter ' || cfirst || ': ' || coalesce(ctitle, '');
      if (a > 1 and secs_c[a - 1] = cfirst) or (b < total and secs_c[b + 1] = cfirst) then
        ttl := ttl || ' (' || secs_c[a] || '.' || secs_s[a] || '–' || secs_c[b] || '.' || secs_s[b] || ')';
      end if;
    else
      ttl := 'Chapters ' || cfirst || '–' || clast || ': ' || coalesce(ctitle, '') || ' to ' || coalesce((select title from it_chapters where number = clast), '');
    end if;
    seq := seq + 1;
    insert into it_ai_class_session (course_id, seq, title, outline, starts_at, duration_min) values (pl.course_id, seq, left(ttl, 160), outl, slots[slot], p_minutes);
    for k in cfirst .. clast loop
      if b = total or secs_c[b + 1] > k then ch_done[k] := slots[slot]; end if;
    end loop;
    if i = m then
      mid_ch := case when b = total or secs_c[b + 1] > secs_c[b] then secs_c[b] else secs_c[b] - 1 end;
      if rev = 2 then
        slot := slot + 1; seq := seq + 1;
        insert into it_ai_class_session (course_id, seq, title, outline, starts_at, duration_min)
        values (pl.course_id, seq, 'Midterm review: chapters 1–' || mid_ch,
          jsonb_build_array(jsonb_build_object('title', 'The main results of chapters 1–' || mid_ch), jsonb_build_object('title', 'Worked problems in the style of the midterm'),
                            jsonb_build_object('title', 'Your questions'), jsonb_build_object('title', 'How the midterm works and when it opens')), slots[slot], p_minutes);
      end if;
      mid_open := slots[slot] + make_interval(mins => p_minutes);
    end if;
  end loop;
  if rev = 2 then
    slot := slot + 1; seq := seq + 1;
    insert into it_ai_class_session (course_id, seq, title, outline, starts_at, duration_min)
    values (pl.course_id, seq, 'Final review: the whole course',
      jsonb_build_array(jsonb_build_object('title', 'The structure of the course in one picture'), jsonb_build_object('title', 'Why nations trade: Ricardo, specific factors, Heckscher–Ohlin and the standard model'),
                        jsonb_build_object('title', 'Trade policy: tariffs, protection, trade wars, agreements, exchange rates and development'), jsonb_build_object('title', 'Worked problems in the style of the final'),
                        jsonb_build_object('title', 'Your questions')), slots[slot], p_minutes);
  end if;
  fin_open := slots[n] + make_interval(mins => p_minutes);
  mid_close := least(mid_open + interval '4 days', fin_open);
  if mid_ch < 1 then mid_ch := 1; end if;
  for k in 1 .. 14 loop
    due := least(((((ch_done[k] at time zone p_tz)::date + 3)::timestamp + time '23:59') at time zone p_tz), term_end);
    insert into it_quiz_deadlines (course_id, chapter, closes_at, updated_at) values (pl.course_id, k, due, now())
      on conflict (course_id, chapter) do update set closes_at = excluded.closes_at, updated_at = now();
  end loop;
  for arena in select * from (values ('ricardian',2), ('specific-factors',3), ('heckscher-ohlin',4), ('terms-of-trade',5), ('scale-economies',6), ('firm-export',7), ('tariff-lab',8), ('lobby',9), ('trade-war',10), ('negotiation',11), ('currency',12), ('supply-chain',13), ('quant-lab',14)) v(slug, ch) loop
    dl := least(((((ch_done[arena.ch] at time zone p_tz)::date + 3)::timestamp + time '23:59') at time zone p_tz), term_end);
    insert into it_arena_deadlines (course_id, arena_slug, closes_at, updated_at) values (pl.course_id, arena.slug, dl, now())
      on conflict (course_id, arena_slug) do update set closes_at = excluded.closes_at, updated_at = now();
  end loop;
  select array_agg(q.iid) into mid_items from (
    select x.iid from generate_series(1, mid_ch) gc(cn), lateral (
      select ai.id as iid from it_assessment_items ai where ai.is_active and ai.chapter = gc.cn and ai.item_type = 'multiple_choice'
       order by md5(pl.course_id::text || ai.id::text) limit 3) x) q;
  select array_agg(q.iid) into fin_items from (
    select x.iid from generate_series(1, 14) gc(cn), lateral (
      select ai.id as iid from it_assessment_items ai where ai.is_active and ai.chapter = gc.cn and ai.item_type = 'multiple_choice'
         and ai.id <> all (coalesce(mid_items, '{}'::bigint[]))
       order by md5(pl.course_id::text || 'f' || ai.id::text) limit 2) x) q;
  insert into it_exams (course_id, kind, title, instructions, item_ids, total_points, time_limit_minutes, max_attempts, attempt_scoring, shuffle_questions,
                        is_published, opens_at, closes_at, proctored, camera_mode, created_by)
  values (pl.course_id, 'midterm', 'Midterm exam (chapters 1–' || mid_ch || ')', 'One attempt, ' || greatest(45, cardinality(mid_items) * 3) || ' minutes. Asha will review it with you after the window closes.',
          (select coalesce(jsonb_agg(to_jsonb(x::text)), '[]'::jsonb) from unnest(mid_items) x), cardinality(mid_items), greatest(45, cardinality(mid_items) * 3), 1, 'highest', true, true, mid_open, mid_close, true, 'block', owner)
  returning id into mid_id;
  insert into it_exams (course_id, kind, title, instructions, item_ids, total_points, time_limit_minutes, max_attempts, attempt_scoring, shuffle_questions,
                        is_published, opens_at, closes_at, proctored, camera_mode, created_by)
  values (pl.course_id, 'final', 'Final exam (chapters 1–14)', 'One attempt, ' || (cardinality(fin_items) * 3) || ' minutes, covering the whole course.',
          (select coalesce(jsonb_agg(to_jsonb(x::text)), '[]'::jsonb) from unnest(fin_items) x), cardinality(fin_items), cardinality(fin_items) * 3, 1, 'highest', true, true, fin_open, term_end, true, 'block', owner)
  returning id into fin_id;
  insert into it_ai_term (course_id, ends_at, hold_hours, auto_final, final_queued_at, late_pct_per_day, late_max_days)
  values (pl.course_id, term_end + interval '1 day', 24, true, null, 10, 3)
  on conflict (course_id) do update set ends_at = excluded.ends_at, hold_hours = 24, auto_final = true, final_queued_at = null;
  update it_courses set access_starts = least(today, current_date) - 1, access_ends = (term_end + interval '30 days')::date,
         term = 'Self-study · ' || to_char(p_start_date, 'Mon DD') || ' – ' || to_char((term_end at time zone p_tz)::date, 'Mon DD, YYYY') where id = pl.course_id;
  update it_subscriptions set expires_at = term_end + interval '30 days' where course_id = pl.course_id and student_id = u;
  update it_ai_settings set enabled = true, professor_mode = true, prof_paused = false, payer = 'platform', review_enabled = true,
         prof_actions = '{"class": true, "announce": true, "deadline": true, "feedback": true, "finalize": true, "standing": true, "assignment": true, "exam_window": true, "grade_final": true, "office_hours": true}'::jsonb,
         autopilot = '{"remind": true, "remind_hours": 24, "finalize_exams": true, "grade_delay_min": 60, "answer_questions": true, "grade_assignments": true, "finalize_delay_min": 60}'::jsonb,
         updated_at = now()
   where course_id = pl.course_id;
  insert into it_ai_syllabus (course_id, title, body, updated_at) values (pl.course_id, 'International Trade — Self-Study',
    'This is a private self-study section of International Trade taught entirely by Asha, the AI professor, for one student. ' ||
    'The student chose a ' || p_weeks || '-week course starting ' || to_char(p_start_date, 'FMMonth DD, YYYY') || ', with live classes of ' || p_minutes || ' minutes at ' || to_char(st, 'HH24:MI') || ' (' || p_tz || ') on ' ||
    (select string_agg((array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])[x + 1], ', ' order by x) from unnest(p_days) x) || '. ' ||
    'There are ' || n || ' live classes covering all 14 chapters in order' || case when rev = 2 then ', including a midterm review and a final review' else '' end || '. ' ||
    'Each chapter quiz and arena is due three days after the class that finishes the chapter. The midterm (chapters 1–' || mid_ch || ') is open from ' ||
    to_char(mid_open at time zone p_tz, 'Mon DD HH24:MI') || ' to ' || to_char(mid_close at time zone p_tz, 'Mon DD HH24:MI') || '; the final (all chapters) from ' ||
    to_char(fin_open at time zone p_tz, 'Mon DD HH24:MI') || ' to ' || to_char(term_end at time zone p_tz, 'Mon DD HH24:MI') || ' (' || p_tz || '). ' ||
    'Grade weights: reading 5%, chapter quizzes 25%, arenas 20%, midterm 20%, final 30%. Late work loses 10% per day for up to 3 days. ' ||
    'Teach at the pace of the schedule, encourage the student to read each chapter before its class, and keep answers within international trade.', now())
  on conflict (course_id) do update set title = excluded.title, body = excluded.body, updated_at = now();
  delete from it_announcements where course_id = pl.course_id and title = 'Welcome to your self-study course';
  insert into it_announcements (course_id, title, body, created_by) values (pl.course_id, 'Welcome to your self-study course',
    'Your course is set: ' || n || ' live classes with Asha from ' || to_char(slots[1] at time zone p_tz, 'FMDay, Mon DD at HH24:MI') || ' (' || p_tz || ') to ' ||
    to_char(slots[n] at time zone p_tz, 'Mon DD') || '. The final exam closes on ' || to_char(term_end at time zone p_tz, 'Mon DD') || '. Read the chapter before each class; quizzes and arenas are due three days after each chapter is finished. Ask Asha anything, any time.', owner);
  update it_selfstudy_plan set status = 'active', weeks = p_weeks, days = p_days, start_local = st, minutes = p_minutes, tz = p_tz, starts_on = p_start_date,
         ends_at = term_end, classes = n, midterm_id = mid_id, final_id = fin_id, configured_at = now() where course_id = pl.course_id;
  perform it__selfstudy_post_syllabus(pl.course_id);
  return jsonb_build_object('ok', true) || it__selfstudy_status(u);
end $$;

create or replace function public.it_selfstudy_tick() returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; act int := 0; done int := 0;
begin
  for r in select student_id from it_selfstudy_plan where status = 'awaiting_payment' loop
    if it__selfstudy_activate(r.student_id) then act := act + 1; end if;
  end loop;
  update it_selfstudy_plan set status = 'completed' where status = 'active' and ends_at + interval '30 days' < now();
  get diagnostics done = row_count;
  return jsonb_build_object('activated', act, 'completed', done);
end $$;

create or replace function public.it_selfstudy_admin_list() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not it_ss_is_admin() then raise exception 'not allowed'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('course_id', p.course_id, 'student_id', p.student_id, 'name', pe.full_name, 'email', pe.email,
      'status', p.status, 'weeks', p.weeks, 'classes', p.classes, 'starts_on', p.starts_on, 'ends_at', p.ends_at, 'tz', p.tz, 'paid_by', p.paid_by, 'created_at', p.created_at,
      'held', (select count(*) from it_ai_class_session s where s.course_id = p.course_id and s.status in ('done','live')),
      'next_at', (select min(s.starts_at) from it_ai_class_session s where s.course_id = p.course_id and s.status = 'planned')) order by p.created_at desc)
    from it_selfstudy_plan p left join it_profiles pe on pe.id = p.student_id), '[]'::jsonb);
end $$;

create or replace function public.it_selfstudy_admin_comp(p_course uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare s uuid;
begin
  if not it_ss_is_admin() then raise exception 'not allowed'; end if;
  select student_id into s from it_selfstudy_plan where course_id = p_course and status = 'awaiting_payment';
  if s is null then return jsonb_build_object('ok', false, 'reason', 'not_waiting'); end if;
  perform it__selfstudy_activate(s, true);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.it_selfstudy_admin_reset(p_course uuid) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not it_ss_is_admin() then raise exception 'not allowed'; end if;
  if exists (select 1 from it_ai_class_session where course_id = p_course and status <> 'planned') then return jsonb_build_object('ok', false, 'reason', 'already_started'); end if;
  update it_selfstudy_plan set status = 'awaiting_setup' where course_id = p_course and status = 'active';
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.it_selfstudy_key_owner_get() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o uuid;
begin
  if not it_ss_is_admin() then raise exception 'not allowed'; end if;
  select ai_key_owner into o from it_platform_settings order by id limit 1;
  return jsonb_build_object('owner', o, 'email', (select email from auth.users where id = o),
    'has_key', exists (select 1 from it_ai_keys k where k.owner_id::text = o::text));
end $$;

create or replace function public.it_selfstudy_key_owner_set(p_email text) returns jsonb language plpgsql security definer set search_path = public as $$
declare o uuid;
begin
  if not it_ss_is_admin() then raise exception 'not allowed'; end if;
  select u.id into o from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1;
  if o is null then return jsonb_build_object('ok', false, 'reason', 'no_account'); end if;
  if not exists (select 1 from it_ai_keys k where k.owner_id::text = o::text) then return jsonb_build_object('ok', false, 'reason', 'no_key'); end if;
  update it_platform_settings set ai_key_owner = o;
  return jsonb_build_object('ok', true) || it_selfstudy_key_owner_get();
end $$;

-- ===== grants and schedules =====
revoke all on function public.it__selfstudy_status(uuid), public.it__selfstudy_activate(uuid, boolean), public.it__selfstudy_owner(), public.it_selfstudy_tick(), public.it__selfstudy_post_syllabus(uuid) from public, anon, authenticated;
revoke all on function public.it_selfstudy_status(), public.it_selfstudy_check_payment(), public.it_selfstudy_start(), public.it_selfstudy_configure(int, date, int[], text, int, text),
  public.it_selfstudy_admin_list(), public.it_selfstudy_admin_comp(uuid), public.it_selfstudy_admin_reset(uuid), public.it_selfstudy_key_owner_get(), public.it_selfstudy_key_owner_set(text) from public, anon;
grant execute on function public.it_selfstudy_status(), public.it_selfstudy_check_payment(), public.it_selfstudy_start(), public.it_selfstudy_configure(int, date, int[], text, int, text),
  public.it_selfstudy_admin_list(), public.it_selfstudy_admin_comp(uuid), public.it_selfstudy_admin_reset(uuid), public.it_selfstudy_key_owner_get(), public.it_selfstudy_key_owner_set(text) to authenticated;
select cron.unschedule(j) from unnest(array['it-selfstudy-tick', 'it-ai-class-tick', 'it-ai-prof-tick']) j where exists (select 1 from cron.job where jobname = j);
select cron.schedule('it-selfstudy-tick', '*/10 * * * *', 'select public.it_selfstudy_tick()');
-- Asha's professor-mode timers (start/end live classes, the term's final grades, held actions). Idle unless a course needs them.
select cron.schedule('it-ai-class-tick', '*/5 * * * *', 'select public.it_ai_class_tick()');
select cron.schedule('it-ai-prof-tick', '*/15 * * * *', 'select public.it_ai_prof_tick()');
update it_platform_settings set ai_key_owner = (select ai_key_owner::uuid from fd_platform_setting order by id limit 1) where ai_key_owner is null;
