-- ============================================================================
-- 107_ma_ai_core.sql  --  Macroeconomics AI Instructor (Asha): sessions, turns, usage, budgets, learning records, content search.
-- STATUS: NOT APPLIED. Apply only with explicit approval. A copy of the International Trade layer (it_ai_*), re-keyed to the Micro tables:
--   ma_course (courses), ma_person (people), ma_enrollment, ma_course_staff, ma_exam / ma_exam_attempt.
-- Purely additive: new ma_ai_* tables and functions; no existing table, policy or function is touched. The API key itself is NOT stored here:
-- Micro courses are paid by the platform key, which lives in it_ai_keys (service role only). User ids are auth.uid() as uuid (ma_* store them as text).
-- Browser access: RLS on, no policies, privileges revoked from anon/authenticated. Only the im-ai-instructor edge function (service role) uses them.
-- ============================================================================
-- ============================================================================
-- 001_im_ai_instructor.sql  --  International Trade AI Instructor (pilot)
-- STATUS: NOT APPLIED. Review, then apply to the tournament project only with explicit approval.
-- Purely additive: creates new ma_ai_* tables and functions. Touches no existing table, policy or function.
-- Access model: RLS enabled and NO policies, and all privileges revoked from anon/authenticated, so the browser can never read or
-- write these tables. Only the it-ai-instructor edge function (service role) uses them.
-- Rollback: see the end of this file.
-- ============================================================================

create table if not exists public.ma_ai_settings (
  course_id            uuid primary key references public.ma_course(id) on delete cascade,
  enabled              boolean not null default false,          -- OFF until the instructor turns it on
  retention_days       integer not null default 0 check (retention_days between 0 and 365),
  student_daily_tokens integer not null default 60000 check (student_daily_tokens >= 1000),
  course_monthly_usd   numeric not null default 25 check (course_monthly_usd >= 0),
  model                text not null default 'claude-haiku-5-5',
  updated_at           timestamptz not null default now()
);

create table if not exists public.ma_ai_sessions (
  id               uuid primary key default gen_random_uuid(),
  course_id        uuid not null references public.ma_course(id) on delete cascade,
  user_id          uuid not null,
  state            text not null default 'listening' check (state in ('listening','processing','generating','speaking','interrupted','ended')),
  retention_days   integer not null default 0,
  next_seq         integer not null default 1,
  started_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at         timestamptz
);
create index if not exists ma_ai_sessions_user_idx on public.ma_ai_sessions (user_id, started_at desc);
create index if not exists ma_ai_sessions_activity_idx on public.ma_ai_sessions (last_activity_at) where ended_at is null;

create table if not exists public.ma_ai_turns (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.ma_ai_sessions(id) on delete cascade,
  user_id        uuid not null,
  course_id      uuid not null,
  client_turn_id uuid not null,
  status         text not null default 'generating' check (status in ('generating','completed','interrupted','failed')),
  error_code     text,
  spoken_chars   integer,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz,
  unique (session_id, client_turn_id)                       -- this constraint is what makes duplicate turns impossible
);
create index if not exists ma_ai_turns_user_time_idx on public.ma_ai_turns (user_id, created_at desc);
create index if not exists ma_ai_turns_course_gen_idx on public.ma_ai_turns (course_id, created_at desc) where status = 'generating';

create table if not exists public.ma_ai_messages (
  id         bigint generated always as identity primary key,
  session_id uuid not null references public.ma_ai_sessions(id) on delete cascade,
  turn_id    uuid not null references public.ma_ai_turns(id) on delete cascade,
  seq        integer not null,
  role       text not null check (role in ('user','assistant')),
  content    text not null,
  interrupted boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (session_id, seq),
  unique (turn_id, role)                                    -- one user and one assistant message per turn: no duplicate persistence
);
create index if not exists ma_ai_messages_expiry_idx on public.ma_ai_messages (expires_at);

create table if not exists public.ma_ai_usage (
  turn_id             uuid primary key references public.ma_ai_turns(id) on delete cascade,
  course_id           uuid not null,
  user_id             uuid not null,
  session_id          uuid,
  model               text not null,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cache_read_tokens   integer not null default 0,
  cache_write_tokens  integer not null default 0,
  cost_micro_usd      bigint  not null default 0,
  latency_ms          integer,
  ttft_ms             integer,
  created_at          timestamptz not null default now()
);
create index if not exists ma_ai_usage_user_idx on public.ma_ai_usage (user_id, created_at desc);
create index if not exists ma_ai_usage_course_idx on public.ma_ai_usage (course_id, created_at desc);

