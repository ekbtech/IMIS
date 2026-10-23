CREATE TABLE maintenance_requests (
  maintenance_request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  biomedical_department_id BIGINT UNSIGNED NOT NULL,
  reporting_department_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset_tag VARCHAR(100) NOT NULL,
  location_ciphertext VARBINARY(1024) NOT NULL,
  issue_ciphertext VARBINARY(2048) NOT NULL,
  status ENUM('requested', 'acknowledged', 'in_progress', 'completed', 'cancelled') NOT NULL DEFAULT 'requested',
  requested_by BIGINT UNSIGNED NOT NULL,
  requested_at DATETIME(6) NOT NULL,
  handled_by BIGINT UNSIGNED NULL,
  handled_at DATETIME(6) NULL,
  CONSTRAINT fk_maintenance_biomedical_department FOREIGN KEY (facility_id, biomedical_department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_maintenance_reporting_department FOREIGN KEY (facility_id, reporting_department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_maintenance_requester FOREIGN KEY (requested_by) REFERENCES users(user_id),
  CONSTRAINT fk_maintenance_handler FOREIGN KEY (handled_by) REFERENCES users(user_id),
  CONSTRAINT ck_maintenance_response CHECK (
    (status = 'requested' AND handled_by IS NULL AND handled_at IS NULL) OR
    (status <> 'requested' AND handled_by IS NOT NULL AND handled_at IS NOT NULL)
  ),
  UNIQUE KEY uq_maintenance_request_uuid (request_uuid),
  UNIQUE KEY uq_maintenance_request_idempotency (facility_id, idempotency_key),
  UNIQUE KEY uq_maintenance_request_scoped_id (facility_id, maintenance_request_id),
  KEY ix_maintenance_queue (facility_id, biomedical_department_id, status, requested_at),
  KEY ix_maintenance_reporting_department (facility_id, reporting_department_id, requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE maintenance_request_events (
  maintenance_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  maintenance_request_id BIGINT UNSIGNED NOT NULL,
  event_type ENUM('requested', 'acknowledged', 'started', 'completed', 'cancelled') NOT NULL,
  previous_status ENUM('requested', 'acknowledged', 'in_progress', 'completed', 'cancelled') NULL,
  new_status ENUM('requested', 'acknowledged', 'in_progress', 'completed', 'cancelled') NOT NULL,
  note_ciphertext VARBINARY(2048) NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  occurred_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_maintenance_event_request FOREIGN KEY (facility_id, maintenance_request_id)
    REFERENCES maintenance_requests(facility_id, maintenance_request_id),
  CONSTRAINT fk_maintenance_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(user_id),
  KEY ix_maintenance_event_history (facility_id, maintenance_request_id, occurred_at, maintenance_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('maintenance.request.create', 'Report equipment maintenance issues from an assigned department'),
  ('maintenance.request.read', 'Read maintenance requests visible to assigned departments'),
  ('maintenance.request.manage', 'Acknowledge and update maintenance requests for Biomedical Engineering');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r CROSS JOIN permissions p
WHERE r.role_code = 'system_admin'
  AND p.permission_code IN (
    'maintenance.request.create', 'maintenance.request.read', 'maintenance.request.manage'
  );

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r CROSS JOIN permissions p
WHERE r.role_code = 'department_staff'
  AND p.permission_code IN (
    'maintenance.request.create', 'maintenance.request.read', 'maintenance.request.manage'
  );
