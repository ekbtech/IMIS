CREATE TABLE finance_module_settings (
  facility_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  workflow_approval_reference VARCHAR(255) NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME(6) NULL,
  CONSTRAINT fk_finance_settings_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_finance_settings_approver FOREIGN KEY (approved_by) REFERENCES users(user_id),
  CONSTRAINT ck_finance_settings_approval CHECK (
    enabled = FALSE OR (
      workflow_approval_reference IS NOT NULL AND
      CHAR_LENGTH(TRIM(workflow_approval_reference)) > 0 AND
      approved_by IS NOT NULL AND approved_at IS NOT NULL
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO finance_module_settings (facility_id)
SELECT facility_id FROM facilities;

CREATE TABLE finance_charges (
  charge_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  charge_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  encounter_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  charge_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  description_ciphertext VARBINARY(896) NOT NULL,
  amount DECIMAL(13,2) NOT NULL,
  currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('unbilled', 'invoiced') NOT NULL DEFAULT 'unbilled',
  recorded_by BIGINT UNSIGNED NOT NULL,
  recorded_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_finance_charges_encounter FOREIGN KEY (facility_id, encounter_id)
    REFERENCES encounters(facility_id, encounter_id),
  CONSTRAINT fk_finance_charges_recorder FOREIGN KEY (recorded_by) REFERENCES users(user_id),
  CONSTRAINT ck_finance_charges_positive CHECK (amount > 0),
  UNIQUE KEY uq_finance_charges_uuid (charge_uuid),
  UNIQUE KEY uq_finance_charges_facility_idempotency (facility_id, idempotency_key),
  UNIQUE KEY uq_finance_charges_facility_charge (facility_id, charge_id),
  KEY ix_finance_charges_encounter_status (facility_id, encounter_id, status, recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE finance_invoices (
  invoice_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  invoice_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  encounter_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subtotal_amount DECIMAL(18,2) NOT NULL,
  status ENUM('issued') NOT NULL DEFAULT 'issued',
  issued_by BIGINT UNSIGNED NOT NULL,
  issued_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_finance_invoices_encounter FOREIGN KEY (facility_id, encounter_id)
    REFERENCES encounters(facility_id, encounter_id),
  CONSTRAINT fk_finance_invoices_issuer FOREIGN KEY (issued_by) REFERENCES users(user_id),
  CONSTRAINT ck_finance_invoices_subtotal CHECK (subtotal_amount > 0),
  UNIQUE KEY uq_finance_invoices_uuid (invoice_uuid),
  UNIQUE KEY uq_finance_invoices_facility_idempotency (facility_id, idempotency_key),
  UNIQUE KEY uq_finance_invoices_facility_invoice (facility_id, invoice_id),
  KEY ix_finance_invoices_encounter_issued (facility_id, encounter_id, issued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE finance_invoice_lines (
  invoice_line_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NOT NULL,
  charge_id BIGINT UNSIGNED NOT NULL,
  charge_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  description_ciphertext VARBINARY(896) NOT NULL,
  amount DECIMAL(13,2) NOT NULL,
  currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  CONSTRAINT fk_finance_lines_invoice FOREIGN KEY (facility_id, invoice_id)
    REFERENCES finance_invoices(facility_id, invoice_id),
  CONSTRAINT fk_finance_lines_charge FOREIGN KEY (facility_id, charge_id)
    REFERENCES finance_charges(facility_id, charge_id),
  CONSTRAINT ck_finance_lines_positive CHECK (amount > 0),
  UNIQUE KEY uq_finance_invoice_charge (charge_id),
  KEY ix_finance_invoice_lines_invoice (facility_id, invoice_id, invoice_line_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE finance_adjustments (
  adjustment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  adjustment_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  adjustment_type ENUM('debit', 'credit') NOT NULL,
  amount DECIMAL(13,2) NOT NULL,
  reason_ciphertext VARBINARY(2048) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_finance_adjustments_invoice FOREIGN KEY (facility_id, invoice_id)
    REFERENCES finance_invoices(facility_id, invoice_id),
  CONSTRAINT fk_finance_adjustments_creator FOREIGN KEY (created_by) REFERENCES users(user_id),
  CONSTRAINT ck_finance_adjustments_positive CHECK (amount > 0),
  UNIQUE KEY uq_finance_adjustments_uuid (adjustment_uuid),
  UNIQUE KEY uq_finance_adjustments_facility_idempotency (facility_id, idempotency_key),
  KEY ix_finance_adjustments_invoice_created (facility_id, invoice_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('finance.charge.read', 'Read encounter charges at an assigned facility'),
  ('finance.charge.create', 'Record a manual encounter charge at an assigned facility'),
  ('finance.invoice.read', 'Read issued invoices and adjustments at an assigned facility'),
  ('finance.invoice.create', 'Issue an invoice from unbilled encounter charges'),
  ('finance.adjustment.create', 'Append an audited debit or credit adjustment to an issued invoice');
