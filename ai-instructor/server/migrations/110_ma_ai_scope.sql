-- 110: what students may use the AI instructor for (Macroeconomics). Defaults are the strict, cost-saving ones. Same as Micro 104.
alter table public.ma_ai_settings
  add column if not exists scope_mode text not null default 'course_only' check (scope_mode in ('course_only', 'open')),
  add column if not exists use_textbook boolean not null default true,
  add column if not exists review_kinds text[] not null default array['exams', 'quizzes', 'assignments', 'arenas']::text[]
    check (review_kinds <@ array['exams', 'quizzes', 'assignments', 'arenas']::text[]);
