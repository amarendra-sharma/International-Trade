-- 115_ma_ai_tick_schedule.sql -- run professor-mode standing instructions and apply due (held) grade changes every 5 minutes.
create extension if not exists pg_cron;
select cron.unschedule('ma-ai-prof-tick') where exists (select 1 from cron.job where jobname = 'ma-ai-prof-tick');
select cron.schedule('ma-ai-prof-tick', '*/5 * * * *', $$select public.ma_ai_prof_tick()$$);
