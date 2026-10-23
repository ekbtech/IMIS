ALTER TABLE departments
  ADD COLUMN unit_type ENUM('department', 'ward', 'clinic', 'store', 'service_unit', 'other')
    NOT NULL DEFAULT 'department',
  ADD COLUMN parent_department_id BIGINT UNSIGNED NULL,
  ADD COLUMN display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ADD KEY ix_departments_parent_order (facility_id, parent_department_id, display_order, name),
  ADD CONSTRAINT fk_departments_parent
    FOREIGN KEY (facility_id, parent_department_id)
    REFERENCES departments(facility_id, department_id);

ALTER TABLE roles
  ADD COLUMN description VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0;

UPDATE departments d
JOIN facilities f ON f.facility_id = d.facility_id
SET d.unit_type = CASE d.department_code
  WHEN 'OPD' THEN 'clinic'
  WHEN 'MATERNITY' THEN 'ward'
  WHEN 'WARD' THEN 'ward'
  WHEN 'ICU' THEN 'ward'
  WHEN 'NICU' THEN 'ward'
  WHEN 'STORES' THEN 'store'
  ELSE 'department'
END
WHERE f.facility_code = 'DEMO-L5';

UPDATE roles
SET description = CASE role_code
  WHEN 'system_admin' THEN 'Protected technical administrator, assigned only through the approved bootstrap process.'
  WHEN 'registration_clerk' THEN 'Register patient identity and authorized facility arrivals.'
  WHEN 'clinician' THEN 'Clinical role, grants remain subject to the approved facility permission matrix.'
  WHEN 'privacy_officer' THEN 'Privacy oversight role, access remains subject to approved policy.'
  WHEN 'triage_nurse' THEN 'Triage capture role, use only within its separately approved workflow.'
  WHEN 'triage_clinician' THEN 'Triage review role, use only within its separately approved workflow.'
  WHEN 'finance_clerk' THEN 'Finance workflow role, local use requires separate activation and approval.'
  WHEN 'finance_biller' THEN 'Finance workflow role, local use requires separate activation and approval.'
  WHEN 'finance_supervisor' THEN 'Finance workflow role, local use requires separate activation and approval.'
  WHEN 'department_staff' THEN 'Generic department handover role, not a clinical specialty role.'
  ELSE description
END
WHERE description = '';