create table if not exists public.ma_ai_practice (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  course_id   uuid not null,
  session_id  uuid not null references public.ma_ai_sessions(id) on delete cascade,
  topic       text not null, question text not null, answer text not null,
  answer_kind text not null check (answer_kind in ('numeric','short_text','multiple_choice')),
  hints       jsonb not null default '[]'::jsonb,
  attempts    integer not null default 0,
  solved      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists ma_ai_practice_session_idx on public.ma_ai_practice (session_id);

-- Learning events outlive sessions (they feed the student's own progress view). They contain no transcript text beyond a short note.
create table if not exists public.ma_ai_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  course_id  uuid not null,
  session_id uuid references public.ma_ai_sessions(id) on delete set null,
  idem_key   text not null unique,                          -- turn id + tool call id: a retried tool call cannot record twice
  event      text not null check (event in ('practiced','struggled','improved','asked_followup')),
  topic      text not null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists ma_ai_events_user_idx on public.ma_ai_events (user_id, course_id, created_at desc);

-- Budget counters. begin_turn must check the student's daily tokens and the course's monthly spend on EVERY turn; summing ma_ai_usage for that
-- would get slower with every turn ever taken (measured: begin_turn latency grew in step with table size). These small counter rows are
-- bumped once per finished turn instead. Course-month counters are split over 16 shards so concurrent turns do not queue on one hot row.
create table if not exists public.ma_ai_counters (
  scope      text not null check (scope in ('cm','ud')),     -- cm = course/month, ud = user/course/day
  key        text not null,
  shard      integer not null default 0,
  micro      bigint not null default 0,
  tokens     bigint not null default 0,
  turns      integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (scope, key, shard)
);

-- ---- lock everything down -----------------------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['ma_ai_settings','ma_ai_sessions','ma_ai_turns','ma_ai_messages','ma_ai_usage','ma_ai_practice','ma_ai_events','ma_ai_counters'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ---- create a session (with per-user daily cap) --------------------------------------------------------------------------------
create or replace function public.ma_ai_create_session(p_user uuid, p_course uuid, p_retention integer, p_max_per_day integer)
returns jsonb language plpgsql set search_path = public as $$
declare n integer; s public.ma_ai_sessions;
begin
  select count(*) into n from public.ma_ai_sessions where user_id = p_user and started_at > now() - interval '1 day';
  if n >= p_max_per_day then return jsonb_build_object('ok', false, 'code', 'rate_limited'); end if;
  insert into public.ma_ai_sessions (user_id, course_id, retention_days) values (p_user, p_course, p_retention) returning * into s;
  return jsonb_build_object('ok', true, 'session', to_jsonb(s));
end $$;

-- ---- begin a turn: ONE atomic step covering ownership, duplicates, rate limits, budgets, concurrency, supersede, persistence ----------
create or replace function public.ma_ai_begin_turn(
  p_session uuid, p_user uuid, p_course uuid, p_client_turn uuid, p_text text,
  p_user_per_min integer, p_user_per_day integer, p_session_per_hour integer,
  p_student_daily_tokens integer, p_course_monthly_usd numeric, p_course_max_generating integer,
  p_stale_seconds integer, p_idle_ttl_seconds integer, p_now timestamptz default now())
returns jsonb language plpgsql set search_path = public as $$
declare s public.ma_ai_sessions; t public.ma_ai_turns; n integer; oldest timestamptz; tok_used bigint; micro_used bigint;
        new_turn uuid; seq integer; exp timestamptz;
begin
  select * into s from public.ma_ai_sessions where id = p_session for update;      -- serialises turns within one session
  if not found or s.user_id <> p_user or s.course_id <> p_course then return jsonb_build_object('kind','session_not_found'); end if;
  if s.state = 'ended' then return jsonb_build_object('kind','session_ended'); end if;

  select * into t from public.ma_ai_turns where session_id = p_session and client_turn_id = p_client_turn;
  if found then
    if t.status = 'generating' and t.created_at > p_now - make_interval(secs => p_stale_seconds) then
      return jsonb_build_object('kind','in_progress','turn_id', t.id);
    end if;
    return jsonb_build_object('kind','duplicate','turn_id', t.id,'status', t.status);
  end if;

  select count(*), min(created_at) into n, oldest from public.ma_ai_turns where user_id = p_user and created_at > p_now - interval '1 minute';
  if n >= p_user_per_min then return jsonb_build_object('kind','rate_limited','scope','user_minute','retry_after_s', greatest(1, ceil(extract(epoch from (oldest + interval '1 minute' - p_now)))::int)); end if;
  select count(*), min(created_at) into n, oldest from public.ma_ai_turns where user_id = p_user and created_at > p_now - interval '1 day';
  if n >= p_user_per_day then return jsonb_build_object('kind','rate_limited','scope','user_day','retry_after_s', greatest(60, ceil(extract(epoch from (oldest + interval '1 day' - p_now)))::int)); end if;
  select count(*), min(created_at) into n, oldest from public.ma_ai_turns where session_id = p_session and created_at > p_now - interval '1 hour';
  if n >= p_session_per_hour then return jsonb_build_object('kind','rate_limited','scope','session_hour','retry_after_s', greatest(30, ceil(extract(epoch from (oldest + interval '1 hour' - p_now)))::int)); end if;

  select coalesce(sum(c.tokens), 0) into tok_used from public.ma_ai_counters c
    where c.scope = 'ud' and c.key = p_user::text || '|' || p_course::text || '|' || to_char(p_now at time zone 'utc', 'YYYY-MM-DD');
  if tok_used >= p_student_daily_tokens then return jsonb_build_object('kind','budget','scope','student'); end if;
  select coalesce(sum(c.micro), 0) into micro_used from public.ma_ai_counters c
    where c.scope = 'cm' and c.key = p_course::text || '|' || to_char(p_now at time zone 'utc', 'YYYY-MM');
  if micro_used >= (p_course_monthly_usd * 1000000)::bigint then return jsonb_build_object('kind','budget','scope','course'); end if;

  select count(*) into n from public.ma_ai_turns where course_id = p_course and status = 'generating' and created_at > p_now - make_interval(secs => p_stale_seconds);
  if n >= p_course_max_generating then return jsonb_build_object('kind','busy','retry_after_s', 3); end if;

  -- a new turn supersedes any still-"generating" turn of this session (its stream notices within seconds and stops)
  update public.ma_ai_turns set status = 'interrupted', finished_at = p_now where session_id = p_session and status = 'generating';

  seq := s.next_seq;
  exp := p_now + case when s.retention_days > 0 then make_interval(days => s.retention_days) else make_interval(secs => p_idle_ttl_seconds) end;
  insert into public.ma_ai_turns (session_id, user_id, course_id, client_turn_id, created_at) values (p_session, p_user, p_course, p_client_turn, p_now) returning id into new_turn;
  insert into public.ma_ai_messages (session_id, turn_id, seq, role, content, created_at, expires_at) values (p_session, new_turn, seq, 'user', p_text, p_now, exp);
  update public.ma_ai_sessions set next_seq = seq + 2, state = 'processing', last_activity_at = p_now where id = p_session;
  return jsonb_build_object('kind','ok','turn_id', new_turn,'seq', seq);
end $$;

-- ---- finish a turn: idempotent. Only one call closes the turn; usage is always recorded (the tokens were spent either way) ------------
create or replace function public.ma_ai_finish_turn(
  p_turn uuid, p_status text, p_text text, p_error text, p_end_state text,
  p_course uuid, p_user uuid, p_session uuid, p_model text,
  p_in integer, p_out integer, p_cache_read integer, p_cache_write integer, p_cost bigint, p_latency integer, p_ttft integer,
  p_idle_ttl_seconds integer, p_now timestamptz default now())
returns boolean language plpgsql set search_path = public as $$
declare t public.ma_ai_turns; s public.ma_ai_sessions; body text; closed boolean := false; was_generating boolean; seq integer; exp timestamptz; final_status text; inserted integer; usage_rows integer;
begin
  select * into t from public.ma_ai_turns where id = p_turn for update;
  if not found then return false; end if;
  was_generating := (t.status = 'generating');
  final_status := case when was_generating then p_status else t.status end;
  if was_generating then
    update public.ma_ai_turns set status = p_status, error_code = p_error, finished_at = p_now where id = p_turn;
    closed := true;
  end if;

  insert into public.ma_ai_usage (turn_id, course_id, user_id, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd, latency_ms, ttft_ms)
  values (p_turn, p_course, p_user, p_session, p_model, p_in, p_out, p_cache_read, p_cache_write, p_cost, p_latency, p_ttft) on conflict (turn_id) do nothing;
  get diagnostics usage_rows = row_count;
  if usage_rows > 0 then                                    -- count each turn's usage exactly once, even if finish_turn is called again
    insert into public.ma_ai_counters as c (scope, key, shard, micro, tokens, turns)
    values ('cm', p_course::text || '|' || to_char(p_now at time zone 'utc', 'YYYY-MM'), floor(random() * 16)::int, p_cost, p_in + p_out, 1)
    on conflict (scope, key, shard) do update set micro = c.micro + excluded.micro, tokens = c.tokens + excluded.tokens, turns = c.turns + 1, updated_at = p_now;
    insert into public.ma_ai_counters as c (scope, key, shard, micro, tokens, turns)
    values ('ud', p_user::text || '|' || p_course::text || '|' || to_char(p_now at time zone 'utc', 'YYYY-MM-DD'), 0, p_cost, p_in + p_out, 1)
    on conflict (scope, key, shard) do update set micro = c.micro + excluded.micro, tokens = c.tokens + excluded.tokens, turns = c.turns + 1, updated_at = p_now;
  end if;

  body := coalesce(p_text, '');
  if t.spoken_chars is not null and final_status = 'interrupted' then body := left(body, t.spoken_chars); end if;   -- only what the student actually heard
  if length(btrim(body)) > 0 then
    select * into s from public.ma_ai_sessions where id = t.session_id for update;
    exp := p_now + case when s.retention_days > 0 then make_interval(days => s.retention_days) else make_interval(secs => p_idle_ttl_seconds) end;
    seq := s.next_seq - 1;                                  -- the slot reserved for this turn's assistant message by begin_turn
    insert into public.ma_ai_messages (session_id, turn_id, seq, role, content, interrupted, created_at, expires_at)
    values (t.session_id, p_turn, seq, 'assistant', body, final_status in ('interrupted','failed'), p_now, exp) on conflict do nothing;
    get diagnostics inserted = row_count;
    if inserted > 0 then closed := true; end if;
  end if;

  if was_generating then
    update public.ma_ai_sessions set state = case when state = 'ended' then 'ended' else p_end_state end, last_activity_at = p_now
    where id = t.session_id and not exists (select 1 from public.ma_ai_turns x where x.session_id = t.session_id and x.status = 'generating' and x.id <> p_turn);
  end if;
  return closed;
end $$;

-- ---- student interrupts: flag the turn, and trim an already-finished reply to what was actually spoken --------------------------------
create or replace function public.ma_ai_interrupt_turn(p_session uuid, p_user uuid, p_client_turn uuid, p_spoken integer)
returns boolean language plpgsql set search_path = public as $$
declare t public.ma_ai_turns; changed boolean := false;
begin
  select * into t from public.ma_ai_turns where session_id = p_session and user_id = p_user and client_turn_id = p_client_turn for update;
  if not found then return false; end if;
  if t.status = 'generating' then
    update public.ma_ai_turns set status = 'interrupted', spoken_chars = p_spoken, finished_at = now() where id = t.id; changed := true;
  elsif t.status = 'completed' and p_spoken is not null then
    update public.ma_ai_turns set spoken_chars = p_spoken, status = 'interrupted' where id = t.id;
    update public.ma_ai_messages set content = left(content, p_spoken), interrupted = true where turn_id = t.id and role = 'assistant';
    changed := true;
  elsif t.status = 'interrupted' and t.spoken_chars is null and p_spoken is not null then
    -- the server noticed the dropped connection first; the client's report of what was actually HEARD arrives afterwards and still trims the reply
    update public.ma_ai_turns set spoken_chars = p_spoken where id = t.id;
    update public.ma_ai_messages set content = left(content, p_spoken), interrupted = true where turn_id = t.id and role = 'assistant';
    changed := true;
  end if;
  return changed;
end $$;

-- ---- end a session; with retention 0 the conversation is deleted immediately ------------------------------------------------------
create or replace function public.ma_ai_end_session(p_session uuid)
returns void language plpgsql set search_path = public as $$
declare s public.ma_ai_sessions;
begin
  update public.ma_ai_sessions set state = 'ended', ended_at = coalesce(ended_at, now()) where id = p_session returning * into s;
  update public.ma_ai_turns set status = 'interrupted', finished_at = now() where session_id = p_session and status = 'generating';
  if s.id is not null and s.retention_days = 0 then delete from public.ma_ai_messages where session_id = p_session; delete from public.ma_ai_practice where session_id = p_session; end if;
end $$;

-- ---- retention purge: run by a schedule once approved; the function also calls it opportunistically -------------------------------------
create or replace function public.ma_ai_purge(p_now timestamptz default now(), p_idle_ttl_seconds integer default 7200)
returns integer language plpgsql set search_path = public as $$
declare n integer := 0; k integer;
begin
  update public.ma_ai_sessions set state = 'ended', ended_at = p_now where ended_at is null and last_activity_at < p_now - make_interval(secs => p_idle_ttl_seconds);
  delete from public.ma_ai_messages where expires_at < p_now; get diagnostics k = row_count; n := n + k;
  delete from public.ma_ai_counters where scope = 'ud' and updated_at < p_now - interval '3 days';      -- daily counters only matter for today; monthly ones are tiny and kept
  delete from public.ma_ai_sessions s where s.ended_at is not null and s.ended_at < p_now - interval '1 day'
    and not exists (select 1 from public.ma_ai_messages m where m.session_id = s.id);
  return n;
end $$;

-- ---- practice attempt counter (atomic increment) ---------------------------------------------------------------------------------
create or replace function public.ma_ai_practice_attempt(p_id uuid, p_user uuid, p_solved boolean)
returns void language sql set search_path = public as $$
  update public.ma_ai_practice set attempts = attempts + 1, solved = solved or p_solved where id = p_id and user_id = p_user;
$$;

do $$ declare f text; begin
  foreach f in array array[
    'ma_ai_practice_attempt(uuid,uuid,boolean)',
    'ma_ai_create_session(uuid,uuid,integer,integer)',
    'ma_ai_begin_turn(uuid,uuid,uuid,uuid,text,integer,integer,integer,integer,numeric,integer,integer,integer,timestamptz)',
    'ma_ai_finish_turn(uuid,text,text,text,text,uuid,uuid,uuid,text,integer,integer,integer,integer,bigint,integer,integer,integer,timestamptz)',
    'ma_ai_interrupt_turn(uuid,uuid,uuid,integer)', 'ma_ai_end_session(uuid)', 'ma_ai_purge(timestamptz,integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ============================ ROLLBACK (run manually if needed; deletes all AI instructor data) ============================
-- drop function if exists public.ma_ai_practice_attempt(uuid,uuid,boolean), public.ma_ai_purge(timestamptz,integer), public.ma_ai_end_session(uuid), public.ma_ai_interrupt_turn(uuid,uuid,uuid,integer),
--   public.ma_ai_finish_turn(uuid,text,text,text,text,uuid,uuid,uuid,text,integer,integer,integer,integer,bigint,integer,integer,integer,timestamptz),
--   public.ma_ai_begin_turn(uuid,uuid,uuid,uuid,text,integer,integer,integer,integer,numeric,integer,integer,integer,timestamptz),
--   public.ma_ai_create_session(uuid,uuid,integer,integer);
-- drop table if exists public.ma_ai_counters, public.ma_ai_events, public.ma_ai_practice, public.ma_ai_usage, public.ma_ai_messages, public.ma_ai_turns,
--   public.ma_ai_sessions, public.ma_ai_settings;

-- ============================================================================
-- 002_im_ai_operations.sql  --  capacity controls, per-session usage metering, ops views
-- Requires the 101 core part first. Purely additive (new tables/functions/views, nothing existing is touched).
-- Same access model as 001: RLS on, no policies, no privileges for anon/authenticated; only the service role (edge function) executes.
-- ============================================================================

-- Single-row-per-key operator switches (emergency stop, text-only mode, active-session cap). Changing a row takes effect on every
-- function instance within ~5 seconds because instances cache it briefly.
create table if not exists public.ma_ai_control (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.ma_ai_control (key, value) values ('main', '{"mode":"normal","max_active_sessions":null,"message":null,"course_max_generating":null}'::jsonb) on conflict do nothing;

-- One row per session (NOT per audio frame / partial transcript). The browser reports a few aggregates; the function adds them up.
create table if not exists public.ma_ai_session_metrics (
  session_id      uuid primary key references public.ma_ai_sessions(id) on delete cascade,
  user_id         uuid not null,
  course_id       uuid not null,
  asr_ms          bigint not null default 0,      -- time the browser spent on speech recognition
  tts_ms          bigint not null default 0,      -- time the browser spent synthesising speech
  audio_in_ms     bigint not null default 0,      -- speech heard from the student (duration only; audio itself is never uploaded)
  audio_out_ms    bigint not null default 0,
  avatar_bytes    bigint not null default 0,      -- avatar/model bytes downloaded (CDN delivery metering)
  avatar_init_ms  integer,
  ttfa_sum_ms     bigint not null default 0,      -- time-to-first-audible-response, summed so we can derive a mean
  ttfa_max_ms     integer not null default 0,
  turns_reported  integer not null default 0,
  interruptions   integer not null default 0,
  sync_errors     integer not null default 0,
  audio_drops     integer not null default 0,
  text_only       boolean not null default false,
  reports         integer not null default 0,
  updated_at      timestamptz not null default now()
);
create index if not exists ma_ai_session_metrics_course_idx on public.ma_ai_session_metrics (course_id, updated_at desc);

alter table public.ma_ai_control enable row level security;
alter table public.ma_ai_session_metrics enable row level security;
revoke all on public.ma_ai_control, public.ma_ai_session_metrics from anon, authenticated;

create or replace function public.ma_ai_get_control() returns jsonb language sql stable set search_path = public as $$
  select coalesce((select value from public.ma_ai_control where key = 'main'), '{"mode":"normal","max_active_sessions":null,"message":null,"course_max_generating":null}'::jsonb);
$$;

create or replace function public.ma_ai_set_control(p_mode text, p_max integer, p_clear_max boolean, p_message text, p_set_message boolean, p_max_gen integer default null, p_clear_max_gen boolean default false)
returns jsonb language plpgsql set search_path = public as $$
declare cur jsonb; nxt jsonb;
begin
  if p_mode is not null and p_mode not in ('normal','text_only','paused') then raise exception 'invalid mode'; end if;
  cur := public.ma_ai_get_control(); nxt := cur;
  if p_mode is not null then nxt := jsonb_set(nxt, '{mode}', to_jsonb(p_mode)); end if;
  if p_clear_max then nxt := jsonb_set(nxt, '{max_active_sessions}', 'null'::jsonb);
  elsif p_max is not null then nxt := jsonb_set(nxt, '{max_active_sessions}', to_jsonb(p_max)); end if;
  if p_clear_max_gen then nxt := jsonb_set(nxt, '{course_max_generating}', 'null'::jsonb);
  elsif p_max_gen is not null then nxt := jsonb_set(nxt, '{course_max_generating}', to_jsonb(p_max_gen)); end if;
  if p_set_message then nxt := jsonb_set(nxt, '{message}', coalesce(to_jsonb(p_message), 'null'::jsonb)); end if;
  insert into public.ma_ai_control (key, value) values ('main', nxt) on conflict (key) do update set value = excluded.value, updated_at = now();
  return nxt;
end $$;

create or replace function public.ma_ai_count_active(p_seconds integer) returns integer language sql stable set search_path = public as $$
  select count(*)::int from public.ma_ai_sessions where ended_at is null and last_activity_at > now() - make_interval(secs => p_seconds);
$$;

-- Adds a delta report. Values are clamped again here (defence in depth); ownership is checked against the session row.
create or replace function public.ma_ai_report_usage(p_session uuid, p_user uuid, p_m jsonb) returns boolean language plpgsql set search_path = public as $$
declare s record;
  c bigint := 3600000;
begin
  select id, user_id, course_id into s from public.ma_ai_sessions where id = p_session;
  if s.id is null or s.user_id <> p_user then return false; end if;
  insert into public.ma_ai_session_metrics as m (session_id, user_id, course_id, asr_ms, tts_ms, audio_in_ms, audio_out_ms, avatar_bytes, avatar_init_ms, ttfa_sum_ms, ttfa_max_ms, turns_reported, interruptions, sync_errors, audio_drops, text_only, reports)
  values (s.id, s.user_id, s.course_id,
    least(coalesce((p_m->>'asr_ms')::bigint,0), c), least(coalesce((p_m->>'tts_ms')::bigint,0), c),
    least(coalesce((p_m->>'audio_in_ms')::bigint,0), c), least(coalesce((p_m->>'audio_out_ms')::bigint,0), c),
    least(coalesce((p_m->>'avatar_bytes')::bigint,0), 500000000), (p_m->>'avatar_init_ms')::int,
    coalesce((p_m->>'ttfa_ms')::bigint,0), coalesce((p_m->>'ttfa_ms')::int,0), least(coalesce((p_m->>'turns')::int,0),100),
    least(coalesce((p_m->>'interruptions')::int,0),1000), least(coalesce((p_m->>'sync_errors')::int,0),1000), least(coalesce((p_m->>'audio_drops')::int,0),1000),
    coalesce((p_m->>'text_only')::boolean,false), 1)
  on conflict (session_id) do update set
    asr_ms = least(m.asr_ms + excluded.asr_ms, 86400000), tts_ms = least(m.tts_ms + excluded.tts_ms, 86400000),
    audio_in_ms = least(m.audio_in_ms + excluded.audio_in_ms, 86400000), audio_out_ms = least(m.audio_out_ms + excluded.audio_out_ms, 86400000),
    avatar_bytes = least(m.avatar_bytes + excluded.avatar_bytes, 5000000000), avatar_init_ms = coalesce(excluded.avatar_init_ms, m.avatar_init_ms),
    ttfa_sum_ms = m.ttfa_sum_ms + excluded.ttfa_sum_ms, ttfa_max_ms = greatest(m.ttfa_max_ms, excluded.ttfa_max_ms),
    turns_reported = least(m.turns_reported + excluded.turns_reported, 100000), interruptions = least(m.interruptions + excluded.interruptions, 100000),
    sync_errors = least(m.sync_errors + excluded.sync_errors, 100000), audio_drops = least(m.audio_drops + excluded.audio_drops, 100000),
    text_only = m.text_only or excluded.text_only, reports = least(m.reports + 1, 100000), updated_at = now()
  where m.reports < 200;                                   -- a session cannot report more than ~200 times: bounds write volume from a buggy/malicious client
  return true;
end $$;

create or replace function public.ma_ai_course_spend(p_course uuid, p_now timestamptz) returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'month_usd', coalesce((select sum(micro) from public.ma_ai_counters where scope = 'cm' and key = p_course::text || '|' || to_char(p_now at time zone 'utc', 'YYYY-MM')), 0) / 1e6,
    'today_turns', (select count(*) from public.ma_ai_turns where course_id = p_course and created_at >= date_trunc('day', p_now)),
    'active_sessions', (select count(*) from public.ma_ai_sessions where course_id = p_course and ended_at is null and last_activity_at > p_now - interval '3 minutes'));
$$;

do $$ declare f text; begin
  foreach f in array array['ma_ai_get_control()','ma_ai_set_control(text,integer,boolean,text,boolean,integer,boolean)','ma_ai_count_active(integer)','ma_ai_report_usage(uuid,uuid,jsonb)','ma_ai_course_spend(uuid,timestamptz)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---- ops views for the dashboard (service role / SQL editor only) --------------------------------------------------------------
create or replace view public.ma_ai_v_latency_hourly as
  select date_trunc('hour', created_at) as hour, count(*) as turns,
         percentile_cont(0.5)  within group (order by ttft_ms)    as ttft_p50_ms,
         percentile_cont(0.95) within group (order by ttft_ms)    as ttft_p95_ms,
         percentile_cont(0.99) within group (order by ttft_ms)    as ttft_p99_ms,
         percentile_cont(0.95) within group (order by latency_ms) as total_p95_ms,
         sum(cost_micro_usd) / 1e6 as cost_usd, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens
  from public.ma_ai_usage where ttft_ms is not null group by 1;
create or replace view public.ma_ai_v_failures_hourly as
  select date_trunc('hour', created_at) as hour, status, coalesce(error_code, '-') as error_code, count(*) as n
  from public.ma_ai_turns group by 1, 2, 3;
create or replace view public.ma_ai_v_course_month as
  select u.course_id, date_trunc('month', u.created_at) as month, sum(u.cost_micro_usd) / 1e6 as cost_usd, count(*) as turns, s.course_monthly_usd as budget_usd
  from public.ma_ai_usage u left join public.ma_ai_settings s on s.course_id = u.course_id group by 1, 2, s.course_monthly_usd;
create or replace view public.ma_ai_v_session_cost as      -- cost per completed session minute, from metered data
  select ss.id as session_id, ss.course_id, extract(epoch from (coalesce(ss.ended_at, ss.last_activity_at) - ss.started_at)) / 60 as minutes,
         coalesce(sum(u.cost_micro_usd), 0) / 1e6 as claude_usd, coalesce(m.asr_ms, 0) as asr_ms, coalesce(m.tts_ms, 0) as tts_ms, coalesce(m.avatar_bytes, 0) as avatar_bytes
  from public.ma_ai_sessions ss left join public.ma_ai_usage u on u.session_id = ss.id left join public.ma_ai_session_metrics m on m.session_id = ss.id
  group by ss.id, m.asr_ms, m.tts_ms, m.avatar_bytes;
revoke all on public.ma_ai_v_latency_hourly, public.ma_ai_v_failures_hourly, public.ma_ai_v_course_month, public.ma_ai_v_session_cost from anon, authenticated;

-- ============================ ROLLBACK ============================
-- drop view if exists public.ma_ai_v_session_cost, public.ma_ai_v_course_month, public.ma_ai_v_failures_hourly, public.ma_ai_v_latency_hourly;
-- drop function if exists public.ma_ai_course_spend(uuid,timestamptz), public.ma_ai_report_usage(uuid,uuid,jsonb), public.ma_ai_count_active(integer), public.ma_ai_set_control(text,integer,boolean,text,boolean,integer,boolean), public.ma_ai_get_control();
-- drop table if exists public.ma_ai_session_metrics, public.ma_ai_control;

-- ============================================================================
-- 003_im_ai_learning.sql  --  course-aware retrieval + learning records for the International Trade AI Instructor (pilot)
-- STATUS: NOT APPLIED. Requires 001 (and 002). Apply to the tournament project only with explicit approval.
-- Purely additive. Creates new ma_ai_* tables/functions and adds columns to ma_ai_settings (created by 001, itself not applied yet).
-- It touches NO existing course, lesson, enrollment, student, grade, exam or answer table. It only READS ma_course, ma_person,
-- ma_enrollment, ma_course_staff, ma_exam_attempt and ma_exam to decide who may see what.
--
-- Design decisions (see LEARNING.md):
--   * The textbook is not in the database today (it is a static HTML file), so there is no lesson table to reuse. Its text is indexed
--     into ma_ai_chunks, a DERIVED, rebuildable search index. Nothing here duplicates courses, lessons, enrolments or students.
--   * Retrieval = Postgres full-text search (english config, weighted title/heading/body) + structured lookup by section id + the
--     student's current chapter as a ranking signal. No extension is needed; pgvector is available on this project but is deliberately
--     NOT enabled (reasoning and the measurement that would change that decision are in LEARNING.md).
--   * Restricted material cannot be stored: ma_ai_chunks.kind is a closed list that has no answer, exam, rubric or key kind, so even
--     a faulty ingestion run cannot put them into the index (the ingestion tool also removes them before this point).
--   * Every read function re-checks enrolment/staff access itself, in addition to the Edge Function's checks. Defence in depth.
--   * Browser access: RLS on, no policies, all privileges revoked from anon/authenticated. Only the Edge Function (service role) uses these.
-- Rollback: see the end of this file.
-- ============================================================================

-- ---- instructor-configurable AI rules (columns on the settings table from 001) ----------------------------------------------------
alter table public.ma_ai_settings
  add column if not exists ai_policy text not null default 'full' check (ai_policy in ('full','hints_only','concepts_only')),
  add column if not exists allow_worked_solutions boolean not null default true,
  add column if not exists block_during_assessments boolean not null default true,
  add column if not exists learning_record_days integer not null default 180 check (learning_record_days between 0 and 730),
  add column if not exists store_mastery boolean not null default true;
comment on column public.ma_ai_settings.ai_policy is 'full = explain, example, worked solutions, practice; hints_only = never give final answers to problems; concepts_only = explain concepts, no problem help';
comment on column public.ma_ai_settings.learning_record_days is '0 = store no learning records (events, mastery, feedback) at all; N = delete them N days after they were written';

-- ---- content sources, which course may see which source, and the chunk index ---------------------------------------------------------
create table if not exists public.ma_ai_sources (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  title       text not null,
  kind        text not null default 'textbook' check (kind in ('textbook','lecture_notes','lesson','approved_material')),
  version     text not null default '',
  ingested_at timestamptz not null default now(),
  note        text
);

create table if not exists public.ma_ai_course_sources (
  course_id   uuid not null references public.ma_course(id) on delete cascade,
  source_id   text not null references public.ma_ai_sources(id) on delete cascade,
  max_chapter integer check (max_chapter between 0 and 200),          -- null = every chapter; set it to hide chapters the course has not reached
  primary key (course_id, source_id)
);

create table if not exists public.ma_ai_chunks (
  chunk_key  text primary key,                                         -- e.g. it-textbook:3.2#1  (stable across re-ingestion)
  source_id  text not null references public.ma_ai_sources(id) on delete cascade,
  source_key text not null,                                            -- the section: it-textbook:3.2  (what the instructor cites)
  chapter    integer not null,
  section    text not null,                                            -- 3.2 | 3.0 (overview) | 3.summary | 3.terms | 3.problems | 3.notes | 3.references
  heading    text not null,
  kind       text not null check (kind in ('lesson','example','data','warning','objectives','summary','term','problem','notes','reference')),
  ord        integer not null,
  pos        integer not null,                                         -- position within the chapter, for outline order
  title      text not null,
  body       text not null check (length(body) between 3 and 4000),
  fts        tsvector generated always as (
               setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', heading), 'B') || setweight(to_tsvector('english', body), 'C')
             ) stored
);
create index if not exists ma_ai_chunks_fts_idx on public.ma_ai_chunks using gin (fts);
create index if not exists ma_ai_chunks_section_idx on public.ma_ai_chunks (source_key, ord);
create index if not exists ma_ai_chunks_chapter_idx on public.ma_ai_chunks (source_id, chapter, pos);

-- ---- learning records (approved events only) --------------------------------------------------------------------------------------------
-- events: topics discussed, practice attempted/solved, requests for extra help. Topics are controlled keys (a section id), never free text,
-- and the free-text note column from 001 is forbidden, so a conversation can never leak into a learning record.
alter table public.ma_ai_events drop constraint if exists ma_ai_events_event_check;
alter table public.ma_ai_events add constraint ma_ai_events_event_check check (event in ('topic_discussed','help_requested','practice_attempted','practice_solved'));
alter table public.ma_ai_events drop constraint if exists ma_ai_events_no_note;
alter table public.ma_ai_events add constraint ma_ai_events_no_note check (note is null);
alter table public.ma_ai_events drop constraint if exists ma_ai_events_topic_key;
alter table public.ma_ai_events add constraint ma_ai_events_topic_key check (topic ~ '^[a-z0-9][a-z0-9._:#-]{0,63}$');
alter table public.ma_ai_events add column if not exists detail text check (detail in ('hint','worked_solution','explanation','example','check_reasoning','clarification'));

-- mastery: a Beta(alpha,beta) posterior per student, course and topic, updated ONLY from practice-question outcomes (never inferred from chat).
-- The estimate is alpha/(alpha+beta); the uncertainty is the spread of the same distribution, so few attempts = wide, honest intervals.
create table if not exists public.ma_ai_mastery (
  user_id   uuid not null,
  course_id uuid not null references public.ma_course(id) on delete cascade,
  topic_key text not null check (topic_key ~ '^[a-z0-9][a-z0-9._:#-]{0,63}$'),
  alpha     numeric not null default 1 check (alpha >= 1),
  beta      numeric not null default 1 check (beta >= 1),
  attempts  integer not null default 0,
  last_at   timestamptz not null default now(),
  primary key (user_id, course_id, topic_key)
);

-- feedback: chosen by the student from fixed options through the UI (not written by the model).
create table if not exists public.ma_ai_feedback (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  course_id  uuid not null references public.ma_course(id) on delete cascade,
  session_id uuid references public.ma_ai_sessions(id) on delete set null,
  turn_id    uuid,
  rating     text not null check (rating in ('helpful','not_helpful')),
  reason     text check (reason in ('too_hard','too_easy','incorrect','unclear','off_topic','other')),
  created_at timestamptz not null default now(),
  unique (user_id, turn_id)
);
create index if not exists ma_ai_feedback_course_idx on public.ma_ai_feedback (course_id, created_at desc);

-- practice rows now remember which section they came from (a controlled topic key), for mastery
alter table public.ma_ai_practice add column if not exists topic_key text check (topic_key ~ '^[a-z0-9][a-z0-9._:#-]{0,63}$');
alter table public.ma_ai_practice add column if not exists hinted boolean not null default false;

do $$ declare t text; begin
  foreach t in array array['ma_ai_sources','ma_ai_course_sources','ma_ai_chunks','ma_ai_mastery','ma_ai_feedback'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ---- who may read course content ---------------------------------------------------------------------------------------------------------
-- Mirrors the Edge Function's enrolment/staff rule. Payment and access-window rules are enforced by the Edge Function before any call
-- reaches here; this is the second lock. SECURITY DEFINER because the tables above are not readable by callers.
create or replace function public.ma_ai_can_read(p_user uuid, p_course uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ma_course c where c.id = p_course and c.owner_id = p_user::text)
      or exists (select 1 from public.ma_person p where p.user_id = p_user::text and p.role::text = 'admin')
      or exists (select 1 from public.ma_course_staff s where s.course_id = p_course and s.user_id = p_user::text and (s.can_view_grades or s.can_grade or s.can_edit_exams or s.can_view_roster))
      or exists (select 1 from public.ma_enrollment e where e.course_id = p_course and e.user_id = p_user::text and e.status::text = 'active');
$$;

-- ---- search: AND-match first, OR-match as a fallback, ranked, chapter-aware, kind-weighted ---------------------------------------------------
-- score is ts_rank_cd(weighted fts, query, 32) scaled by a per-kind weight, plus a bonus when every query term matched and a small bonus for
-- the student's current chapter (+/- 1). Score alone cannot say "the book does not cover this" (a weak match still scores ~0.5), so every row
-- also carries term coverage: how many of the question's content lexemes this chunk contains (matched/total) and how many lexemes appear
-- nowhere in the course's material (unknown). content.ts turns those into strong / weak / none.
create or replace function public.ma_ai_search_chunks(p_user uuid, p_course uuid, p_query text, p_chapter integer default null, p_limit integer default 4)
returns table (chunk_key text, source_key text, title text, chapter integer, section text, heading text, kind text, body text, score real, all_terms boolean, matched integer, total integer, unknown integer)
language plpgsql stable security definer set search_path = public as $$
declare q_and tsquery; q_or tsquery; lim integer := least(greatest(coalesce(p_limit, 4), 1), 8); raw text := left(coalesce(p_query, ''), 300);
        lex text[]; unk integer;
begin
  if not public.ma_ai_can_read(p_user, p_course) then return; end if;
  if length(btrim(raw)) < 2 then return; end if;
  q_and := plainto_tsquery('english', raw);
  q_or  := nullif(replace(q_and::text, ' & ', ' | '), '')::tsquery;
  if q_or is null then return; end if;
  lex := array(select l from unnest(string_to_array(replace(q_and::text, '''', ''), ' & ')) l where l <> '');
  select count(*)::int into unk from unnest(lex) l
    where not exists (select 1 from public.ma_ai_chunks c join public.ma_ai_course_sources cs on cs.source_id = c.source_id and cs.course_id = p_course
                      where c.fts @@ to_tsquery('simple', quote_literal(l)));
  return query
    select k.chunk_key, k.source_key, k.title, k.chapter, k.section, k.heading, k.kind, k.body,
           ( ts_rank_cd(k.fts, q_or, 32)
             * case k.kind when 'term' then 1.05 when 'lesson' then 1.0 when 'summary' then 1.0 when 'example' then 0.95 when 'warning' then 0.95
                           when 'data' then 0.9 when 'objectives' then 0.8 when 'problem' then 0.7 when 'notes' then 0.5 else 0.4 end
             + case when k.fts @@ q_and then 0.25 else 0 end
             + case when p_chapter is null then 0 when k.chapter = p_chapter then 0.08 when abs(k.chapter - p_chapter) = 1 then 0.03 else 0 end
           )::real as score,
           (k.fts @@ q_and) as all_terms,
           cardinality(array(select l from unnest(lex) l where l = any (tsvector_to_array(k.fts))))::int as matched,
           cardinality(lex)::int as total, unk as unknown
    from public.ma_ai_chunks k
    join public.ma_ai_course_sources cs on cs.source_id = k.source_id and cs.course_id = p_course
    where (cs.max_chapter is null or k.chapter <= cs.max_chapter) and k.fts @@ q_or
    order by 9 desc, k.chapter, k.pos
    limit lim;
end $$;

-- a whole section by its source key (what the instructor cited), lesson text first, capped
create or replace function public.ma_ai_get_section(p_user uuid, p_course uuid, p_source_key text)
returns table (chunk_key text, source_key text, title text, chapter integer, section text, heading text, kind text, ord integer, body text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ma_ai_can_read(p_user, p_course) then return; end if;
  return query
    select k.chunk_key, k.source_key, k.title, k.chapter, k.section, k.heading, k.kind, k.ord, k.body
    from public.ma_ai_chunks k join public.ma_ai_course_sources cs on cs.source_id = k.source_id and cs.course_id = p_course
    where k.source_key = left(p_source_key, 80) and (cs.max_chapter is null or k.chapter <= cs.max_chapter)
    order by k.pos limit 12;
end $$;

-- the table of contents the student can see (chapter, section, heading), so "summarize this lesson" has an exact target
create or replace function public.ma_ai_outline(p_user uuid, p_course uuid, p_chapter integer default null)
returns table (chapter integer, section text, source_key text, heading text, kind text, chunks integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ma_ai_can_read(p_user, p_course) then return; end if;
  return query
    select k.chapter, k.section, k.source_key, min(k.heading), min(k.kind), count(*)::int
    from public.ma_ai_chunks k join public.ma_ai_course_sources cs on cs.source_id = k.source_id and cs.course_id = p_course
    where (cs.max_chapter is null or k.chapter <= cs.max_chapter) and (p_chapter is null or k.chapter = p_chapter)
    group by k.chapter, k.section, k.source_key order by k.chapter, min(k.pos) limit 200;
end $$;

-- ---- ingestion (service role only): replaces ONE chapter of one source atomically ---------------------------------------------------------
create or replace function public.ma_ai_upsert_chunks(p_source text, p_version text, p_chapter integer, p_chunks jsonb, p_title text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if jsonb_typeof(p_chunks) <> 'array' or jsonb_array_length(p_chunks) = 0 or jsonb_array_length(p_chunks) > 600 then raise exception 'p_chunks must be a non-empty array of at most 600 chunks'; end if;
  if exists (select 1 from jsonb_array_elements(p_chunks) e where (e->>'chapter')::int <> p_chapter) then raise exception 'every chunk must belong to chapter %', p_chapter; end if;
  insert into public.ma_ai_sources (id, title, version) values (p_source, coalesce(p_title, p_source), p_version)
    on conflict (id) do update set version = excluded.version, title = coalesce(p_title, public.ma_ai_sources.title), ingested_at = now();
  delete from public.ma_ai_chunks where source_id = p_source and chapter = p_chapter;
  insert into public.ma_ai_chunks (chunk_key, source_id, source_key, chapter, section, heading, kind, ord, pos, title, body)
    select e->>'chunk_key', p_source, e->>'source_key', (e->>'chapter')::int, e->>'section', e->>'heading', e->>'kind', (e->>'ord')::int, t.i::int, e->>'title', e->>'body'
    from jsonb_array_elements(p_chunks) with ordinality as t(e, i);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.ma_ai_link_source(p_course uuid, p_source text, p_max_chapter integer default null)
returns void language sql security definer set search_path = public as $$
  insert into public.ma_ai_course_sources (course_id, source_id, max_chapter) values (p_course, p_source, p_max_chapter)
  on conflict (course_id, source_id) do update set max_chapter = excluded.max_chapter;
$$;

-- ---- assessment boundary: is this student in the middle of a quiz or exam right now? -----------------------------------------------------------
-- Uses the platform's own in-progress exam attempts. An attempt counts only inside the exam's time limit plus 15 minutes, so an
-- abandoned tab does not lock a student out for ever.
create or replace function public.ma_ai_assessment_active(p_user uuid, p_course uuid, p_now timestamptz default now())
returns boolean language sql stable security definer set search_path = public as $$
  -- Macro keeps no "in progress" marker on exam rows (rows are written when a student submits), so the signal is the proctoring heartbeat:
  -- a student whose proctor row for a currently open exam was touched within the exam's time limit + 15 minutes, and who has not submitted it yet.
  -- An UNPROCTORED exam leaves no heartbeat, so it cannot be detected here; the client hides the instructor during exams for those.
  select exists (
    select 1 from public.ma_proctor_events pe join public.ma_exam e on e.id::text = pe.exam_id
    where pe.student_id = p_user::text and pe.course_id = p_course
      and pe.updated_at > p_now - make_interval(mins => coalesce(e.time_limit_minutes, 60) + 15)
      and (e.closes_at is null or e.closes_at > p_now - interval '15 minutes')
      and not exists (select 1 from public.ma_exam_attempt a where a.exam_id = e.id and a.student_id = p_user::text and a.created_at >= pe.updated_at - interval '4 hours'));
$$;

-- ---- mastery (practice outcomes only) --------------------------------------------------------------------------------------------------------
create or replace function public.ma_ai_update_mastery(p_user uuid, p_course uuid, p_topic text, p_correct boolean, p_weight numeric default 1, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.ma_ai_mastery; w numeric := least(greatest(coalesce(p_weight, 1), 0.1), 1);
begin
  insert into public.ma_ai_mastery as t (user_id, course_id, topic_key, alpha, beta, attempts, last_at)
  values (p_user, p_course, p_topic, 1 + case when p_correct then w else 0 end, 1 + case when p_correct then 0 else 1 end, 1, p_now)
  on conflict (user_id, course_id, topic_key) do update set
    alpha = t.alpha + case when p_correct then w else 0 end, beta = t.beta + case when p_correct then 0 else 1 end, attempts = t.attempts + 1, last_at = p_now
  returning * into m;
  return jsonb_build_object('alpha', m.alpha, 'beta', m.beta, 'attempts', m.attempts);
end $$;

-- ---- student-initiated deletion of their own learning data in one course -----------------------------------------------------------------------
-- Removes sessions (and with them messages, turns and practice), events, mastery and feedback. Token/cost counters are kept (no content).
create or replace function public.ma_ai_delete_learner_data(p_user uuid, p_course uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a integer; b integer; c integer; d integer;
begin
  delete from public.ma_ai_events   where user_id = p_user and course_id = p_course; get diagnostics a = row_count;
  delete from public.ma_ai_mastery  where user_id = p_user and course_id = p_course; get diagnostics b = row_count;
  delete from public.ma_ai_feedback where user_id = p_user and course_id = p_course; get diagnostics c = row_count;
  delete from public.ma_ai_sessions where user_id = p_user and course_id = p_course; get diagnostics d = row_count;
  return jsonb_build_object('events', a, 'mastery', b, 'feedback', c, 'sessions', d);
end $$;

-- ---- retention for learning records ------------------------------------------------------------------------------------------------------------
-- Each course's ma_ai_settings.learning_record_days decides (default 180 when no settings row exists). Called from ma_ai_purge below.
create or replace function public.ma_ai_purge_learning(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; k integer;
begin
  delete from public.ma_ai_events e where e.created_at < p_now - make_interval(days => coalesce((select s.learning_record_days from public.ma_ai_settings s where s.course_id = e.course_id), 180)); get diagnostics k = row_count; n := n + k;
  delete from public.ma_ai_mastery m where m.last_at < p_now - make_interval(days => coalesce((select s.learning_record_days from public.ma_ai_settings s where s.course_id = m.course_id), 180)); get diagnostics k = row_count; n := n + k;
  delete from public.ma_ai_feedback f where f.created_at < p_now - make_interval(days => coalesce((select s.learning_record_days from public.ma_ai_settings s where s.course_id = f.course_id), 180)); get diagnostics k = row_count; n := n + k;
  return n;
end $$;

-- ma_ai_purge from 001, unchanged except for the last step: it now also purges expired learning records.
create or replace function public.ma_ai_purge(p_now timestamptz default now(), p_idle_ttl_seconds integer default 7200)
returns integer language plpgsql set search_path = public as $$
declare n integer := 0; k integer;
begin
  update public.ma_ai_sessions set state = 'ended', ended_at = p_now where ended_at is null and last_activity_at < p_now - make_interval(secs => p_idle_ttl_seconds);
  delete from public.ma_ai_messages where expires_at < p_now; get diagnostics k = row_count; n := n + k;
  delete from public.ma_ai_counters where scope = 'ud' and updated_at < p_now - interval '3 days';
  delete from public.ma_ai_sessions s where s.ended_at is not null and s.ended_at < p_now - interval '1 day'
    and not exists (select 1 from public.ma_ai_messages m where m.session_id = s.id);
  n := n + public.ma_ai_purge_learning(p_now);
  return n;
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'ma_ai_can_read(uuid,uuid)', 'ma_ai_search_chunks(uuid,uuid,text,integer,integer)', 'ma_ai_get_section(uuid,uuid,text)', 'ma_ai_outline(uuid,uuid,integer)',
    'ma_ai_upsert_chunks(text,text,integer,jsonb,text)', 'ma_ai_link_source(uuid,text,integer)', 'ma_ai_assessment_active(uuid,uuid,timestamptz)',
    'ma_ai_update_mastery(uuid,uuid,text,boolean,numeric,timestamptz)', 'ma_ai_delete_learner_data(uuid,uuid)', 'ma_ai_purge_learning(timestamptz)', 'ma_ai_purge(timestamptz,integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ============================ ROLLBACK (run manually; deletes the search index and all learning records) ============================
-- drop function if exists public.ma_ai_purge_learning(timestamptz), public.ma_ai_delete_learner_data(uuid,uuid), public.ma_ai_update_mastery(uuid,uuid,text,boolean,numeric,timestamptz),
--   public.ma_ai_assessment_active(uuid,uuid,timestamptz), public.ma_ai_link_source(uuid,text,integer), public.ma_ai_upsert_chunks(text,text,integer,jsonb,text),
--   public.ma_ai_outline(uuid,uuid,integer), public.ma_ai_get_section(uuid,uuid,text), public.ma_ai_search_chunks(uuid,uuid,text,integer,integer), public.ma_ai_can_read(uuid,uuid);
-- drop table if exists public.ma_ai_feedback, public.ma_ai_mastery, public.ma_ai_chunks, public.ma_ai_course_sources, public.ma_ai_sources;
-- alter table public.ma_ai_events drop constraint if exists ma_ai_events_no_note, drop constraint if exists ma_ai_events_topic_key, drop column if exists detail;
-- alter table public.ma_ai_practice drop column if exists topic_key, drop column if exists hinted;
-- alter table public.ma_ai_settings drop column if exists ai_policy, drop column if exists allow_worked_solutions, drop column if exists block_during_assessments, drop column if exists learning_record_days, drop column if exists store_mastery;
-- (then re-create ma_ai_purge from 001 to drop the call to ma_ai_purge_learning, and restore the original ma_ai_events event check)

-- 006: who pays for a course's AI instructor. Purely additive: one column on ma_ai_settings.
--   'instructor' (default, and what every existing course keeps) = the course owner's own stored key
--   'platform'                                                    = the platform key (its owner id is the AI_INSTRUCTOR_PLATFORM_KEY_OWNER secret)
-- Only a platform administrator can change it (enforced in the function, not here).
alter table public.ma_ai_settings
  add column if not exists payer text not null default 'platform' check (payer in ('instructor', 'platform'));
comment on column public.ma_ai_settings.payer is 'instructor = the course owner''s own API key pays; platform = MacroNations'' key pays (set by a platform admin, for paid-subscription courses)';
