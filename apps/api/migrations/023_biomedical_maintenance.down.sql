DELETE rp FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE p.permission_code IN (
  'maintenance.request.create', 'maintenance.request.read', 'maintenance.request.manage'
);

DELETE FROM permissions
WHERE permission_code IN (
  'maintenance.request.create', 'maintenance.request.read', 'maintenance.request.manage'
);

DROP TABLE maintenance_request_events;
DROP TABLE maintenance_requests;
