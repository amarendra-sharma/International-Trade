# Single sign-on and LMS integration

Status: **the account system supports it; the per-university connection is configured, not coded.** Nothing here was tested against a real university identity provider, because that needs the university's cooperation.

## Sign-in (SSO)
The platform signs users in with Supabase Auth. Supabase Auth supports SAML 2.0 enterprise SSO and generic OpenID Connect providers (SAML SSO requires a plan that includes it; confirm on the current Supabase pricing page before quoting a university).
Steps per university:
1. Ask the university IT office for their IdP metadata (SAML metadata URL, or OIDC issuer, client id and secret) and the attribute that carries email and name.
2. Register the IdP in the university's Supabase project (`supabase sso add` or the dashboard) with the university's email domain.
3. Add a "Sign in with your university" button on the site that calls `signInWithSSO({ domain })`.
4. Test with one staff and one student account. The first sign-in creates the user; enrol them in the course as usual (roster upload or join code).
5. Optionally disable password sign-up for that domain.

## Roster and grades with the LMS (LTI 1.3)
Most universities expect the tool to launch from Canvas, Blackboard or Moodle and send grades back. That is the LTI 1.3 standard (OIDC launch, signed JWT, Assignment and Grade Services, Names and Roles). It is **not built**: it is a security-sensitive integration that should be written against the university's test LMS, not blind.
Recommended scope when a university asks:
- Phase 1, launch only: an edge function that accepts the LTI launch, verifies the platform's signature, maps the LMS user to a platform account by email and drops them into the course. About 3 to 5 days including testing on their sandbox.
- Phase 2, grade passback: send the final grade and assignment scores back through Assignment and Grade Services. About 3 to 5 further days.
Interim workaround that needs no integration: export grades (the console grade export and the audit CSV) and import them into the LMS gradebook.

## What to ask the university
IdP type and metadata, email domain, whether students are auto-provisioned, LMS vendor and a sandbox course, who approves a data-processing agreement, and whether they require a vendor security questionnaire (HECVAT).
