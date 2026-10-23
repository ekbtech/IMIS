DELETE ud FROM user_departments ud
JOIN user_roles ur ON ur.user_id = ud.user_id
JOIN roles r ON r.role_id = ur.role_id
JOIN departments d ON d.department_id = ud.department_id AND d.facility_id = ud.facility_id
WHERE r.role_code IN ('finance_clerk', 'finance_biller', 'finance_supervisor')
  AND d.department_code = 'FINANCE';

DELETE ur FROM user_roles ur
JOIN roles r ON r.role_id = ur.role_id
WHERE r.role_code IN ('finance_clerk', 'finance_biller', 'finance_supervisor');

DELETE ud FROM user_departments ud
JOIN departments d ON d.department_id = ud.department_id
WHERE d.department_code = 'FINANCE';

DELETE rp FROM role_permissions rp
JOIN roles r ON r.role_id = rp.role_id
WHERE r.role_code IN ('finance_clerk', 'finance_biller', 'finance_supervisor');

DELETE FROM roles
WHERE role_code IN ('finance_clerk', 'finance_biller', 'finance_supervisor');

DELETE d FROM departments d
JOIN finance_role_migration_seeded_departments seeded
  ON seeded.facility_id = d.facility_id
WHERE d.department_code = 'FINANCE'
  AND NOT EXISTS (
    SELECT 1 FROM user_departments ud
    WHERE ud.facility_id = d.facility_id AND ud.department_id = d.department_id
  );

DROP TABLE finance_role_migration_seeded_departments;
