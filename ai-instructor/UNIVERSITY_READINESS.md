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

## Not built yet (needs a decision or a contract)
- Single sign-on (SAML/OIDC) and LMS grade passback (LTI): planned as a per-university connector.
- Per-university branding, custom domain and a separate database per tenant: one tenant per university is the chosen model; provisioning is manual today.
- A written data-processing agreement, retention schedule and accessibility statement for each customer.
- Makeup exams are open to any enrolled student (the rule keeps the better score); eligibility lists are not enforced.
