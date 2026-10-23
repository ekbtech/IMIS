CREATE TABLE appointments (
  appointment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  appointment_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  patient_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_at DATETIME(6) NOT NULL,
  reason_ciphertext VARBINARY(2048) NOT NULL,
  status ENUM('requested', 'confirmed', 'declined', 'cancelled') NOT NULL DEFAULT 'requested',
  requested_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL,
  responded_by BIGINT UNSIGNED NULL,
  responded_at DATETIME(6) NULL,
  CONSTRAINT fk_appointments_patient_facility FOREIGN KEY (facility_id, patient_id)
    REFERENCES patients(facility_id, patient_id),
  CONSTRAINT fk_appointments_department FOREIGN KEY (facility_id, department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_appointments_requester FOREIGN KEY (requested_by) REFERENCES users(user_id),
  CONSTRAINT fk_appointments_responder FOREIGN KEY (responded_by) REFERENCES users(user_id),
  CONSTRAINT ck_appointments_response CHECK (
    (status = 'requested' AND responded_by IS NULL AND responded_at IS NULL) OR
    (status <> 'requested' AND responded_by IS NOT NULL AND responded_at IS NOT NULL)
  ),
  UNIQUE KEY uq_appointments_uuid (appointment_uuid),
  UNIQUE KEY uq_appointments_facility_appointment (facility_id, appointment_id),
  UNIQUE KEY uq_appointments_idempotency (facility_id, idempotency_key),
  KEY ix_appointments_department_status_time (facility_id, department_id, status, requested_at),
  KEY ix_appointments_patient_time (facility_id, patient_id, requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE appointment_events (
  appointment_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  appointment_id BIGINT UNSIGNED NOT NULL,
  event_type ENUM('requested', 'confirmed', 'declined', 'cancelled') NOT NULL,
  previous_status ENUM('requested', 'confirmed', 'declined', 'cancelled') NULL,
  new_status ENUM('requested', 'confirmed', 'declined', 'cancelled') NOT NULL,
  note_ciphertext VARBINARY(2048) NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  occurred_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_appointment_events_appointment FOREIGN KEY (facility_id, appointment_id)
    REFERENCES appointments(facility_id, appointment_id),
  CONSTRAINT fk_appointment_events_actor FOREIGN KEY (actor_user_id) REFERENCES users(user_id),
  KEY ix_appointment_events_history (facility_id, appointment_id, occurred_at, appointment_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('appointment.request.create', 'Request an appointment at an assigned facility and department'),
  ('appointment.request.read', 'Read appointment requests for assigned departments'),
  ('appointment.request.confirm', 'Confirm or decline appointment requests in assigned departments');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r CROSS JOIN permissions p
WHERE r.role_code = 'system_admin'
  AND p.permission_code IN (
    'appointment.request.create', 'appointment.request.read', 'appointment.request.confirm'
  );

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r CROSS JOIN permissions p
WHERE r.role_code = 'registration_clerk'
  AND p.permission_code IN ('appointment.request.create', 'appointment.request.read');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r CROSS JOIN permissions p
WHERE r.role_code IN ('clinician', 'department_staff')
  AND p.permission_code IN ('appointment.request.read', 'appointment.request.confirm');
