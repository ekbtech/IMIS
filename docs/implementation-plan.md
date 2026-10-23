# Implementation plan and milestone record

## Phases

1. **Requirements and design:** authoritative requirements register, architecture, ERD, threat model, payer model, repository and migration strategy.
2. **Security foundation:** authentication/MFA, sessions, RBAC, audit, facility/service configuration, migration and synthetic test infrastructure.
3. **Identity/access to care:** MPI, registration, human-reviewed duplicates, appointments, queues, OPD, emergency and referrals.
4. **Clinical/inpatient:** notes, observations, allergies, medication orders, admissions, beds, transfers and discharge.
5. **Diagnostics:** LIS, pharmacy, radiology/PACS integration boundaries, interface retries and reconciliation.
6. **Specialties:** theatre, maternity, paediatrics, ICU/HDU, configurable HIV/ART and TB workflows, rehabilitation, mental health, confidential GBV and mortuary.
7. **Finance/payers:** billing, effective-dated payer rules, SHA and other contracted workflows, claims and reconciliation.
8. **Operations:** procurement, stores, HR, biomedical equipment and facilities.
9. **Reporting/interoperability:** validated HMIS/national mappings, reporting, data quality and analytics.
10. **Readiness:** security/clinical validation, UAT, regulatory evidence, restore drills, downtime/recovery and controlled go-live.

## Gate for each module

Module is not complete until it has a migration and recovery procedure, backend permissions and validation, documented API contract, UI workflow, synthetic fixtures, unit/integration/access tests, operator instructions and known-defect review. No module can claim compliance or production readiness solely from passing software tests.

## Phase 1 status (2026-10-21)

- Verified official Kenya Law text URLs for the Digital Health Act, 2023; Data Protection Act, 2019; Social Health Insurance Act, 2023; and Primary Health Care Act, 2023.
- Current status and legal text of claimed 2025 Digital Health regulations, current SHA 2026–2029 contracting/HAKIKA requirements, and current DHA/SHA technical specifications remain pending authoritative verification.
- Architecture, core ERD, threat model and payer-neutral model established.
- Security and MPI foundations are present. The first OPD/emergency arrival-registration slice now has a migration, facility/permission-scoped APIs, an audited open queue, idempotent creation, an OpenAPI contract, a minimal role-gated UI and validation tests.
- A follow-on observation-recording slice adds an append-only measurement table, clinician permissions, facility-scoped read/write APIs, idempotent requests, an encounter UI, fixed unit labels and validation tests. It intentionally does not provide triage or clinical interpretation.
- A controlled clinical-note slice adds encrypted draft fields, author-only draft edits/signing, reasoned append-only amendments, encounter/facility-scoped routes, idempotency for creation/amendment, an encounter UI and an OpenAPI contract. Signing locks a version; the system does not provide clinical templates, decision support, departmental/purpose-based note visibility, or clinical validation.
- A disabled diagnostics scaffold adds facility activation gates, an empty locally configurable service catalog, a basic order/cancel lifecycle, idempotency and audit events. No services are seeded; diagnostic permissions are not granted to roles; every workflow requires a manually recorded approval gate. Results, specimen handling, review/release, interpretation, LIS/PACS connections and a UI are not implemented.
- A disabled inpatient scaffold adds facility activation gates, empty local ward/bed catalogs, encounter-linked admissions, idempotent bed assignments/transfers, and discharge events that close active assignments transactionally. No capacity, acuity, staffing, or specialty rules are assumed; permissions are not granted to roles and no configuration UI is implemented.
- A disabled payer-neutral finance API slice adds manual encounter charges, exact decimal invoice issuance from unbilled charges, encrypted descriptions/reasons, and append-only debit/credit adjustments. Migration `012` seeds dedicated MFA-required, finance-department-scoped clerk, biller and supervisor roles with separated permissions. A synthetic MySQL API workflow validates the approval gate, role/department boundaries, idempotency and encrypted persistence. No finance UI, tariffs, payer/benefit rules, claims, payments, accounting/tax policy, SHA interfaces or operational activation process are implemented.
- A disconnected integration-outbox scaffold adds facility-scoped approved-connection lookup, encrypted bounded payload persistence, SHA-256 payload hashes, idempotency, and pending reconciliation records. The schema includes delivery-attempt/reconciliation structures, but no worker, endpoint configuration, API route, retry execution, or network behavior exists. No current official interface contract or authorized test access is verified.
- A triage capture/review slice seeds only a `TRIAGE` department and distinct MFA-required triage-nurse and triage-clinician roles. Department assignments are enforced; the workflow stores append-only observations and routes them to clinician acknowledgement without acuity scoring, treatment recommendations or escalation logic. It is disabled by default and requires facility approval metadata before use.
- Migration `013` adds an explicitly permissioned shared encounter-context read for clinicians and triage roles. The API returns bounded encounter history and shares observations plus enabled triage/diagnostics/inpatient summaries only when the reader also has the relevant permission. OPD and triage workspaces can display this context. It excludes note contents, finance and government integrations; additional department workflows and a hospital-approved fine-grained care-team policy remain to be implemented.
- All eleven migrations have been applied successfully to a disposable MySQL 8.4.7 instance; the resulting schema contains 37 tables. A gated synthetic API test passed patient registration, OPD encounter creation, triage capture/review, observations and encrypted clinical-note persistence, plus permission and unassigned-department denial checks. This did not test clinical acuity, inpatient, diagnostics, finance, browser flows, rollback/concurrency, or a persistent facility database. WAMP MariaDB on port 3307 is not a substitute for the MySQL 8 target.
- No hospital name, facility licence, county SOP, payer contract, tariff schedule, operational dataset or real patient record has been assumed.

## Open decisions

- Facility identity, county, ownership and licensed/operational services.
- Data controller/processor determination, DPO/privacy lead, retention schedule and DPIA.
- Hosting/data-residency, identity provider, MFA policy, RPO/RTO and availability targets.
- Current authorized DHA/MoH/SHA interface specifications, conformance tests and sandbox access.
- Approved clinical terminology/formulary, referral policies and professional validation.
- Payer contracts, effective-dated tariffs, authorization and reconciliation rules.
