DROP TABLE department_workflow_task_events;
DROP TABLE department_workflow_tasks;

DELETE rp FROM role_permissions rp
JOIN roles r ON r.role_id = rp.role_id
WHERE r.role_code = 'department_staff';

DELETE ud FROM user_departments ud
JOIN user_roles ur ON ur.user_id = ud.user_id
JOIN roles r ON r.role_id = ur.role_id
WHERE r.role_code = 'department_staff';

DELETE ur FROM user_roles ur
JOIN roles r ON r.role_id = ur.role_id
WHERE r.role_code = 'department_staff';

DELETE FROM roles WHERE role_code = 'department_staff';

DELETE FROM permissions
WHERE permission_code IN ('workflow.task.read', 'workflow.task.create', 'workflow.task.respond');

DELETE d FROM departments d
JOIN department_workflow_seeded_departments seeded
  ON seeded.facility_id = d.facility_id
  AND seeded.department_code = d.department_code
WHERE NOT EXISTS (
    SELECT 1 FROM user_departments ud
    WHERE ud.facility_id = d.facility_id AND ud.department_id = d.department_id
  );

DROP TABLE department_workflow_seeded_departments;
