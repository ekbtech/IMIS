CREATE TABLE diagnostic_module_settings (
  facility_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  workflow_approval_reference VARCHAR(255) NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME(6) NULL,
  CONSTRAINT fk_diagnostic_settings_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_diagnostic_settings_approver FOREIGN KEY (approved_by) REFERENCES users(user_id),
  CONSTRAINT ck_diagnostic_settings_approval CHECK (
    enabled = FALSE OR (
      workflow_approval_reference IS NOT NULL AND
      CHAR_LENGTH(TRIM(workflow_approval_reference)) > 0 AND
      approved_by IS NOT NULL AND approved_at IS NOT NULL
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO diagnostic_module_settings (facility_id)
SELECT facility_id FROM facilities;

CREATE TABLE diagnostic_services (
  service_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  service_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  service_code VARCHAR(64) NOT NULL,
  display_name VARCHAR(190) NOT NULL,
  category_code VARCHAR(64) NOT NULL,
  source_reference VARCHAR(255) NULL,
  status ENUM('draft', 'active', 'retired') NOT NULL DEFAULT 'draft',
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_diagnostic_services_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_diagnostic_services_approver FOREIGN KEY (approved_by) REFERENCES users(user_id),
  CONSTRAINT ck_diagnostic_services_approval CHECK (
    status <> 'active' OR (
      source_reference IS NOT NULL AND
      CHAR_LENGTH(TRIM(source_reference)) > 0 AND
      approved_by IS NOT NULL AND approved_at IS NOT NULL
    )
  ),
  UNIQUE KEY uq_diagnostic_services_uuid (service_uuid),
  UNIQUE KEY uq_diagnostic_services_facility_service (facility_id, service_id),
  UNIQUE KEY uq_diagnostic_services_facility_code (facility_id, service_code),
  KEY ix_diagnostic_services_facility_status (facility_id, status, category_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE diagnostic_orders (
  diagnostic_order_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  encounter_id BIGINT UNSIGNED NOT NULL,
  service_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('ordered', 'cancelled') NOT NULL DEFAULT 'ordered',
  requested_by BIGINT UNSIGNED NOT NULL,
  requested_at DATETIME(6) NOT NULL,
  cancelled_by BIGINT UNSIGNED NULL,
  cancelled_at DATETIME(6) NULL,
  CONSTRAINT fk_diagnostic_orders_encounter FOREIGN KEY (facility_id, encounter_id)
    REFERENCES encounters(facility_id, encounter_id),
  CONSTRAINT fk_diagnostic_orders_service FOREIGN KEY (facility_id, service_id)
    REFERENCES diagnostic_services(facility_id, service_id),
  CONSTRAINT fk_diagnostic_orders_requester FOREIGN KEY (requested_by) REFERENCES users(user_id),
  CONSTRAINT fk_diagnostic_orders_canceller FOREIGN KEY (cancelled_by) REFERENCES users(user_id),
  CONSTRAINT ck_diagnostic_orders_cancellation CHECK (
    (status = 'ordered' AND cancelled_by IS NULL AND cancelled_at IS NULL) OR
    (status = 'cancelled' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)
  ),
  UNIQUE KEY uq_diagnostic_orders_uuid (order_uuid),
  UNIQUE KEY uq_diagnostic_orders_facility_idempotency (facility_id, idempotency_key),
  KEY ix_diagnostic_orders_encounter_requested (facility_id, encounter_id, requested_at, diagnostic_order_id),
  KEY ix_diagnostic_orders_service_status (facility_id, service_id, status),
  CONSTRAINT fk_diagnostic_orders_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('diagnostics.catalog.read', 'Read approved diagnostic services at an assigned facility'),
  ('diagnostics.order.read', 'Read diagnostic orders at an assigned facility'),
  ('diagnostics.order.create', 'Create diagnostic orders for an open encounter'),
  ('diagnostics.order.cancel', 'Cancel an unfulfilled diagnostic order');
