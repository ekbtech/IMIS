INSERT INTO departments (facility_id, department_code, name, status)
SELECT facility_id, 'TRIAGE', 'Triage', 'active'
FROM facilities
WHERE status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM departments existing
    WHERE existing.facility_id = facilities.facility_id
      AND existing.department_code = 'TRIAGE'
  );

ALTER TABLE departments
  ADD UNIQUE KEY uq_departments_facility_department (facility_id, department_id);

CREATE TABLE user_departments (
  user_id BIGINT UNSIGNED NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NOT NULL,
  assigned_at DATETIME(6) NOT NULL,
  assigned_by BIGINT UNSIGNED NULL,
  PRIMARY KEY (user_id, facility_id, department_id),
  CONSTRAINT fk_user_departments_user FOREIGN KEY (user_id) REFERENCES users(user_id),
  CONSTRAINT fk_user_departments_department FOREIGN KEY (facility_id, department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_user_departments_assigner FOREIGN KEY (assigned_by) REFERENCES users(user_id),
  KEY ix_user_departments_department (facility_id, department_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO roles (role_code, name, status, mfa_required) VALUES
  ('triage_nurse', 'Triage nurse', 'active', TRUE),
  ('triage_clinician', 'Triage clinician reviewer', 'active', TRUE);

INSERT INTO permissions (permission_code, description) VALUES
  ('triage.queue.read', 'Read the assigned department triage review queue'),
  ('triage.assessment.capture', 'Record encounter observations for triage review'),
  ('triage.assessment.review', 'Acknowledge and close a triage review item');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE (r.role_code = 'triage_nurse' AND p.permission_code IN (
  'triage.queue.read',
  'triage.assessment.capture'
)) OR (r.role_code = 'triage_clinician' AND p.permission_code IN (
  'triage.queue.read',
  'triage.assessment.review'
));

CREATE TABLE triage_module_settings (
  facility_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  workflow_approval_reference VARCHAR(255) NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME(6) NULL,
  CONSTRAINT fk_triage_settings_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_triage_settings_approver FOREIGN KEY (approved_by) REFERENCES users(user_id),
  CONSTRAINT ck_triage_settings_approval CHECK (
    enabled = FALSE OR (
      workflow_approval_reference IS NOT NULL AND
      CHAR_LENGTH(TRIM(workflow_approval_reference)) > 0 AND
      approved_by IS NOT NULL AND approved_at IS NOT NULL
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO triage_module_settings (facility_id)
SELECT facility_id FROM facilities;

ALTER TABLE encounter_observations
  ADD UNIQUE KEY uq_observations_facility_id (facility_id, observation_id);

CREATE TABLE triage_assessments (
  triage_assessment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  triage_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  encounter_id BIGINT UNSIGNED NOT NULL,
  observation_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('awaiting_review', 'reviewed') NOT NULL DEFAULT 'awaiting_review',
  captured_by BIGINT UNSIGNED NOT NULL,
  captured_at DATETIME(6) NOT NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(6) NULL,
  active_encounter_id BIGINT UNSIGNED GENERATED ALWAYS AS
    (CASE WHEN status = 'awaiting_review' THEN encounter_id ELSE NULL END) STORED,
  CONSTRAINT fk_triage_assessments_encounter FOREIGN KEY (facility_id, encounter_id)
    REFERENCES encounters(facility_id, encounter_id),
  CONSTRAINT fk_triage_assessments_observation FOREIGN KEY (facility_id, observation_id)
    REFERENCES encounter_observations(facility_id, observation_id),
  CONSTRAINT fk_triage_assessments_capturer FOREIGN KEY (captured_by) REFERENCES users(user_id),
  CONSTRAINT fk_triage_assessments_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(user_id),
  CONSTRAINT ck_triage_assessments_review CHECK (
    (status = 'awaiting_review' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
    (status = 'reviewed' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  UNIQUE KEY uq_triage_assessments_uuid (triage_uuid),
  UNIQUE KEY uq_triage_assessments_idempotency (facility_id, idempotency_key),
  UNIQUE KEY uq_triage_assessments_active_encounter (facility_id, active_encounter_id),
  KEY ix_triage_assessments_queue (facility_id, status, captured_at, triage_assessment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
