INSERT INTO permissions (permission_code, description) VALUES
  ('care.context.read', 'Read the shared clinical context for an encounter at an assigned facility');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_code IN ('clinician', 'triage_nurse', 'triage_clinician')
  AND p.permission_code = 'care.context.read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_code IN ('triage_nurse', 'triage_clinician')
  AND p.permission_code = 'encounter.observation.read';
