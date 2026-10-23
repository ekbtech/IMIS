# IHIS architecture baseline

**Status:** Phase 1 architecture baseline; not a production deployment or compliance attestation.  
**Scope:** Configurable Level 5 hospital; clinical services and payer arrangements are enabled only after facility management confirms service scope, licensing, ownership and operating procedures.

## System shape

Start with a TypeScript modular monolith: a React/TypeScript SPA and a versioned Express API share a deployment boundary while retaining domain-owned route, service, repository, schema and migration boundaries. MySQL 8 with InnoDB is the authoritative transactional store. Keep analytics, file/object storage, identity providers and external health/finance systems behind explicit interfaces. Do not put clinical data in client-side persistent storage, logs, URL query strings or third-party analytics.

```text
Registration / Clinical / Operations browser workspaces
                    | HTTPS, secure session cookie
           React + Router + Query + Zod
                    | /api/v1, input validation, RBAC and audit
       Express modular monolith (controllers/services/repos)
                    | parameterized SQL, transactions, outbox
       MySQL 8 (InnoDB) + migration ledger + audit/event tables
                    |
      adapters: DHA/HIE, SHA, KHIS/DHIS2, LIS, RIS/PACS
      adapters remain disabled until official contracts/access
```

## Module boundaries

| Domain | Owns | Initial dependencies |
|---|---|---|
| Identity and access | Users, roles, permissions, sessions, MFA enrollment, access decisions | Facility |
| Facility and configuration | Facility, department, service activation, terminology and effective-dated configuration | None |
| MPI and registration | Patient, identifiers, contacts, consent, duplicate candidates, merge review | Identity, facility |
| Encounters and clinical record | OPD/emergency, notes, diagnoses, observations, allergies, referrals | MPI |
| Orders and results | Lab, imaging, medication orders, results, dispensing | Encounter, catalog |
| Inpatient | Admission, ward, bed, transfer, discharge | Encounter, facility |
| Specialty workflows | Theatre, maternity, paediatrics, ICU/HDU, HIV/ART, TB, mental health, GBV, rehab, mortuary | Encounter; sensitivity policy |
| Finance and payer | Charge capture, payer/plan rules, eligibility, authorisation, claims, remittance | Encounter, effective-dated catalog |
| Supply chain and workforce | Procurement, stores, HR, biomedical assets | Facility, finance |
| Reporting and integration | Reporting datasets, outbound/inbound messages, reconciliation | Domain-owned export contracts |
| Audit and privacy | Access/change events, break-glass, disclosure/export, retention and review | All domains |

Use domain identifiers and explicit service contracts. Modules may share one database initially, but writes should go through the owning module's service. Integration adapters use an outbox/inbox, idempotency key, retry schedule and dead-letter/reconciliation workflow; no unauthorised portal automation or guessed national API. The current integration slice is limited to encrypted outbox persistence and pending reconciliation records. It has no delivery worker, endpoint configuration, HTTP/API route, or network behavior, and its migration/helper have not been validated against MySQL.

## Security and privacy architecture

- Deny by default; authorize at the API on each request with role, facility/department, action, purpose and record sensitivity.
- Department assignments are modeled separately from roles. Current enforcement is limited to the triage capture/review routes; other clinical routes remain facility-scoped until their workflows and access matrix are approved and implemented.
- Use short-lived, opaque server-side sessions, hashed session-token storage, HttpOnly/Secure/SameSite cookies, idle and absolute expiry, revocation, throttling and MFA for privileged/high-risk access.
- Use Argon2id password hashes; provision the first administrator through a one-time environment-controlled command and rotate/remove bootstrap credentials.
- Separate sensitive case data from ordinary patient search, queues, summaries and reports. GBV/HIV/mental-health and other controlled access requires a separate permission and audited purpose check.
- Break-glass is a time-bounded exceptional authorization with required reason, scope, enhanced audit and retrospective review; never a general bypass.
- Use TLS in deployed environments; encrypt database volumes, attachments and backups with managed keys and documented key rotation. A local development compose stack is not production-secure.
- Record access decisions and changes in append-only application audit events and forward them to protected monitoring/storage in deployment. Avoid clinical details, secrets and credentials in operational logs.
- Minimize data, apply approved retention/disposal schedules, control exports and test isolated backup restoration.

## Data ownership and consistency

The hospital is expected to determine controller/processor roles with counsel and data protection leadership. The MPI owns patient identity; encounters own visit context; clinical notes and results retain author, time and amendment provenance. Signed records are not overwritten: corrections are appended with reason, author and link to the superseded version. Financial balances and stock use transaction-safe postings with idempotency and compensating reversal events, not destructive edits.

Use UTC timestamps in storage and render East Africa Time (Africa/Nairobi) in the UI. Store Kenya-specific address/admin geography as versioned codes rather than free-text-only fields. Keep local/national identifiers typed and authority-scoped; do not assume all patients have a national ID or SHA membership.

## Deployment boundaries

Development: local-only MySQL Compose with synthetic data, no real patient information, explicit local secrets. Staging: separate accounts/data and approved synthetic/de-identified fixtures. Production: managed secret/key stores, TLS termination, private database networking, least-privilege identities, encrypted backup isolation, monitoring, incident response and restore drills. Production hosting, data location, RPO/RTO, retention and availability targets require hospital/county approval and legal assessment.

## Decision log

1. Modular monolith before microservices: keeps cross-domain clinical transactions tractable and minimizes operational burden.
2. MySQL/InnoDB: requested platform; schema and transactions are migration-controlled.
3. Payer-neutral versioned rules: SHA, PHCF, emergency/chronic/critical funds, private, employer, self-pay and approved waivers are configuration, not entitlement assumptions.
4. No national integration is enabled until DHA/MoH/SHA supplies a verified, current interface contract and authorized test access.
5. This architecture is a design baseline only; it does not claim legal compliance, DHA certification, SHA contracting, clinical validation or production approval.
