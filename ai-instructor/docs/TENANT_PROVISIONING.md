# Setting up a university (one tenant per university)

Model: each university gets its own Supabase project (its own database, users, keys and edge functions), the Macroeconomics site code, and its own domain. Nothing is shared between universities.

## Checklist (about half a day the first time)
1. **Create the Supabase project** in the MacroNations organisation (region near the university; choose the plan that includes daily backups and, if the university wants SSO, SAML).
2. **Apply the database.** Run the Macroeconomics schema migrations first, then the Asha migrations in `ai-instructor/server/migrations/` in numeric order (001 to 126). Re-run the check at the bottom of this file.
3. **Edge functions.** Deploy `ma-ai-instructor` (JWT required) and `ma-ai-autopilot` (no JWT, protected by `AUTOPILOT_SECRET`), each a loader that imports the pinned commit of `ai-instructor/server/it-ai-instructor` (see an existing loader for the exact form).
4. **Secrets** (Supabase, Edge Functions): `AI_INSTRUCTOR_KEK` (32 random bytes, base64; encrypts stored AI keys; losing it means every course owner re-enters their key), `AI_INSTRUCTOR_LOG_SALT` (random string; hashes ids in logs), `AI_INSTRUCTOR_ORIGINS` (the university's site origin, comma-separated; never `*` in production), `AUTOPILOT_SECRET` (random; must match the value stored for the scheduler in `ma_ai_secret`), and `AI_INSTRUCTOR_PLATFORM_KEY_OWNER` only if MacroNations pays for AI use.
5. **Scheduler (pg_cron).** Three jobs must exist: `ma-ai-class-tick` every minute (`select public.ma_ai_class_tick()`), `ma-ai-prof-tick` every 5 minutes (`select public.ma_ai_prof_tick()`), `ma-ai-autopilot` every 10 minutes (`select public.ma_ai_autopilot_kick()`). Enable the `pg_cron` and `pg_net` extensions first.
6. **Site.** Copy the Macroeconomics site to the university's domain (GitHub Pages or any static host). In `macronations-enhance.js`, point `fn` at the new project's `ma-ai-instructor` URL and the Supabase URL/anon key at the new project. Keep `courseIds: ['*']`.
7. **First staff account.** The professor signs up on the site; set them as course owner (create the course from the console, which creates the Asha settings row automatically).
8. **AI key and cost.** Decide who pays. Instructor-paid: the professor pastes a Claude key in the AI Instructor panel (stored encrypted, never shown again). Platform-paid: set the platform key owner. Set the monthly cap per course (default 200 USD) and the per-student daily token limit.
9. **Turn on Asha** in the course AI settings (on by default for new courses), then "Let Asha act as the professor". Autopilot switches stay off until the professor ticks them.
10. **Hand over:** give the professor `UNIVERSITY_READINESS.md`, the privacy notes and the accessibility statement; agree the data retention values for the course.

## Verification queries (run in the new project)
```sql
select count(*) from cron.job where jobname like 'ma-ai-%';                     -- expect 3
select proname from pg_proc where proname in ('ma_ai_prof_gate','ma_ai_final_calc','ma_ai_prof_inbox','ma_ai_prof_usage') ; -- expect 4
select course_id, enabled, professor_mode, course_monthly_usd from ma_ai_settings;
```
Then ask Asha "give me an overview of this course" in the professor's chat, run a one-section live class with a test student, and download the audit CSV.

## Offboarding
Export the audit log and grades, set `retention_days` to delete conversation text, then pause or delete the Supabase project. Deleting the project removes all student data.

## Platform billing view (MacroNations only)
`select * from ma_ai_v_billing order by month desc;` gives turns, users, enrolled students and AI cost per course per month (service role only; not exposed to the site).
