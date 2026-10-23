CREATE TABLE department_role_assignments (
  facility_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  assigned_at DATETIME(6) NOT NULL,
  assigned_by BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (facility_id, department_id, role_id),
  CONSTRAINT fk_department_role_department
    FOREIGN KEY (facility_id, department_id)
    REFERENCES departments(facility_id, department_id),
  CONSTRAINT fk_department_role_role
    FOREIGN KEY (role_id) REFERENCES roles(role_id),
  CONSTRAINT fk_department_role_actor
    FOREIGN KEY (assigned_by) REFERENCES users(user_id),
  KEY ix_department_role_by_role (role_id, facility_id, department_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
