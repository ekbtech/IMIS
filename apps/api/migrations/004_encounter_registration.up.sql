ALTER TABLE patients
  ADD UNIQUE KEY uq_patients_facility_patient (facility_id, patient_id);

CREATE TABLE encounters (
  encounter_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  encounter_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  patient_id BIGINT UNSIGNED NOT NULL,
  encounter_type ENUM('outpatient', 'emergency') NOT NULL,
  status ENUM('open', 'closed', 'cancelled') NOT NULL DEFAULT 'open',
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  opened_at DATETIME(6) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_encounters_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_encounters_patient_facility FOREIGN KEY (facility_id, patient_id)
    REFERENCES patients(facility_id, patient_id),
  CONSTRAINT fk_encounters_creator FOREIGN KEY (created_by) REFERENCES users(user_id),
  UNIQUE KEY uq_encounters_uuid (encounter_uuid),
  UNIQUE KEY uq_encounters_idempotency (facility_id, idempotency_key),
  UNIQUE KEY uq_encounters_facility_encounter (facility_id, encounter_id),
  KEY ix_encounters_facility_status_opened (facility_id, status, opened_at),
  KEY ix_encounters_patient_opened (patient_id, opened_at),
  KEY ix_encounters_creator_created (created_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('encounter.registration.create', 'Register outpatient and emergency encounters at an assigned facility'),
  ('encounter.queue.read', 'Read the encounter registration queue at an assigned facility');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r
JOIN permissions p ON p.permission_code IN ('encounter.registration.create', 'encounter.queue.read')
WHERE r.role_code = 'registration_clerk';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r
JOIN permissions p ON p.permission_code IN ('encounter.registration.create', 'encounter.queue.read')
WHERE r.role_code = 'clinician';
