CREATE TABLE inventory_items (
  inventory_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  item_code VARCHAR(64) NOT NULL,
  name VARCHAR(190) NOT NULL,
  unit_of_measure VARCHAR(32) NOT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_inventory_items_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_inventory_items_creator FOREIGN KEY (created_by) REFERENCES users(user_id),
  UNIQUE KEY uq_inventory_items_facility_code (facility_id, item_code),
  UNIQUE KEY uq_inventory_items_facility_item (facility_id, inventory_item_id),
  KEY ix_inventory_items_facility_status_name (facility_id, status, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE inventory_stock_lots (
  stock_lot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NOT NULL,
  inventory_item_id BIGINT UNSIGNED NOT NULL,
  batch_code VARCHAR(100) NOT NULL,
  expires_on DATE NULL,
  quantity_on_hand DECIMAL(14,3) NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_inventory_lot_department FOREIGN KEY (facility_id, department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_inventory_lot_item FOREIGN KEY (facility_id, inventory_item_id)
    REFERENCES inventory_items(facility_id, inventory_item_id),
  CONSTRAINT ck_inventory_lot_nonnegative CHECK (quantity_on_hand >= 0),
  UNIQUE KEY uq_inventory_lot_batch (facility_id, department_id, inventory_item_id, batch_code),
  UNIQUE KEY uq_inventory_lot_scoped_id (facility_id, department_id, stock_lot_id),
  KEY ix_inventory_lots_expiry (facility_id, department_id, expires_on, inventory_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE inventory_stock_movements (
  stock_movement_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  movement_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NOT NULL,
  stock_lot_id BIGINT UNSIGNED NOT NULL,
  movement_type ENUM('receipt', 'issue') NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  reference VARCHAR(120) NOT NULL,
  issue_to_department_id BIGINT UNSIGNED NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  occurred_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_inventory_movement_lot FOREIGN KEY (facility_id, department_id, stock_lot_id)
    REFERENCES inventory_stock_lots(facility_id, department_id, stock_lot_id),
  CONSTRAINT fk_inventory_movement_issue_target FOREIGN KEY (facility_id, issue_to_department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_inventory_movement_actor FOREIGN KEY (actor_user_id) REFERENCES users(user_id),
  CONSTRAINT ck_inventory_movement_positive CHECK (quantity > 0),
  CONSTRAINT ck_inventory_movement_issue_target CHECK (
    (movement_type = 'receipt' AND issue_to_department_id IS NULL) OR
    (movement_type = 'issue' AND issue_to_department_id IS NOT NULL)
  ),
  UNIQUE KEY uq_inventory_movement_uuid (movement_uuid),
  UNIQUE KEY uq_inventory_movement_idempotency (facility_id, idempotency_key),
  KEY ix_inventory_movements_history (facility_id, department_id, stock_lot_id, occurred_at, stock_movement_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('inventory.stock.read', 'Read stock levels and movement history in assigned inventory departments'),
  ('inventory.catalog.manage', 'Create and update facility inventory catalogue items'),
  ('inventory.stock.receive', 'Record stock receipts in assigned inventory departments'),
  ('inventory.stock.issue', 'Issue stock from assigned inventory departments to facility departments');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r CROSS JOIN permissions p
WHERE r.role_code = 'system_admin'
  AND p.permission_code IN (
    'inventory.stock.read', 'inventory.catalog.manage',
    'inventory.stock.receive', 'inventory.stock.issue'
  );

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r CROSS JOIN permissions p
WHERE r.role_code = 'department_staff'
  AND p.permission_code IN (
    'inventory.stock.read', 'inventory.catalog.manage',
    'inventory.stock.receive', 'inventory.stock.issue'
  );
