# Threat model and control register

**Method:** STRIDE-informed initial review; confirm with the hospital's security/privacy officers and clinical safety team before deployment. This is not a penetration test or security certification.

| ID | Threat / impact | Core controls | Evidence to collect |
|---|---|---|---|
| T-01 | Stolen accounts expose health records | Argon2id, MFA, throttling, short idle/absolute session expiry, revocation | Authentication tests, MFA enrollment and recovery procedure |
| T-02 | Excess privileges or cross-facility browsing | Server-side deny-by-default RBAC, department/facility scope, periodic review | Permission matrix, negative API tests, access review records |
| T-03 | Sensitive HIV/GBV/mental-health disclosure | Separate sensitivity checks, safe-contact preferences, restricted search/exports, audited purpose | Cross-role tests, disclosure review, privacy assessment |
| T-04 | Insider snooping or unapproved changes | Access/change audit, privileged audit review, immutable amendment history, alerts | Audit integrity/retrieval test and monitoring evidence |
| T-05 | Emergency override becomes routine | Required reason, narrow patient/action scope, expiry, enhanced audit and retrospective review | Break-glass tests and monthly review sign-off |
| T-06 | Wrong-patient care from duplicate/identity error | Identifier authority/verification, human-reviewed duplicate candidates, approval-controlled merge | Duplicate/merge test cases and merge reconciliation |
| T-07 | SQL injection or API misuse | Parameterized SQL, Zod validation, bounded payloads, rate limits, CSP/security headers | Static/dependency tests and API validation suite |
| T-08 | Session theft/CSRF | HttpOnly/Secure/SameSite cookies, origin checks, CSRF defenses if cross-site flows are introduced, TLS | Browser security tests and TLS configuration review |
| T-09 | Integration spoofing/replay or PHI leakage | Authorized endpoints only, mutual/service authentication where specified, validation, idempotency, redacted logs | Contract tests, retry/reconciliation evidence |
| T-10 | Ransomware, loss or backup compromise | Encrypted offline/isolated backups, separate identities/keys, tested restoration, least privilege | Restore-drill report, RPO/RTO and key-rotation evidence |
| T-11 | Financial or stock double-posting | Transaction boundaries, unique idempotency keys, immutable postings and compensating reversals | Duplicate request/concurrency tests and reconciliation |
| T-12 | Insider/exported record disclosure | Export approval/permission, reason, minimum data, download audit, retention | Export tests and access-log review |
| T-13 | Unavailable system affects care | Downtime procedures, recovery objectives, monitored dependencies, tested backups | Clinical downtime drill and disaster-recovery exercise |
| T-14 | Misconfigured deployment/secrets | Managed secrets, least-privilege DB user, TLS, hardened headers, no secrets in Git | Configuration scan, secret scan and deployment review |

## Initial security baseline

1. Treat health data and patient identifiers as sensitive by default.
2. Enforce authorization at every protected server route; a hidden UI control is not access control.
3. Audit success and denial for sensitive access and all record, permission, export and break-glass changes.
4. Keep session tokens, credentials, encryption keys and clinical details out of logs.
5. Separate production data, credentials, backups and identities from development.
6. Define incident notification, retention, disposal and breach response with the accountable controller and ODPC/privacy lead.
7. Require security, privacy, clinical-safety and operational sign-off before any production pilot.
