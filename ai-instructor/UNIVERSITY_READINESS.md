# Asha for universities: what is built, what a university should know

Status as of this build. This is a technical summary, not legal advice or a compliance certification; each university's counsel and registrar decide what satisfies FERPA, accessibility and records policy.

## What runs without a human
Syllabus, planned lectures (voice, attendance, recap announcements), exams from the question bank (camera required), quiz/arena/assignment schedule, grading of assignments and exams, final grades computed from the published weights and late policy, queued behind a hold (default 48 h, 1 to 168) before they post.

## Human control (kept on purpose)
- Professor mode, each action type, and a Pause switch are per course, set by the course owner.
- Every action is logged (who: chat or scheduler; what; before/after) and undoable; held final grades can be cancelled with one undo during the hold.
- A daily action cap per course stops runaway behaviour.
- Audit log export (CSV from the Teach panel) for registrar or integrity review.
- Student questions Asha cannot answer go to a queue the professor reads; students cannot make her skip or reorder a lecture (per-class question limits, spacing and length limits).

## Data handling facts (from the implementation)
- One database project per deployment; students are identified by account id. Per-course settings control retention of conversation text (retention_days) and the learning record (learning_record_days); check the values for each course before a pilot.
- The AI provider key is held per course owner (instructor-paid or platform-paid); there is a per-course monthly spend cap and a per-student daily token cap.
- Exam and assignment text from students is treated as data, never as instructions to the AI.
- Camera proctoring is the platform's existing proctoring; consent is shown before an exam starts.

## Built for rollout (this build)
- Review inbox: one place for meeting requests, grade appeals, student questions held for the professor, and held grade changes, with replies the student sees. Asha can summarise and close items on the professor's decision (she cannot decide an appeal).
- Grade appeals from students (a button in the chat window), recorded and answered; an appeal never changes a grade by itself.
- Mute or remove a student during a live class (professor or Asha), logged and reversible.
- Makeup exams: open to everyone by default; the professor can require approval and approve students one by one.
- Usage and cost report with CSV for each course; platform billing view for MacroNations.
- Default monthly AI cap raised to 200 USD per course for autonomous courses.
- Rollout kit in `docs/`: tenant setup, SSO and LMS notes, privacy notes, data processing addendum template, accessibility statement draft.

## Not built (needs a university or a contract)
- SSO connection and LTI 1.3 launch and grade passback: documented in `docs/SSO_AND_LMS_INTEGRATION.md`; needs the university's identity provider and a sandbox LMS to build and test.
- Per-university branding and automated provisioning: manual checklist in `docs/TENANT_PROVISIONING.md`.
- Signed data-processing agreement, security questionnaire answers, and the accessibility audit: drafts only.
