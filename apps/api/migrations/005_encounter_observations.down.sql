DELETE rp FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE p.permission_code IN ('encounter.observation.read', 'encounter.observation.record');

DELETE FROM permissions
WHERE permission_code IN ('encounter.observation.read', 'encounter.observation.record');

DROP TABLE encounter_observations;
