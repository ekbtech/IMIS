CREATE TABLE hospital_department_role_seed (
  role_code VARCHAR(64) NOT NULL PRIMARY KEY,
  facility_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NOT NULL,
  CONSTRAINT fk_hospital_role_seed_department
    FOREIGN KEY (facility_id, department_id)
    REFERENCES departments(facility_id, department_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO hospital_department_role_seed (role_code, facility_id, department_id)
SELECT CONCAT('hospital_', LOWER(d.department_code), '_staff'),
       d.facility_id,
       d.department_id
FROM departments d
WHERE d.department_group = 'hospital'
  AND d.status = 'active'
  AND CHAR_LENGTH(CONCAT('hospital_', LOWER(d.department_code), '_staff')) <= 64
  AND NOT EXISTS (
    SELECT 1
    FROM roles existing
    WHERE existing.role_code = CONCAT('hospital_', LOWER(d.department_code), '_staff')
  );

INSERT INTO roles (role_code, name, status, mfa_required, description, display_order)
SELECT seed.role_code,
       CONCAT(d.name, ' staff'),
       'inactive',
       TRUE,
       CONCAT('Hospital group catalogue role for ', d.name, '. Inactive and permissionless until explicitly reviewed and configured.'),
       0
FROM hospital_department_role_seed seed
JOIN departments d
  ON d.facility_id = seed.facility_id
 AND d.department_id = seed.department_id;
