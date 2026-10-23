CREATE TABLE divisions (
  division_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  division_code VARCHAR(64) NOT NULL,
  name VARCHAR(190) NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_divisions_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  UNIQUE KEY uq_divisions_facility_code (facility_id, division_code),
  UNIQUE KEY uq_divisions_facility_id (facility_id, division_id),
  KEY ix_divisions_facility_order (facility_id, status, display_order, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO divisions
  (facility_id, division_code, name, description, status, display_order, created_at, updated_at)
SELECT f.facility_id, catalog.division_code, catalog.name, '', 'active',
       catalog.display_order, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
FROM facilities f
CROSS JOIN (
  SELECT 'CLINICAL_SERVICES' AS division_code, 'Clinical Services' AS name, 10 AS display_order UNION ALL
  SELECT 'DIAGNOSTICS_SUPPORT', 'Diagnostics and Clinical Support', 20 UNION ALL
  SELECT 'ADMIN_FINANCE_GOVERNANCE', 'Administration, Finance and Governance', 30 UNION ALL
  SELECT 'PROCUREMENT_ASSET_MANAGEMENT', 'Procurement, Supply Chain and Asset Management', 40 UNION ALL
  SELECT 'ICT_TECHNICAL_SERVICES', 'ICT and Technical Services', 50 UNION ALL
  SELECT 'GENERAL_SUPPORT_SERVICES', 'General Support Services', 60
) catalog
WHERE f.status = 'active';

ALTER TABLE departments
  ADD COLUMN division_id BIGINT UNSIGNED NULL AFTER facility_id;

CREATE TEMPORARY TABLE organization_department_catalog (
  department_code VARCHAR(64) NOT NULL PRIMARY KEY,
  legacy_code VARCHAR(64) NULL,
  name VARCHAR(190) NOT NULL,
  division_code VARCHAR(64) NOT NULL,
  department_group VARCHAR(32) NOT NULL,
  hospital_subgroup VARCHAR(32) NULL,
  unit_type VARCHAR(32) NOT NULL,
  display_order SMALLINT UNSIGNED NOT NULL
) ENGINE=InnoDB;

INSERT INTO organization_department_catalog
  (department_code, legacy_code, name, division_code, department_group, hospital_subgroup, unit_type, display_order)
VALUES
  ('OPD', NULL, 'Outpatient Department (OPD)', 'CLINICAL_SERVICES', 'hospital', 'outpatient', 'clinic', 1),
  ('IPD', 'WARD', 'Inpatient Department (IPD)', 'CLINICAL_SERVICES', 'hospital', 'inpatient', 'ward', 2),
  ('EMERGENCY_ACCIDENT', 'EMERGENCY', 'Emergency and Accident', 'CLINICAL_SERVICES', 'hospital', 'emergency', 'department', 3),
  ('INTERNAL_MEDICINE', 'GENERAL_MEDICINE', 'Internal Medicine', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'department', 4),
  ('GENERAL_SURGERY', NULL, 'General Surgery', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'department', 5),
  ('OBSTETRICS_GYNAECOLOGY', NULL, 'Obstetrics and Gynaecology', 'CLINICAL_SERVICES', 'hospital', 'maternity', 'department', 6),
  ('MATERNITY_LABOUR_WARD', 'MATERNITY', 'Maternity and Labour Ward', 'CLINICAL_SERVICES', 'hospital', 'maternity', 'ward', 7),
  ('PAEDIATRICS_CHILD_HEALTH', 'PAEDIATRICS', 'Paediatrics and Child Health', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'department', 8),
  ('NEONATAL_UNIT', 'NICU', 'Neonatal Unit', 'CLINICAL_SERVICES', 'hospital', 'inpatient', 'ward', 9),
  ('ORTHOPAEDICS_TRAUMA', 'ORTHOPAEDICS', 'Orthopaedics and Trauma', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'department', 10),
  ('ANAESTHESIA', NULL, 'Anaesthesia', 'CLINICAL_SERVICES', 'hospital', 'treatment_support', 'department', 11),
  ('OPERATING_THEATRE_RECOVERY', 'THEATRE', 'Operating Theatre and Recovery', 'CLINICAL_SERVICES', 'hospital', 'treatment_support', 'department', 12),
  ('ICU', NULL, 'Intensive Care Unit (ICU)', 'CLINICAL_SERVICES', 'hospital', 'inpatient', 'ward', 13),
  ('DENTAL_SERVICES', 'DENTAL', 'Dental Services', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'clinic', 14),
  ('EYE_CLINIC', NULL, 'Eye Clinic', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'clinic', 15),
  ('ENT', NULL, 'Ear, Nose and Throat (ENT)', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'clinic', 16),
  ('MENTAL_HEALTH_PSYCHIATRY', 'MENTAL_HEALTH', 'Mental Health and Psychiatry', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'clinic', 17),
  ('PHYSIOTHERAPY_REHABILITATION', 'PHYSIOTHERAPY', 'Physiotherapy and Rehabilitation', 'CLINICAL_SERVICES', 'hospital', 'treatment_support', 'department', 18),
  ('NUTRITION_DIETETICS', 'NUTRITION', 'Nutrition and Dietetics', 'CLINICAL_SERVICES', 'hospital', 'treatment_support', 'department', 19),
  ('COMMUNITY_HEALTH_OUTREACH', 'OUTREACH', 'Community Health and Outreach', 'CLINICAL_SERVICES', 'hospital', 'outpatient', 'service_unit', 20),
  ('HIV_COMPREHENSIVE_CARE', 'HIV_ART', 'HIV Comprehensive Care Clinic (CCC)', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'clinic', 21),
  ('TB_CLINIC', 'TB', 'Tuberculosis (TB) Clinic', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'clinic', 22),
  ('NCD_CLINIC', NULL, 'Non-Communicable Diseases (NCD) Clinic', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'clinic', 23),
  ('RENAL_DIALYSIS', 'DIALYSIS', 'Renal Services and Dialysis', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'department', 24),
  ('ONCOLOGY', NULL, 'Oncology Services', 'CLINICAL_SERVICES', 'hospital', 'specialty_clinics', 'clinic', 25),
  ('LABORATORY', NULL, 'Medical Laboratory', 'DIAGNOSTICS_SUPPORT', 'hospital', 'diagnostics', 'department', 26),
  ('RADIOLOGY', NULL, 'Radiology and Imaging', 'DIAGNOSTICS_SUPPORT', 'hospital', 'diagnostics', 'department', 27),
  ('PHARMACY', NULL, 'Pharmacy', 'DIAGNOSTICS_SUPPORT', 'hospital', 'treatment_support', 'department', 28),
  ('BLOOD_TRANSFUSION', 'BLOOD_BANK', 'Blood Transfusion Services', 'DIAGNOSTICS_SUPPORT', 'hospital', 'diagnostics', 'department', 29),
  ('CSSD', NULL, 'Central Sterile Services Department (CSSD)', 'DIAGNOSTICS_SUPPORT', 'hospital', 'treatment_support', 'department', 30),
  ('HOSPITAL_ADMINISTRATION', NULL, 'Hospital Administration', 'ADMIN_FINANCE_GOVERNANCE', 'administration', NULL, 'department', 31),
  ('HR', NULL, 'Human Resources', 'ADMIN_FINANCE_GOVERNANCE', 'hr', NULL, 'department', 32),
  ('FINANCE', NULL, 'Finance and Accounts', 'ADMIN_FINANCE_GOVERNANCE', 'finance', NULL, 'department', 33),
  ('REVENUE_BILLING', NULL, 'Revenue and Billing', 'ADMIN_FINANCE_GOVERNANCE', 'finance', NULL, 'department', 34),
  ('RECORDS', NULL, 'Health Records and Information', 'ADMIN_FINANCE_GOVERNANCE', 'reports', NULL, 'department', 35),
  ('QUALITY_PATIENT_SAFETY', 'QUALITY', 'Quality Assurance and Patient Safety', 'ADMIN_FINANCE_GOVERNANCE', 'administration', NULL, 'department', 36),
  ('MONITORING_EVALUATION', NULL, 'Monitoring and Evaluation', 'ADMIN_FINANCE_GOVERNANCE', 'reports', NULL, 'department', 37),
  ('INTERNAL_AUDIT_RISK', NULL, 'Internal Audit and Risk Management', 'ADMIN_FINANCE_GOVERNANCE', 'administration', NULL, 'department', 38),
  ('CUSTOMER_CARE_PR', NULL, 'Customer Care and Public Relations', 'ADMIN_FINANCE_GOVERNANCE', 'administration', NULL, 'department', 39),
  ('TRAINING_RESEARCH', 'RESEARCH', 'Training and Research', 'ADMIN_FINANCE_GOVERNANCE', 'administration', NULL, 'department', 40),
  ('PROCUREMENT', NULL, 'Procurement', 'PROCUREMENT_ASSET_MANAGEMENT', 'procurement', NULL, 'department', 41),
  ('SUPPLY_CHAIN', NULL, 'Supply Chain Management', 'PROCUREMENT_ASSET_MANAGEMENT', 'procurement', NULL, 'department', 42),
  ('MAIN_STORES', 'STORES', 'Main Stores', 'PROCUREMENT_ASSET_MANAGEMENT', 'inventory', NULL, 'store', 43),
  ('PHARMACY_STORES', NULL, 'Pharmacy Stores', 'PROCUREMENT_ASSET_MANAGEMENT', 'inventory', NULL, 'store', 44),
  ('MEDICAL_SUPPLIES_STORE', NULL, 'Medical Supplies Store', 'PROCUREMENT_ASSET_MANAGEMENT', 'inventory', NULL, 'store', 45),
  ('GENERAL_SUPPLIES_STORE', NULL, 'General Supplies Store', 'PROCUREMENT_ASSET_MANAGEMENT', 'inventory', NULL, 'store', 46),
  ('RECEIVING_INSPECTION', NULL, 'Receiving and Inspection', 'PROCUREMENT_ASSET_MANAGEMENT', 'procurement', NULL, 'department', 47),
  ('SUPPLIER_MANAGEMENT', NULL, 'Supplier Management', 'PROCUREMENT_ASSET_MANAGEMENT', 'procurement', NULL, 'department', 48),
  ('ASSET_MANAGEMENT', NULL, 'Equipment and Asset Management', 'PROCUREMENT_ASSET_MANAGEMENT', 'inventory', NULL, 'department', 49),
  ('ICT', NULL, 'Information and Communication Technology (ICT)', 'ICT_TECHNICAL_SERVICES', 'system_tools', NULL, 'department', 50),
  ('BIOMEDICAL', NULL, 'Biomedical Engineering', 'ICT_TECHNICAL_SERVICES', 'system_tools', NULL, 'department', 51),
  ('CIVIL_MAINTENANCE', NULL, 'Civil and Maintenance Engineering', 'ICT_TECHNICAL_SERVICES', 'system_tools', NULL, 'department', 52),
  ('ELECTRICAL_PLUMBING', NULL, 'Electrical and Plumbing Maintenance', 'ICT_TECHNICAL_SERVICES', 'system_tools', NULL, 'department', 53),
  ('AMBULANCE', NULL, 'Transport and Ambulance', 'GENERAL_SUPPORT_SERVICES', 'administration', NULL, 'service_unit', 54),
  ('SECURITY', NULL, 'Security', 'GENERAL_SUPPORT_SERVICES', 'administration', NULL, 'department', 55),
  ('CLEANING', NULL, 'Cleaning and Housekeeping', 'GENERAL_SUPPORT_SERVICES', 'administration', NULL, 'department', 56),
  ('LAUNDRY', NULL, 'Laundry and Linen', 'GENERAL_SUPPORT_SERVICES', 'administration', NULL, 'department', 57),
  ('CATERING', NULL, 'Catering and Kitchen', 'GENERAL_SUPPORT_SERVICES', 'administration', NULL, 'department', 58),
  ('WASTE_MANAGEMENT', NULL, 'Medical Waste Management', 'GENERAL_SUPPORT_SERVICES', 'administration', NULL, 'department', 59),
  ('MORTUARY', NULL, 'Mortuary Services', 'GENERAL_SUPPORT_SERVICES', 'morgue', NULL, 'department', 60);

INSERT INTO departments
  (facility_id, department_code, department_group, hospital_subgroup, name, status, unit_type, display_order)
SELECT f.facility_id, catalog.department_code, catalog.department_group, catalog.hospital_subgroup,
       catalog.name, 'active', catalog.unit_type, catalog.display_order
FROM facilities f
CROSS JOIN organization_department_catalog catalog
WHERE f.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM departments existing
    WHERE existing.facility_id = f.facility_id
      AND existing.department_code IN (catalog.department_code, catalog.legacy_code)
  );

UPDATE departments d
JOIN facilities f ON f.facility_id = d.facility_id
JOIN organization_department_catalog catalog
  ON d.department_code = catalog.department_code
  OR d.department_code = catalog.legacy_code
JOIN divisions v ON v.facility_id = d.facility_id AND v.division_code = catalog.division_code
SET d.division_id = v.division_id;

UPDATE departments d
JOIN divisions v ON v.facility_id = d.facility_id
SET d.division_id = v.division_id
WHERE d.division_id IS NULL
  AND v.division_code = CASE
    WHEN d.department_group = 'hospital' THEN 'CLINICAL_SERVICES'
    WHEN d.department_group IN ('procurement', 'inventory') THEN 'PROCUREMENT_ASSET_MANAGEMENT'
    WHEN d.department_group = 'system_tools' THEN 'ICT_TECHNICAL_SERVICES'
    WHEN d.department_group = 'morgue' THEN 'GENERAL_SUPPORT_SERVICES'
    ELSE 'ADMIN_FINANCE_GOVERNANCE'
  END;

ALTER TABLE departments
  MODIFY COLUMN division_id BIGINT UNSIGNED NOT NULL,
  ADD KEY ix_departments_facility_division_order (facility_id, division_id, display_order),
  ADD CONSTRAINT fk_departments_division
    FOREIGN KEY (facility_id, division_id) REFERENCES divisions(facility_id, division_id);

DROP TEMPORARY TABLE organization_department_catalog;
