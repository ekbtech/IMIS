# Kenya Level 5 IHIS foundation

This is the initial engineering foundation for a modular Integrated Hospital Information and Electronic Medical Records System. It is **not** a complete hospital system, a clinical device, production-ready software, DHA-certified software or a claim of legal compliance. It contains no real patient data.

## Current milestone

The architecture, requirements register, ERD, threat model and payer model are documented under [`docs/`](./docs/). The register distinguishes verified Kenya Law statute texts from requirements that remain pending official verification. No SHA/DHA national API, tariff, coverage promise or credential has been invented.

The active implementation is a React/TypeScript + Tailwind + Express/TypeScript modular monolith with MySQL 8. Implemented foundation slices include authentication/session controls, MFA enrollment and verification, forced temporary-password change, staff provisioning, facility-scoped access, encrypted patient identity fields, MPI search/registration and human-reviewed duplicate candidates. Initial operational slices add facility-scoped OPD/emergency arrival registration, an open encounter queue, append-only observations, controlled clinical-note drafts/signatures, and a disabled-by-default triage capture/review workflow. Triage has separate triage-nurse and triage-clinician roles, department assignments and permission checks; it records observations only, without acuity scoring or treatment advice. Diagnostics order/cancel and inpatient admission/bed-assignment remain disabled scaffolds. Finance is a disabled API slice for manual charges, invoices and adjustments, not a complete finance system; local finance workflows are requested for a later phase. Migration 014 adds generic encrypted task/handover routing, migration 015 adds an illustrative `DEMO-L5` department/resource catalogue and audited role/permission administration, migration 016 adds facility-scoped role-to-department assignments, migration 017 categorizes departments into Hospital, Budget, Inventory, Procurement, HR, Finance, Administration, System tools, Morgue and Reports, migration 018 creates an inactive, permissionless Hospital staff role template for each active Hospital-group department, and migration 019 classifies Hospital departments into OPD/Outpatient, Emergency & Triage, Inpatient & Critical Care, Maternity & Newborn, Specialty Clinics, Diagnostics, Treatment & Support Services, and Other Hospital Services. Administrators can inspect all active department workspaces and mapped roles; staff navigation and workspace APIs limit visibility to their assigned departments and mapped active roles they hold. Authorized admins can change department groups and Hospital subgroups in the organization catalogue. Grouping is navigational and does not activate services or change permissions. Department-specific Hospital role templates are not assigned to departments, granted permissions, or activated automatically; administrators must explicitly configure and approve each role. Role/permission grants remain explicit and are not inferred from job titles. The administrator flow guides department setup → role selection/creation → department assignment and permission review; selected permissions, assignments and activation commit atomically, and activated roles require MFA. These foundations do not constitute operational department services or a facility-approved access matrix. Migration 021 adds encrypted, department-scoped appointment requests with audited request/confirm/decline/cancel history. Appointment times are entered in East Africa Time; a request does not reserve a schedule slot, and staff must verify availability before confirming. Migration 022 adds a bounded facility inventory catalogue and append-only stock receipt/issue ledger with batch tracking, locking, idempotency, and audit events; it does not add procurement, valuation, transfers, adjustments, or pharmacy dispensing. Migration 023 adds encrypted and audited Biomedical Engineering fault requests with assignment-scoped queues, idempotent submission, and acknowledgement/start/completion/cancellation status history. The maintenance workflow does not provide technician assignment, preventive schedules, or equipment safety/release certification. Migration 024 adds a department-scoped equipment register with unique facility asset tags, encrypted serial/location data, and audited registration, update and reassignment history. It excludes depreciation, financial valuation, insurance/disposal policy, and safety certification; maintenance requests are not yet linked to asset records. The national integration outbox remains disconnected, with no delivery worker, endpoint, or network behavior. The current local development instance uses MySQL 8.4.9 and has applied migrations through `024`. Focused synthetic MySQL tests cover password changes, appointment/inventory/handover lifecycles, and organization administration, but that is not a complete patient journey or production-readiness evidence. The maintenance and equipment-register MySQL lifecycle tests are gated and were not run against the local database. Triage, diagnostics, inpatient and finance must remain inactive pending facility approvals and completion of their workflows. See the [requirements coverage matrix](./docs/requirements-coverage.md) for the status of the user-provided full-system specification.

Migration 020 adds six facility-scoped, configurable divisions and seeds the 60 requested department catalogue entries, reusing existing department records where their codes already represent a requested unit. Existing additional departments are retained and assigned to a division. Administrators can create, edit, reorder and deactivate divisions, and reassign departments between active divisions. An active division cannot be deactivated while it still contains active departments. Division membership is organizational only: it does not create division-head accounts, grant permissions, activate clinical services or replace facility approval of roles and workflows.

## Windows development

