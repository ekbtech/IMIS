# Payer-neutral finance and SHA integration architecture

## Separate the facts

Never infer guaranteed payment from a patient membership number. Persist independently:

1. Patient-reported payer/beneficiary relationship.
2. Authoritative eligibility response (source, request, response, timestamp and expiry).
3. Facility's signed provider contract and service scope.
4. Service-level preauthorization/referral decision and validity.
5. Effective-dated tariff/benefit version used to quote or cost a service.
6. Submitted claim, acknowledgement, adjudication/rejection, remittance and actual payment.

The user interface must distinguish **unknown**, **verified**, **ineligible**, **authorization required**, **approved**, **submitted**, **rejected**, **partially paid** and **paid** states. A displayed estimate is not an entitlement or promise of coverage.

## Model and processing

`Payer` → `Plan` → `FacilityContract` → effective-dated `BenefitRule`/`Tariff` → `EligibilityCheck` → `Authorization` → `EncounterCharge` → `Claim`/`ClaimLine` → `ClaimSubmission` → `Adjudication` → `Remittance` → `PaymentPosting`/`Reversal`.

Each submission has an idempotency key and immutable request/response metadata with sensitive payload access controls. Retries reuse the same idempotency identity. Corrections create a versioned resubmission linked to the rejected claim. Reconciliation compares encounter charge, submitted claim, adjudicated amount and bank/remittance posting.

Configuration records carry source, effective-from/to, approval and audit metadata. Rate or benefit changes never rewrite the rules used by historical encounters. Support multiple coverages but only apply coordination-of-benefit rules when the payer contract explicitly defines them.

## Kenya scheme/integration posture

The Social Health Insurance Act, 2023 is an authoritative statutory source; it does not by itself provide a current software interface, a facility-specific contract, real-time eligibility API, tariff or guarantee of reimbursement. Publicly accessible authoritative current 2026–2029 SHA provider-contracting, HAKIKA and HMIS integration technical specifications were not verified during this Phase 1 research. Therefore this repository defines no production endpoint, credential, tariff, benefit, eligibility claim or portal automation. Implement sandbox/test doubles until SHA/DHA provides authorized, versioned specifications and credentials.

Potential payer configurations include applicable SHA funds, private insurers, employer schemes, corporate accounts, self-pay, approved waivers/exemptions and other lawful arrangements. Activate each only after the hospital confirms contract, rules, service scope and effective dates.

## Current repository boundary

The source contains a disabled payer-neutral API slice for manually entered encounter charges, invoices from unbilled charges, and append-only debit/credit adjustments. Dedicated MFA-required finance clerk, biller and supervisor roles are department-scoped and exercise separate charge, invoice and adjustment permissions. The synthetic MySQL workflow covers the approval gate, API operations, idempotent replay, access denials, and encryption at rest.

This is not a complete finance or payer implementation. There is no finance user workspace, payer/plan, benefit, eligibility, authorization, tariff, claim, remittance, payment, tax, accounting-policy, or SHA integration model. The facility activation gate must remain disabled until the hospital approves the accounting workflow and supplies the applicable policies and effective-dated configuration. No operational activation process is provided by this slice.
