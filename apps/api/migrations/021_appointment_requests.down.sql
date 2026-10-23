DELETE rp FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE p.permission_code IN (
  'appointment.request.create', 'appointment.request.read', 'appointment.request.confirm'
);

DELETE FROM permissions
WHERE permission_code IN (
  'appointment.request.create', 'appointment.request.read', 'appointment.request.confirm'
);

DROP TABLE appointment_events;
DROP TABLE appointments;
