DROP TABLE triage_assessments;
DROP TABLE triage_module_settings;

ALTER TABLE encounter_observations
  DROP INDEX uq_observations_facility_id;

DELETE FROM role_permissions
WHERE role_id IN (SELECT role_id FROM roles WHERE role_code IN ('triage_nurse', 'triage_clinician'));

DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT permission_id FROM permissions
  WHERE permission_code IN ('triage.queue.read', 'triage.assessment.capture', 'triage.assessment.review')
);

DELETE FROM permissions
WHERE permission_code IN ('triage.queue.read', 'triage.assessment.capture', 'triage.assessment.review');

DELETE FROM user_departments
WHERE department_id IN (SELECT department_id FROM departments WHERE department_code = 'TRIAGE');

DELETE FROM user_roles
WHERE role_id IN (SELECT role_id FROM roles WHERE role_code IN ('triage_nurse', 'triage_clinician'));

DELETE FROM roles WHERE role_code IN ('triage_nurse', 'triage_clinician');

DROP TABLE user_departments;

ALTER TABLE departments
  DROP INDEX uq_departments_facility_department;
