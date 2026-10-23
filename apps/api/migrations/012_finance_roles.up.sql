CREATE TABLE finance_role_migration_seeded_departments (
  facility_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  CONSTRAINT fk_finance_role_seed_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO finance_role_migration_seeded_departments (facility_id)
SELECT f.facility_id
FROM facilities f
WHERE f.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM departments d
    WHERE d.facility_id = f.facility_id AND d.department_code = 'FINANCE'
  );

INSERT INTO departments (facility_id, department_code, name, status)
SELECT facility_id, 'FINANCE', 'Finance', 'active'
FROM finance_role_migration_seeded_departments;

INSERT INTO roles (role_code, name, status, mfa_required) VALUES
  ('finance_clerk', 'Finance charge clerk', 'active', TRUE),
  ('finance_biller', 'Finance billing officer', 'active', TRUE),
  ('finance_supervisor', 'Finance supervisor', 'active', TRUE);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE (r.role_code = 'finance_clerk' AND p.permission_code IN (
  'finance.charge.read',
  'finance.charge.create',
  'finance.invoice.read'
)) OR (r.role_code = 'finance_biller' AND p.permission_code IN (
  'finance.charge.read',
  'finance.invoice.read',
  'finance.invoice.create'
)) OR (r.role_code = 'finance_supervisor' AND p.permission_code IN (
  'finance.charge.read',
  'finance.invoice.read',
  'finance.adjustment.create'
));
