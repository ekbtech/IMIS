CREATE TABLE integration_connections (
  connection_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  connection_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  integration_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(190) NOT NULL,
  status ENUM('disabled', 'enabled') NOT NULL DEFAULT 'disabled',
  specification_reference VARCHAR(255) NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_integration_connections_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_integration_connections_approver FOREIGN KEY (approved_by) REFERENCES users(user_id),
  CONSTRAINT ck_integration_connection_approval CHECK (
    status = 'disabled' OR (
      specification_reference IS NOT NULL AND
      CHAR_LENGTH(TRIM(specification_reference)) > 0 AND
      approved_by IS NOT NULL AND approved_at IS NOT NULL
    )
  ),
  UNIQUE KEY uq_integration_connections_uuid (connection_uuid),
  UNIQUE KEY uq_integration_connections_facility_connection (facility_id, connection_id),
  UNIQUE KEY uq_integration_connections_facility_code (facility_id, integration_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE integration_outbox (
  outbox_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  message_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  connection_id BIGINT UNSIGNED NOT NULL,
  integration_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_resource_type VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_resource_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_ciphertext VARBINARY(16384) NOT NULL,
  payload_hash BINARY(32) NOT NULL,
  status ENUM('queued', 'retry_wait', 'delivered', 'dead_letter') NOT NULL DEFAULT 'queued',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(6) NULL,
  delivered_at DATETIME(6) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_integration_outbox_connection FOREIGN KEY (facility_id, connection_id)
    REFERENCES integration_connections(facility_id, connection_id),
  CONSTRAINT fk_integration_outbox_creator FOREIGN KEY (created_by) REFERENCES users(user_id),
  CONSTRAINT ck_integration_outbox_delivery CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL) OR
    (status <> 'delivered' AND delivered_at IS NULL)
  ),
  UNIQUE KEY uq_integration_outbox_uuid (message_uuid),
  UNIQUE KEY uq_integration_outbox_idempotency (facility_id, integration_code, idempotency_key),
  UNIQUE KEY uq_integration_outbox_facility_message (facility_id, outbox_id),
  KEY ix_integration_outbox_pending (facility_id, status, next_attempt_at, created_at),
  KEY ix_integration_outbox_source (facility_id, source_resource_type, source_resource_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE integration_delivery_attempts (
  attempt_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  outbox_id BIGINT UNSIGNED NOT NULL,
  attempt_number INT UNSIGNED NOT NULL,
  outcome ENUM('succeeded', 'failed') NOT NULL,
  started_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6) NULL,
  response_status SMALLINT UNSIGNED NULL,
  error_code VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
  response_hash BINARY(32) NULL,
  CONSTRAINT fk_integration_attempt_outbox FOREIGN KEY (facility_id, outbox_id)
    REFERENCES integration_outbox(facility_id, outbox_id),
  UNIQUE KEY uq_integration_attempt_number (outbox_id, attempt_number),
  KEY ix_integration_attempt_time (facility_id, outbox_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE integration_reconciliation (
  reconciliation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  outbox_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending', 'matched', 'rejected', 'manual_review') NOT NULL DEFAULT 'pending',
  evidence_reference VARCHAR(255) NULL,
  reconciled_by BIGINT UNSIGNED NULL,
  reconciled_at DATETIME(6) NULL,
  CONSTRAINT fk_integration_reconciliation_outbox FOREIGN KEY (facility_id, outbox_id)
    REFERENCES integration_outbox(facility_id, outbox_id),
  CONSTRAINT fk_integration_reconciliation_user FOREIGN KEY (reconciled_by) REFERENCES users(user_id),
  CONSTRAINT ck_integration_reconciliation_review CHECK (
    (status = 'pending' AND reconciled_by IS NULL AND reconciled_at IS NULL) OR
    (status <> 'pending' AND reconciled_by IS NOT NULL AND reconciled_at IS NOT NULL)
  ),
  UNIQUE KEY uq_integration_reconciliation_outbox (outbox_id),
  KEY ix_integration_reconciliation_status (facility_id, status, reconciled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('integration.outbox.read', 'Read integration outbox state at an assigned facility'),
  ('integration.reconciliation.read', 'Read integration reconciliation evidence'),
  ('integration.reconciliation.update', 'Record approved integration reconciliation decisions');
