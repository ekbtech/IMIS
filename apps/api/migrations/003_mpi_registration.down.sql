DELETE rp FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE p.permission_code IN ('patient.registration.create', 'patient.mpi.search', 'patient.mpi.read');

DROP TABLE IF EXISTS patient_duplicate_reviews;
DROP TABLE IF EXISTS patients;
DELETE FROM permissions
WHERE permission_code IN ('patient.registration.create', 'patient.mpi.search', 'patient.mpi.read');