CREATE TABLE organization_catalog_seeded_departments (
  facility_id BIGINT UNSIGNED NOT NULL,
  department_code VARCHAR(64) NOT NULL,
  PRIMARY KEY (facility_id, department_code),
  CONSTRAINT fk_org_catalog_department_facility
    FOREIGN KEY (facility_id) REFERENCES facilities(facility_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO organization_catalog_seeded_departments (facility_id, department_code)
SELECT f.facility_id, catalog.department_code
FROM facilities f
CROSS JOIN (
  SELECT 'GENERAL_MEDICINE' AS department_code UNION ALL
  SELECT 'GENERAL_SURGERY' UNION ALL
  SELECT 'PAEDIATRICS' UNION ALL
  SELECT 'OBSTETRICS_GYNAECOLOGY' UNION ALL
  SELECT 'ORTHOPAEDICS' UNION ALL
  SELECT 'UROLOGY' UNION ALL
  SELECT 'CARDIOLOGY' UNION ALL
  SELECT 'NEUROLOGY' UNION ALL
  SELECT 'DERMATOLOGY' UNION ALL
  SELECT 'PALLIATIVE_CARE' UNION ALL
  SELECT 'BURNS' UNION ALL
  SELECT 'HDU' UNION ALL
  SELECT 'ANC' UNION ALL
  SELECT 'PNC' UNION ALL
  SELECT 'FAMILY_PLANNING' UNION ALL
  SELECT 'CHILD_WELFARE' UNION ALL
  SELECT 'LABOUR_WARD' UNION ALL
  SELECT 'POSTNATAL_WARD' UNION ALL
  SELECT 'CSSD' UNION ALL
  SELECT 'ENDOSCOPY' UNION ALL
  SELECT 'PHYSIOTHERAPY' UNION ALL
  SELECT 'OCCUPATIONAL_THERAPY' UNION ALL
  SELECT 'SPEECH_THERAPY' UNION ALL
  SELECT 'CATERING' UNION ALL
  SELECT 'LAUNDRY' UNION ALL
  SELECT 'CLEANING' UNION ALL
  SELECT 'SECURITY' UNION ALL
  SELECT 'WASTE_MANAGEMENT' UNION ALL
  SELECT 'QUALITY' UNION ALL
  SELECT 'RESEARCH' UNION ALL
  SELECT 'RECORDS' UNION ALL
  SELECT 'ICT' UNION ALL
  SELECT 'STAFF_HEALTH' UNION ALL
  SELECT 'OUTREACH' UNION ALL
  SELECT 'CHAPLAINCY' UNION ALL
  SELECT 'EYE_CLINIC' UNION ALL
  SELECT 'DENTAL_CLINIC' UNION ALL
  SELECT 'RENAL_CLINIC'
) AS catalog
WHERE f.facility_code = 'DEMO-L5'
  AND f.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM departments existing
    WHERE existing.facility_id = f.facility_id
      AND existing.department_code = catalog.department_code
  );

INSERT INTO departments
  (facility_id, department_code, name, status, unit_type, display_order)
SELECT seeded.facility_id, seeded.department_code,
       CASE seeded.department_code
         WHEN 'GENERAL_MEDICINE' THEN 'General Medicine'
         WHEN 'GENERAL_SURGERY' THEN 'General Surgery'
         WHEN 'PAEDIATRICS' THEN 'Paediatrics'
         WHEN 'OBSTETRICS_GYNAECOLOGY' THEN 'Obstetrics and Gynaecology'
         WHEN 'ORTHOPAEDICS' THEN 'Orthopaedics'
         WHEN 'UROLOGY' THEN 'Urology'
         WHEN 'CARDIOLOGY' THEN 'Cardiology'
         WHEN 'NEUROLOGY' THEN 'Neurology'
         WHEN 'DERMATOLOGY' THEN 'Dermatology'
         WHEN 'PALLIATIVE_CARE' THEN 'Palliative Care'
         WHEN 'BURNS' THEN 'Burns Unit'
         WHEN 'HDU' THEN 'High Dependency Unit'
         WHEN 'ANC' THEN 'Antenatal Clinic'
         WHEN 'PNC' THEN 'Postnatal Clinic'
         WHEN 'FAMILY_PLANNING' THEN 'Family Planning'
         WHEN 'CHILD_WELFARE' THEN 'Child Welfare Clinic'
         WHEN 'LABOUR_WARD' THEN 'Labour Ward'
         WHEN 'POSTNATAL_WARD' THEN 'Postnatal Ward'
         WHEN 'CSSD' THEN 'Central Sterile Services'
         WHEN 'ENDOSCOPY' THEN 'Endoscopy'
         WHEN 'PHYSIOTHERAPY' THEN 'Physiotherapy'
         WHEN 'OCCUPATIONAL_THERAPY' THEN 'Occupational Therapy'
         WHEN 'SPEECH_THERAPY' THEN 'Speech Therapy'
         WHEN 'CATERING' THEN 'Catering and Diet Kitchen'
         WHEN 'LAUNDRY' THEN 'Laundry'
         WHEN 'CLEANING' THEN 'Cleaning Services'
         WHEN 'SECURITY' THEN 'Security Services'
         WHEN 'WASTE_MANAGEMENT' THEN 'Medical Waste Management'
         WHEN 'QUALITY' THEN 'Quality Assurance'
         WHEN 'RESEARCH' THEN 'Research and Ethics'
         WHEN 'RECORDS' THEN 'Health Records'
         WHEN 'ICT' THEN 'Information and Communication Technology'
         WHEN 'STAFF_HEALTH' THEN 'Staff Health Services'
         WHEN 'OUTREACH' THEN 'Community Outreach'
         WHEN 'CHAPLAINCY' THEN 'Chaplaincy'
         WHEN 'EYE_CLINIC' THEN 'Eye Clinic'
         WHEN 'DENTAL_CLINIC' THEN 'Dental Clinic'
         WHEN 'RENAL_CLINIC' THEN 'Renal Clinic'
       END,
       'active',
       CASE
         WHEN seeded.department_code IN ('HDU', 'BURNS', 'LABOUR_WARD', 'POSTNATAL_WARD') THEN 'ward'
         WHEN seeded.department_code IN (
           'ANC', 'PNC', 'FAMILY_PLANNING', 'CHILD_WELFARE',
           'EYE_CLINIC', 'DENTAL_CLINIC', 'RENAL_CLINIC'
         ) THEN 'clinic'
         WHEN seeded.department_code IN ('CATERING', 'LAUNDRY') THEN 'service_unit'
         ELSE 'department'
       END,
       ROW_NUMBER() OVER (ORDER BY seeded.department_code)
FROM organization_catalog_seeded_departments seeded;

CREATE TABLE organization_catalog_seeded_roles (
  role_code VARCHAR(64) NOT NULL PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO organization_catalog_seeded_roles (role_code)
SELECT catalog.role_code
FROM (
  SELECT 'nurse' AS role_code UNION ALL
  SELECT 'laboratory_technician' UNION ALL
  SELECT 'radiology_technician' UNION ALL
  SELECT 'pharmacist' UNION ALL
  SELECT 'procurement_officer' UNION ALL
  SELECT 'storekeeper' UNION ALL
  SELECT 'finance_officer' UNION ALL
  SELECT 'hr_officer' UNION ALL
  SELECT 'biomedical_engineer' UNION ALL
  SELECT 'maintenance_engineer' UNION ALL
  SELECT 'health_records_officer' UNION ALL
  SELECT 'quality_assurance_officer' UNION ALL
  SELECT 'internal_auditor' UNION ALL
  SELECT 'security_officer' UNION ALL
  SELECT 'department_head' UNION ALL
  SELECT 'reporting_officer' UNION ALL
  SELECT 'mortuary_attendant'
) AS catalog
WHERE NOT EXISTS (
  SELECT 1 FROM roles existing WHERE existing.role_code = catalog.role_code
);

INSERT INTO roles (role_code, name, status, mfa_required, description, display_order)
SELECT role_code,
       CASE role_code
         WHEN 'nurse' THEN 'Nurse'
         WHEN 'laboratory_technician' THEN 'Laboratory technician'
         WHEN 'radiology_technician' THEN 'Radiology technician'
         WHEN 'pharmacist' THEN 'Pharmacist'
         WHEN 'procurement_officer' THEN 'Procurement officer'
         WHEN 'storekeeper' THEN 'Storekeeper'
         WHEN 'finance_officer' THEN 'Finance officer'
         WHEN 'hr_officer' THEN 'Human resources officer'
         WHEN 'biomedical_engineer' THEN 'Biomedical engineer'
         WHEN 'maintenance_engineer' THEN 'Maintenance engineer'
         WHEN 'health_records_officer' THEN 'Health records officer'
         WHEN 'quality_assurance_officer' THEN 'Quality assurance officer'
         WHEN 'internal_auditor' THEN 'Internal auditor'
         WHEN 'security_officer' THEN 'Security officer'
         WHEN 'department_head' THEN 'Department head'
         WHEN 'reporting_officer' THEN 'Read-only reporting officer'
         WHEN 'mortuary_attendant' THEN 'Mortuary attendant'
       END,
       'inactive',
       TRUE,
       'Catalogue role, inactive and has no permissions until configured by an authorized administrator.',
       ROW_NUMBER() OVER (ORDER BY role_code)
FROM organization_catalog_seeded_roles;
