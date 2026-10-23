DELETE rp
FROM role_permissions rp
JOIN roles r ON r.role_id = rp.role_id
JOIN hospital_department_role_seed seed ON seed.role_code = r.role_code
WHERE NOT EXISTS (
  SELECT 1 FROM user_roles ur WHERE ur.role_id = r.role_id
);

DELETE dra
FROM department_role_assignments dra
JOIN roles r ON r.role_id = dra.role_id
JOIN hospital_department_role_seed seed ON seed.role_code = r.role_code
WHERE NOT EXISTS (
  SELECT 1 FROM user_roles ur WHERE ur.role_id = r.role_id
);

DELETE r
FROM roles r
JOIN hospital_department_role_seed seed ON seed.role_code = r.role_code
WHERE NOT EXISTS (
  SELECT 1 FROM user_roles ur WHERE ur.role_id = r.role_id
);

DROP TABLE hospital_department_role_seed;
