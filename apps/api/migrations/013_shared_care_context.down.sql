DELETE rp FROM role_permissions rp
JOIN roles r ON r.role_id = rp.role_id
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE (r.role_code IN ('clinician', 'triage_nurse', 'triage_clinician')
       AND p.permission_code = 'care.context.read')
   OR (r.role_code IN ('triage_nurse', 'triage_clinician')
       AND p.permission_code = 'encounter.observation.read');

DELETE FROM permissions
WHERE permission_code = 'care.context.read';
