# Initial data dictionary

This dictionary includes the implemented foundation, encounter-registration/observation fields, controlled clinical-note fields, disabled triage/diagnostics/inpatient/finance APIs, and the disconnected integration-outbox schema. Other listed entities remain target concepts until their module migrations are created.

| Field | Definition | Sensitivity / rules |
|---|---|---|
| `facility_id` | Internal identifier for a hospital/site | Access boundary; never infer licence |
| `patient_id` | Stable internal MPI identity | Sensitive; not a clinical or national identifier |
| `record_number` | Facility-issued identifier | Unique per facility, printable, never used as sole identity proof |
| `identifier_type/value/authority` | Patient identity document or scheme reference | Minimize; normalize by type; store issuing authority and verification status |
| `encounter_id/encounter_uuid` | Numeric internal key and stable public encounter identifier | Links an arrival to patient and facility; public UUID is returned to clients |
| `encounter_type/status` | OPD or emergency; open, closed, or cancelled | State transitions must be authorized and audited; only open registration exists so far |
| `idempotency_key` | Client UUID for a retryable encounter-create request | Unique per facility; reuse with differing patient/type is rejected |
| `opened_at` | Encounter registration timestamp in UTC | Rendered in Africa/Nairobi; no clinical triage time is implied |
| `observation_uuid` | Stable identifier for one append-only set of measurements | Returned to authorized clients; never embeds patient information |
| `systolic_bp_mmhg/diastolic_bp_mmhg` | Paired blood-pressure values in mmHg | Both required together; software does not interpret or classify them |
| `pulse_bpm/respiratory_rate_bpm` | Pulse and respiratory rate values | Units are fixed and visible; no normal range or decision rule is applied |
| `temperature_celsius/oxygen_saturation_percent` | Temperature in °C and saturation in percent | Saturation is limited to its 0–100 unit scale; no clinical interpretation |
| `weight_kg/height_cm` | Weight in kg and height in cm | Optional measurements; not used for clinical calculations |
| `recorded_by/recorded_at` | Authenticated staff account and server-side UTC timestamp | Provenance is immutable; changes require a later recorded set rather than overwrite |
| `user_departments.facility_id/department_id` | Facility-specific staff department assignment | Enforced for triage and finance API roles; not yet enforced by general encounters, notes, or other specialties. |
| `triage_module_settings.enabled` | Facility triage activation gate | Defaults false; enabling requires a workflow reference and approver/time metadata. No activation UI exists and metadata alone does not establish clinical approval. |
| `triage_assessments.triage_uuid/encounter_id/observation_id` | Public triage workflow ID linked to an encounter and append-only observation set | No patient demographics are copied into the triage record; only one pending review per encounter is allowed. |
| `triage_assessments.status/captured_by/captured_at/reviewed_by/reviewed_at` | Capture and clinician acknowledgement state/provenance | Review changes status only; no triage category, urgency score, advice, disposition or escalation is calculated. |
| `triage_nurse/triage_clinician` roles | Separate MFA-required roles for triage capture versus review | Limited to assigned facility triage department; no department-specific permission grants are yet configured for other services. |
| `note_uuid/root_note_uuid/parent_note_id` | Public note identifier, amendment-chain root, and prior database note key | Links note versions; signed versions remain immutable. Parent key is internal and not a patient identifier. |
| `note_type/title_ciphertext/content_ciphertext` | Note category and AES-256-GCM encrypted title/content | Plaintext exists only in authorized API responses; configured encryption key required. Clinical content must be authored by staff. |
| `status/version_number` | Draft or signed state and version in an amendment chain | Draft edits are author-only; signing records signer/time and locks that version. |
| `amendment_reason_ciphertext` | Encrypted reason for creating a new version after signing | Required for amendments; stored encrypted and linked to its parent version. |
| `authored_by/signed_by/signed_at` | Note author, authenticated signer, and signature timestamp | Signing currently requires the original author; identity and timestamp are audit-relevant. |
| `diagnostic_module_settings.enabled` | Facility diagnostics activation gate | Defaults false; workflow approval reference, approver and timestamp are mandatory when enabled. No API exposes activation. |
| `diagnostic_services.service_code/display_name/category_code` | Facility-local diagnostic service identifiers | No standard terminology or active services are seeded; activation requires local approval provenance. |
| `diagnostic_orders.order_uuid/service_id/status` | Public order identifier, selected local service and ordered/cancelled state | Facility/encounter scoped and idempotent; results/specimens are outside this scaffold. |
| `diagnostic_orders.requested_by/requested_at/cancelled_by/cancelled_at` | Order/cancellation actor and server timestamps | Immutable audit event accompanies order state changes; database/application testing remains pending. |
| `inpatient_module_settings.enabled` | Facility inpatient activation gate | Defaults false; workflow approval reference, approver and timestamp are mandatory when enabled. No API exposes activation. |
| `inpatient_wards.ward_code/display_name` | Facility-local ward identifier and label | No national code set or ward list is assumed; active entries require recorded approval provenance. |
| `inpatient_beds.bed_code/ward_id` | Facility-local bed label and parent ward | No capacity, staffing, acuity or specialty assumptions are stored. Active entries require approval provenance. |
| `inpatient_admissions.admission_uuid/status` | Public admission identifier and active/discharged state | Linked to an encounter and facility; only one active admission per encounter is allowed by a generated unique key. |
| `inpatient_bed_assignments.admission_id/bed_id/assigned_at/ended_at` | Bed occupancy history and assignment period | Transactional transfer/discharge closes the prior assignment; generated unique keys prevent concurrent active use conflicts. |
| `finance_module_settings.enabled` | Facility finance activation gate | Defaults false; activation requires a workflow reference, approver and timestamp. No API can activate it. |
| `finance_charges.amount/currency_code` | Manually supplied unbilled charge | Exact decimal text is canonicalized to two places and stored as SQL `DECIMAL`; not tariff-derived or a coverage guarantee. |
| `finance_charges.description_ciphertext` | Encrypted local charge description | AES-256-GCM encryption at rest; plaintext is returned only to authorized finance reads. |
| `finance_invoices.subtotal_amount/currency_code` | Issued invoice amount and currency | Sum of up to 500 oldest unbilled same-currency charges; original charge lines are snapshotted and cannot be billed twice. |
| `finance_adjustments.adjustment_type/amount/reason_ciphertext` | Append-only debit/credit adjustment and encrypted reason | Adjustment is not a payment, refund, claim or adjudication; exact amounts and actor/time provenance are retained. |
| `finance_clerk/finance_biller/finance_supervisor` roles | MFA-required finance roles with charge, invoice and adjustment permissions separated across roles | Each provisioned user is assigned to the finance department at the facility. Module operations still fail closed until the facility approval gate is satisfied. |
| `integration_connections.facility_id/integration_code/status` | Facility-specific logical connection and disabled/enabled marker | No endpoint or credential fields exist; enabled state requires specification/approval evidence in the schema, not proof of valid approval. |
| `integration_connections.specification_reference/approved_by/approved_at` | Reference and approver metadata for a future verified interface contract | Must point to an independently verified current contract; no current national contract or authorized sandbox is configured. |
| `integration_outbox.idempotency_key/event_type/source_resource_type/source_resource_id` | Event identity and originating domain resource | Unique within facility and integration code; no external delivery or API is implemented. |
| `integration_outbox.payload_ciphertext/payload_hash` | AES-256-GCM encrypted bounded JSON payload and SHA-256 digest of its serialized form | Payloads are limited to 16,000 UTF-8 bytes and reject endpoint/credential-shaped property names; configured encryption key required. No external contract mapping is assumed. |
| `integration_outbox.status/attempt_count/next_attempt_at/delivered_at` | Queue and future delivery state | Initial messages remain `queued`; no worker changes state or performs retries/network requests. |
| `integration_delivery_attempts.*` | Future attempt timing, outcome and response hash metadata | Schema only; no attempt is made or recorded. |
| `integration_reconciliation.status/evidence_reference/reconciled_by/reconciled_at` | Pending outbound event reconciliation and future human-reviewed evidence | A pending row is created with each outbox event; no reconciliation API/UI exists. |
| `user_id` | Staff application identity | Must map to an active, verified staff account |
| `role/permission` | Named job function and allowed action | Least privilege; changes audited |
| `session_token_hash` | One-way digest of random bearer token | Never store/log plaintext token; expires and revokes server-side |
| `audit_event` | Actor, action, target, outcome and timestamp | Protected from alteration; exclude credentials and unnecessary clinical detail |
| `break_glass_event` | Emergency access reason, scope, expiry and review | Enhanced audit; separate permission; never implicit |
| `effective_from/to` | Validity period for rules/contracts | UTC; preserve old version for historical calculation |

The controlled-note schema is implemented as migration source only; MySQL application, storage constraints, and transaction behavior have not been validated in this environment.
