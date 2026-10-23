CREATE TABLE department_workflow_seeded_departments (
  facility_id BIGINT UNSIGNED NOT NULL,
  department_code VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  PRIMARY KEY (facility_id, department_code),
  CONSTRAINT fk_department_workflow_seed_facility
    FOREIGN KEY (facility_id) REFERENCES facilities(facility_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO department_workflow_seeded_departments (facility_id, department_code, name)
SELECT f.facility_id, catalog.department_code, catalog.name
FROM facilities f
CROSS JOIN (
  SELECT 'OPD' AS department_code, 'Outpatient Department' AS name UNION ALL
  SELECT 'EMERGENCY', 'Emergency Department' UNION ALL
  SELECT 'MATERNITY', 'Maternity' UNION ALL
  SELECT 'LABORATORY', 'Laboratory' UNION ALL
  SELECT 'RADIOLOGY', 'Radiology and Imaging' UNION ALL
  SELECT 'PHARMACY', 'Pharmacy' UNION ALL
  SELECT 'THEATRE', 'Theatre and Anaesthesia' UNION ALL
  SELECT 'WARD', 'Inpatient Ward' UNION ALL
  SELECT 'ICU', 'Intensive Care' UNION ALL
  SELECT 'NICU', 'Neonatal Care' UNION ALL
  SELECT 'HIV_ART', 'HIV and ART Services' UNION ALL
  SELECT 'TB', 'Tuberculosis Services' UNION ALL
  SELECT 'MENTAL_HEALTH', 'Mental Health' UNION ALL
  SELECT 'REHABILITATION', 'Rehabilitation Services' UNION ALL
  SELECT 'DENTAL', 'Dental Services' UNION ALL
  SELECT 'OPHTHALMOLOGY', 'Ophthalmology' UNION ALL
  SELECT 'ENT', 'Ear, Nose and Throat' UNION ALL
  SELECT 'ONCOLOGY', 'Oncology' UNION ALL
  SELECT 'DIALYSIS', 'Dialysis and Renal Care' UNION ALL
  SELECT 'NUTRITION', 'Nutrition and Dietetics' UNION ALL
  SELECT 'BLOOD_BANK', 'Blood Bank' UNION ALL
  SELECT 'SOCIAL_WORK', 'Social Work' UNION ALL
  SELECT 'AMBULANCE', 'Ambulance Services' UNION ALL
  SELECT 'MORTUARY', 'Mortuary' UNION ALL
  SELECT 'IPC', 'Infection Prevention and Control' UNION ALL
  SELECT 'PROCUREMENT', 'Procurement' UNION ALL
  SELECT 'STORES', 'Stores' UNION ALL
  SELECT 'HR', 'Human Resources' UNION ALL
  SELECT 'BIOMEDICAL', 'Biomedical Engineering' UNION ALL
  SELECT 'HMIS', 'Health Management Information System'
) AS catalog
WHERE f.facility_code = 'DEMO-L5'
  AND f.status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM departments existing
    WHERE existing.facility_id = f.facility_id
      AND existing.department_code = catalog.department_code
  );

INSERT INTO departments (facility_id, department_code, name, status)
SELECT facility_id, department_code, name, 'active'
FROM department_workflow_seeded_departments;

INSERT INTO roles (role_code, name, status, mfa_required)
VALUES ('department_staff', 'Department workflow staff', 'active', TRUE);

INSERT INTO permissions (permission_code, description) VALUES
  ('workflow.task.read', 'Read tasks sent to or received by an assigned department'),
  ('workflow.task.create', 'Create a routed task from an assigned department'),
  ('workflow.task.respond', 'Accept, reject, progress or complete a task for an assigned receiving department');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_code = 'department_staff'
  AND p.permission_code IN (
    'workflow.task.read', 'workflow.task.create', 'workflow.task.respond'
  );

CREATE TABLE department_workflow_tasks (
  task_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  encounter_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_type ENUM('consultation', 'diagnostic', 'medication', 'procedure', 'referral', 'handover', 'other') NOT NULL,
  title VARCHAR(160) NOT NULL,
  details_ciphertext VARBINARY(4096) NOT NULL,
  sending_department_id BIGINT UNSIGNED NOT NULL,
  receiving_department_id BIGINT UNSIGNED NOT NULL,
  status ENUM('requested', 'accepted', 'in_progress', 'completed', 'rejected', 'cancelled') NOT NULL DEFAULT 'requested',
  requested_by BIGINT UNSIGNED NOT NULL,
  requested_at DATETIME(6) NOT NULL,
  responded_by BIGINT UNSIGNED NULL,
  responded_at DATETIME(6) NULL,
  completed_by BIGINT UNSIGNED NULL,
  completed_at DATETIME(6) NULL,
  CONSTRAINT fk_workflow_task_encounter FOREIGN KEY (facility_id, encounter_id)
    REFERENCES encounters(facility_id, encounter_id),
  CONSTRAINT fk_workflow_task_sending_department FOREIGN KEY (facility_id, sending_department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_workflow_task_receiving_department FOREIGN KEY (facility_id, receiving_department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_workflow_task_requester FOREIGN KEY (requested_by) REFERENCES users(user_id),
  CONSTRAINT fk_workflow_task_responder FOREIGN KEY (responded_by) REFERENCES users(user_id),
  CONSTRAINT fk_workflow_task_completer FOREIGN KEY (completed_by) REFERENCES users(user_id),
  CONSTRAINT ck_workflow_task_distinct_departments CHECK (sending_department_id <> receiving_department_id),
  CONSTRAINT ck_workflow_task_response CHECK (
    (status = 'requested' AND responded_by IS NULL AND responded_at IS NULL) OR
    (status <> 'requested' AND responded_by IS NOT NULL AND responded_at IS NOT NULL)
  ),
  CONSTRAINT ck_workflow_task_completion CHECK (
    (status IN ('completed', 'rejected', 'cancelled') AND completed_by IS NOT NULL AND completed_at IS NOT NULL) OR
    (status IN ('requested', 'accepted', 'in_progress') AND completed_by IS NULL AND completed_at IS NULL)
  ),
  UNIQUE KEY uq_workflow_task_uuid (task_uuid),
  UNIQUE KEY uq_workflow_task_idempotency (facility_id, idempotency_key),
  UNIQUE KEY uq_workflow_task_facility_task (facility_id, task_id),
  KEY ix_workflow_task_receiving_queue (facility_id, receiving_department_id, status, requested_at),
  KEY ix_workflow_task_sending_queue (facility_id, sending_department_id, status, requested_at),
  KEY ix_workflow_task_encounter (facility_id, encounter_id, requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE department_workflow_task_events (
  task_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  event_type ENUM('requested', 'accepted', 'rejected', 'started', 'completed', 'cancelled') NOT NULL,
  previous_status ENUM('requested', 'accepted', 'in_progress', 'completed', 'rejected', 'cancelled') NULL,
  new_status ENUM('requested', 'accepted', 'in_progress', 'completed', 'rejected', 'cancelled') NOT NULL,
  note_ciphertext VARBINARY(4096) NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  occurred_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_workflow_task_event_task FOREIGN KEY (facility_id, task_id)
    REFERENCES department_workflow_tasks(facility_id, task_id),
  CONSTRAINT fk_workflow_task_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(user_id),
  KEY ix_workflow_task_event_history (facility_id, task_id, occurred_at, task_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
