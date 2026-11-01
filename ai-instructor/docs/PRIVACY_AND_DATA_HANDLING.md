# Privacy and data handling (draft for the university's counsel)

This is a plain-language description of what the system does, written from the implementation. It is not legal advice and not a certification. Items marked **verify** were not checked for this draft.

## Roles
The university is the data owner and decides what Asha may do. MacroNations LLC hosts the service and processes student data on the university's instructions. The professor controls course settings.

## What is stored
| Data | Purpose | Retention |
|---|---|---|
| Account id, name, email, enrolment | Access and grading | Life of the account; removed on request or offboarding |
| Chat messages with Asha | Tutoring, continuity | `retention_days` per course (0 = deleted when the session ends) |
| Learning record (mastery per topic) | Personalised help | `learning_record_days` per course (default 180); students can view and delete it |
| Grades, submissions, attendance, appeals | Course record | Life of the course |
| Audit log of Asha's actions | Integrity and review | Life of the course; exportable as CSV |
| Usage and cost counters | Billing and caps | Life of the course |
| Exam camera frames or flags | Exam integrity | **verify** against the proctoring component before signing |
Voice runs in the student's browser (speech synthesis and local avatar files); audio is not sent to the AI provider. **verify** that no recording is made by the proctoring path.

## Who else sees data (subprocessors)
- Supabase: database, authentication, functions and storage for the tenant.
- The AI provider chosen per course (default Anthropic, model set in the AI panel): receives the text of the conversation and, when a student has agreed, the content of their own graded work, to write replies. It does not receive other students' work.
- GitHub: hosts source code only; no student data.
The professor can switch the provider; the list above must be updated to match.

## Student controls and safeguards
- Review of a student's graded work by the AI is off by default and needs the student's separate consent, and only after the item has closed for the whole class.
- Students can see and delete their learning record and can ask for a person (meeting or grade appeal) instead of the AI.
- The AI cannot change a grade by itself except through the professor-mode actions the professor enabled; every action is logged and can be undone, final grades wait in a hold (default 48 hours) before posting, and a Pause switch stops all actions.
- Student text is treated as data, never as instructions.
- AI provider keys are stored encrypted; ids in logs are hashed.

## FERPA position (for counsel to confirm)
Education records stay under the university's control; MacroNations acts as a service provider performing an institutional function under the university's direct control and uses the data only to deliver the service (the "school official" exception). The service does not sell student data, does not use it for advertising, and does not train models on it. **verify** the AI provider's terms for the provider and plan the university uses (data retention and training settings differ by plan).

## Requests and incidents
Access, correction and deletion requests are handled by MacroNations within 30 days of the university's instruction. Security incidents affecting student data are reported to the university without undue delay and within 72 hours of confirmation (draft commitment; adjust to the contract).
