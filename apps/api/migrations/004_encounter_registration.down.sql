DELETE rp FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE p.permission_code IN ('encounter.registration.create', 'encounter.queue.read');

DELETE FROM permissions
WHERE permission_code IN ('encounter.registration.create', 'encounter.queue.read');

DROP TABLE encounters;

ALTER TABLE patients
  DROP INDEX uq_patients_facility_patient;
