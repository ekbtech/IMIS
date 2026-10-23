CREATE TABLE inpatient_module_settings (
  facility_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  workflow_approval_reference VARCHAR(255) NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME(6) NULL,
  CONSTRAINT fk_inpatient_settings_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_inpatient_settings_approver FOREIGN KEY (approved_by) REFERENCES users(user_id),
  CONSTRAINT ck_inpatient_settings_approval CHECK (
    enabled = FALSE OR (
      workflow_approval_reference IS NOT NULL AND
      CHAR_LENGTH(TRIM(workflow_approval_reference)) > 0 AND
      approved_by IS NOT NULL AND approved_at IS NOT NULL
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO inpatient_module_settings (facility_id)
SELECT facility_id FROM facilities;

CREATE TABLE inpatient_wards (
  ward_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ward_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  ward_code VARCHAR(64) NOT NULL,
  display_name VARCHAR(190) NOT NULL,
  source_reference VARCHAR(255) NULL,
  status ENUM('draft', 'active', 'retired') NOT NULL DEFAULT 'draft',
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_inpatient_wards_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_inpatient_wards_approver FOREIGN KEY (approved_by) REFERENCES users(user_id),
  CONSTRAINT ck_inpatient_wards_approval CHECK (
    status <> 'active' OR (
      source_reference IS NOT NULL AND
      CHAR_LENGTH(TRIM(source_reference)) > 0 AND
      approved_by IS NOT NULL AND approved_at IS NOT NULL
    )
  ),
  UNIQUE KEY uq_inpatient_wards_uuid (ward_uuid),
  UNIQUE KEY uq_inpatient_wards_facility_ward (facility_id, ward_id),
  UNIQUE KEY uq_inpatient_wards_facility_code (facility_id, ward_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE inpatient_beds (
  bed_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bed_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  ward_id BIGINT UNSIGNED NOT NULL,
  bed_code VARCHAR(64) NOT NULL,
  status ENUM('draft', 'active', 'retired') NOT NULL DEFAULT 'draft',
  source_reference VARCHAR(255) NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_inpatient_beds_ward FOREIGN KEY (facility_id, ward_id)
    REFERENCES inpatient_wards(facility_id, ward_id),
  CONSTRAINT fk_inpatient_beds_approver FOREIGN KEY (approved_by) REFERENCES users(user_id),
  CONSTRAINT ck_inpatient_beds_approval CHECK (
    status <> 'active' OR (
      source_reference IS NOT NULL AND
      CHAR_LENGTH(TRIM(source_reference)) > 0 AND
      approved_by IS NOT NULL AND approved_at IS NOT NULL
    )
  ),
  UNIQUE KEY uq_inpatient_beds_uuid (bed_uuid),
  UNIQUE KEY uq_inpatient_beds_facility_bed (facility_id, bed_id),
  UNIQUE KEY uq_inpatient_beds_facility_code (facility_id, bed_code),
  KEY ix_inpatient_beds_ward_status (facility_id, ward_id, status),
  CONSTRAINT fk_inpatient_beds_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE inpatient_admissions (
  admission_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admission_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  encounter_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  discharge_idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('active', 'discharged') NOT NULL DEFAULT 'active',
  admitted_by BIGINT UNSIGNED NOT NULL,
  admitted_at DATETIME(6) NOT NULL,
  discharged_by BIGINT UNSIGNED NULL,
  discharged_at DATETIME(6) NULL,
  active_encounter_id BIGINT UNSIGNED GENERATED ALWAYS AS
    (CASE WHEN status = 'active' THEN encounter_id ELSE NULL END) STORED,
  CONSTRAINT fk_inpatient_admissions_encounter FOREIGN KEY (facility_id, encounter_id)
    REFERENCES encounters(facility_id, encounter_id),
  CONSTRAINT fk_inpatient_admissions_admitter FOREIGN KEY (admitted_by) REFERENCES users(user_id),
  CONSTRAINT fk_inpatient_admissions_discharger FOREIGN KEY (discharged_by) REFERENCES users(user_id),
  CONSTRAINT ck_inpatient_admissions_discharge CHECK (
    (status = 'active' AND discharged_by IS NULL AND discharged_at IS NULL AND discharge_idempotency_key IS NULL) OR
    (status = 'discharged' AND discharged_by IS NOT NULL AND discharged_at IS NOT NULL AND discharge_idempotency_key IS NOT NULL)
  ),
  UNIQUE KEY uq_inpatient_admissions_uuid (admission_uuid),
  UNIQUE KEY uq_inpatient_admissions_facility_admission (facility_id, admission_id),
  UNIQUE KEY uq_inpatient_admissions_facility_idempotency (facility_id, idempotency_key),
  UNIQUE KEY uq_inpatient_admissions_facility_discharge_key (facility_id, discharge_idempotency_key),
  UNIQUE KEY uq_inpatient_admissions_active_encounter (facility_id, active_encounter_id),
  KEY ix_inpatient_admissions_encounter_status (facility_id, encounter_id, status, admitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE inpatient_bed_assignments (
  assignment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  assignment_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  admission_id BIGINT UNSIGNED NOT NULL,
  bed_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assigned_by BIGINT UNSIGNED NOT NULL,
  assigned_at DATETIME(6) NOT NULL,
  ended_by BIGINT UNSIGNED NULL,
  ended_at DATETIME(6) NULL,
  end_reason ENUM('transferred', 'discharged') NULL,
  active_admission_id BIGINT UNSIGNED GENERATED ALWAYS AS
    (CASE WHEN ended_at IS NULL THEN admission_id ELSE NULL END) STORED,
  active_bed_id BIGINT UNSIGNED GENERATED ALWAYS AS
    (CASE WHEN ended_at IS NULL THEN bed_id ELSE NULL END) STORED,
  CONSTRAINT fk_inpatient_assignments_admission FOREIGN KEY (facility_id, admission_id)
    REFERENCES inpatient_admissions(facility_id, admission_id),
  CONSTRAINT fk_inpatient_assignments_bed FOREIGN KEY (facility_id, bed_id)
    REFERENCES inpatient_beds(facility_id, bed_id),
  CONSTRAINT fk_inpatient_assignments_assigner FOREIGN KEY (assigned_by) REFERENCES users(user_id),
  CONSTRAINT fk_inpatient_assignments_ender FOREIGN KEY (ended_by) REFERENCES users(user_id),
  CONSTRAINT ck_inpatient_assignments_end CHECK (
    (ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL) OR
    (ended_at IS NOT NULL AND ended_by IS NOT NULL AND end_reason IS NOT NULL)
  ),
  UNIQUE KEY uq_inpatient_assignments_uuid (assignment_uuid),
  UNIQUE KEY uq_inpatient_assignments_facility_idempotency (facility_id, idempotency_key),
  UNIQUE KEY uq_inpatient_assignments_active_admission (active_admission_id),
  UNIQUE KEY uq_inpatient_assignments_active_bed (active_bed_id),
  KEY ix_inpatient_assignments_admission_history (facility_id, admission_id, assigned_at),
  KEY ix_inpatient_assignments_bed_history (facility_id, bed_id, assigned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('inpatient.catalog.read', 'Read approved wards and beds at an assigned facility'),
  ('inpatient.admission.read', 'Read inpatient admissions at an assigned facility'),
  ('inpatient.admission.create', 'Create an inpatient admission from an open encounter'),
  ('inpatient.bed.assign', 'Assign or transfer an inpatient admission to an approved bed'),
  ('inpatient.admission.discharge', 'Discharge an active inpatient admission');
