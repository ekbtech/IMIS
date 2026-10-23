CREATE TABLE facility_assets (
  facility_asset_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  asset_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NOT NULL,
  asset_tag VARCHAR(100) NOT NULL,
  name VARCHAR(190) NOT NULL,
  category VARCHAR(100) NOT NULL,
  manufacturer VARCHAR(120) NOT NULL DEFAULT '',
  model VARCHAR(120) NOT NULL DEFAULT '',
  serial_ciphertext VARBINARY(512) NULL,
  location_ciphertext VARBINARY(1024) NOT NULL,
  registered_by BIGINT UNSIGNED NOT NULL,
  registered_at DATETIME(6) NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_facility_asset_department FOREIGN KEY (facility_id, department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_facility_asset_registrar FOREIGN KEY (registered_by) REFERENCES users(user_id),
  CONSTRAINT fk_facility_asset_updater FOREIGN KEY (updated_by) REFERENCES users(user_id),
  UNIQUE KEY uq_facility_asset_uuid (asset_uuid),
  UNIQUE KEY uq_facility_asset_tag (facility_id, asset_tag),
  UNIQUE KEY uq_facility_asset_scoped_id (facility_id, facility_asset_id),
  KEY ix_facility_assets_department_name (facility_id, department_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE facility_asset_events (
  facility_asset_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  facility_asset_id BIGINT UNSIGNED NOT NULL,
  event_type ENUM('registered', 'updated', 'reassigned') NOT NULL,
  previous_department_id BIGINT UNSIGNED NULL,
  new_department_id BIGINT UNSIGNED NOT NULL,
  details_ciphertext VARBINARY(2048) NOT NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  occurred_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_facility_asset_event_asset FOREIGN KEY (facility_id, facility_asset_id)
    REFERENCES facility_assets(facility_id, facility_asset_id),
  CONSTRAINT fk_facility_asset_event_previous_department FOREIGN KEY (facility_id, previous_department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_facility_asset_event_new_department FOREIGN KEY (facility_id, new_department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_facility_asset_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(user_id),
  KEY ix_facility_asset_events_history (facility_id, facility_asset_id, occurred_at, facility_asset_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('asset.register.read', 'Read equipment register entries in assigned departments'),
  ('asset.register.manage', 'Register and update equipment assigned to authorized departments');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r CROSS JOIN permissions p
WHERE r.role_code IN ('system_admin', 'department_staff')
  AND p.permission_code IN ('asset.register.read', 'asset.register.manage');
