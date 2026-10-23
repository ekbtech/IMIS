CREATE TABLE patients (
  patient_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  record_number VARCHAR(40) NOT NULL,
  demographics_ciphertext VARBINARY(4096) NOT NULL,
  normalized_name_hmac BINARY(32) NOT NULL,
  birth_date_hmac BINARY(32) NOT NULL,
  status ENUM('active', 'merged', 'inactive') NOT NULL DEFAULT 'active',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_patients_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_patients_creator FOREIGN KEY (created_by) REFERENCES users(user_id),
  UNIQUE KEY uq_patients_facility_record (facility_id, record_number),
  KEY ix_patients_name_hmac (facility_id, normalized_name_hmac, status),
  KEY ix_patients_birth_date_hmac (facility_id, birth_date_hmac, status),
  KEY ix_patients_creator_time (created_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE patient_duplicate_reviews (
  duplicate_review_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  new_patient_id BIGINT UNSIGNED NULL,
  possible_duplicate_patient_id BIGINT UNSIGNED NOT NULL,
  reviewer_user_id BIGINT UNSIGNED NOT NULL,
  disposition ENUM('different_person', 'same_person') NOT NULL,
  reason VARCHAR(500) NOT NULL,
  proposed_name_hmac BINARY(32) NOT NULL,
  proposed_birth_date_hmac BINARY(32) NOT NULL,
  occurred_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_duplicate_review_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_duplicate_review_new FOREIGN KEY (new_patient_id) REFERENCES patients(patient_id),
  CONSTRAINT fk_duplicate_review_candidate FOREIGN KEY (possible_duplicate_patient_id) REFERENCES patients(patient_id),
  CONSTRAINT fk_duplicate_review_user FOREIGN KEY (reviewer_user_id) REFERENCES users(user_id),
  KEY ix_duplicate_review_candidate (possible_duplicate_patient_id, occurred_at),
  KEY ix_duplicate_review_new_patient (new_patient_id, occurred_at),
  KEY ix_duplicate_review_facility_time (facility_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('patient.registration.create', 'Register a patient at an assigned facility'),
  ('patient.mpi.search', 'Search the master patient index at an assigned facility'),
  ('patient.mpi.read', 'Read patient identity details at an assigned facility');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r
JOIN permissions p ON p.permission_code IN ('patient.registration.create', 'patient.mpi.search')
WHERE r.role_code = 'registration_clerk';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r
JOIN permissions p ON p.permission_code IN ('patient.mpi.search', 'patient.mpi.read')
WHERE r.role_code = 'clinician';