Prerequisites: Node.js LTS, npm, Docker Desktop with Compose, and Git. From PowerShell in this folder:

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d --wait mysql
npm run db:migrate
npm run dev
```

The example configuration is for local development only. Before starting MySQL, replace both sample MySQL passwords and update the password in `DATABASE_URL` to match `MYSQL_PASSWORD` (URL-encode special characters). Never use sample passwords or seed accounts in production. API: `http://127.0.0.1:4000`; web: `http://127.0.0.1:5173`. Do not import live patient records. After migration, run `npm run db:seed:admin` in an interactive terminal and enter your own administrator username and password when prompted; the password must be at least 6 characters and is not echoed while typing. Alternatively, set `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` in the local environment for a non-interactive setup, then remove them after bootstrap. Six characters is a weak minimum; use a long, unique password, especially for administrator accounts. The one-time bootstrap refuses to replace an existing administrator. The bootstrap account has security/audit permissions only and no patient-care permissions.

Before development startup, set distinct random 32-byte keys in `.env` for `DATA_ENCRYPTION_KEY` and `PATIENT_LOOKUP_HMAC_KEY`. Generate each independently in PowerShell:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Do not reuse these keys between environments or commit them. Changing either key without a documented patient-data re-encryption or blind-index reindex procedure can make existing data unavailable or MPI duplicate checks incomplete. The bootstrap administrator must enroll MFA before its privileged actions.

## Migrations, recovery and backups

Migrations are versioned in `apps/api/migrations`. MySQL DDL can implicitly commit; migration application is recorded only after a migration succeeds and is not assumed to roll back atomically. Take a verified backup before applying production changes. Prefer a tested forward-fix when a migration partially succeeds; use its matching down migration only after confirming it is safe for the actual data and application version. Restore into an isolated environment before production recovery. See [`docs/disaster-recovery.md`](./docs/disaster-recovery.md) before any real deployment.

## Synthetic MySQL workflow test

The gated API workflow test creates synthetic users, a patient, an outpatient encounter, triage observations/review, a clinical note, and temporary department/role assignments. It enables triage using a synthetic test-only approval marker in the disposable test database. Run it only against a disposable MySQL 8 test database after migrations and local encryption keys are configured:

```powershell
$env:MYSQL_E2E = "1"
npm --workspace @imis/api run test -- test/mysql-workflow.test.ts
Remove-Item Env:MYSQL_E2E
```

It does not test clinical triage acuity, inpatient workflows, or every department. Do not point it at production, real patient data, or a shared database.

## Current limits

- Exact current 2025 regulations, DHA certification requirements, SHA 2026–2029/HAKIKA workflows, and technical interface specifications require verification with official instruments and authorized contacts.
- Migrations `001`–`015` are applied to the current local MySQL 8.4.9 development database. Focused `MYSQL_E2E=1` staff password-change boundary, department-workflow lifecycle/authorization, and organization-administration assertions have passed against synthetic data. A complete clean end-to-end run and migration rollback have not been verified; the larger test can fail if rerun against a database whose synthetic finance module setting was left enabled. Use a fresh isolated test database and clean fixtures before treating the full flow as validated.
- Triage is disabled by default and only supports observation capture plus clinician acknowledgement. It has no acuity scoring, complaint classification, urgent escalation, clinical decision support, or activation UI. Only the triage role assignments are department-scoped so far.
- Encounter observations have a synthetic database-backed API test, but clinical validation and device/workflow validation are not established.
- Controlled clinical notes have a synthetic MySQL create/read persistence test. The current note-read permission remains facility-scoped rather than department-, care-team-, purpose-, or sensitivity-scoped; clinical governance and browser workflow validation remain outstanding.
- Diagnostics and inpatient are not part of the synthetic patient workflow test. They default disabled, have no seeded catalog/ward/bed data or role grants, and must remain inactive pending approved facility workflows.
- Finance defaults disabled and has no tariffs, payer rules, claims or payment workflows. MFA-required charge-clerk, biller and supervisor roles have separate permissions and finance-department scoping, but there is no finance UI. Keep it inactive pending approved accounting policies.
- Triage and finance staff are assigned to their facility departments and receive role-specific permissions. Department resource administration and configurable roles exist, but no approved role matrix is supplied; all added catalogue roles are inactive and permissionless until explicitly configured. Care-team record scoping is not implemented.
- Clinicians and assigned triage staff can open a shared patient context from OPD and triage workspaces. It returns recent encounter history and permission-/activation-gated observations, triage, diagnostic-order and inpatient summaries; it does not expose note content or finance/government data.
- Department staff can route an encrypted task between assigned departments and record acknowledgement, progress, completion, rejection or cancellation with event history. This is handover/task routing only—not operational laboratory, imaging, pharmacy, procedure, inpatient, maternity, mortuary or other clinical workflows. The `DEMO-L5` catalogue is synthetic and does not assert that a real facility provides or licenses those services.
- The integration outbox migration is applied, but it only persists encrypted, bounded events and pending reconciliation state for explicitly approved facility configuration. No delivery worker, external endpoint, API route, retry execution, or network call exists. Do not configure or activate a national connection until current official contracts and authorized test access are verified.
- The initial login rate limit uses process-local memory and is not a distributed control; production deployment requires a shared limiter/edge protection and a reviewed proxy/TLS configuration.
- Facility, county, ownership, licence, clinical protocols, staff roles, payer contracts, tariffs, approved terminology and service activation are not yet supplied.
- Do not connect production systems or enter identifiable patient data until hospital governance, privacy, security, clinical safety, interoperability and legal approvals are complete.
