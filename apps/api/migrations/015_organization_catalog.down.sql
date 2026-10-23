DELETE rp FROM role_permissions rp
JOIN roles r ON r.role_id = rp.role_id
JOIN organization_catalog_seeded_roles seeded ON seeded.role_code = r.role_code
WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role_id = r.role_id);

DELETE r FROM roles r
JOIN organization_catalog_seeded_roles seeded ON seeded.role_code = r.role_code
WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role_id = r.role_id);

DELETE d FROM departments d
JOIN organization_catalog_seeded_departments seeded
  ON seeded.facility_id = d.facility_id
  AND seeded.department_code = d.department_code
WHERE NOT EXISTS (
  SELECT 1 FROM user_departments ud
  WHERE ud.facility_id = d.facility_id AND ud.department_id = d.department_id
)
AND NOT EXISTS (
  SELECT 1 FROM departments child
  WHERE child.facility_id = d.facility_id AND child.parent_department_id = d.department_id
)
AND NOT EXISTS (
  SELECT 1 FROM department_workflow_tasks t
  WHERE t.facility_id = d.facility_id
    AND (t.sending_department_id = d.department_id OR t.receiving_department_id = d.department_id)
);

DROP TABLE organization_catalog_seeded_roles;
DROP TABLE organization_catalog_seeded_departments;

ALTER TABLE departments
  DROP FOREIGN KEY fk_departments_parent,
  DROP KEY ix_departments_parent_order,
  DROP COLUMN display_order,
  DROP COLUMN parent_department_id,
  DROP COLUMN unit_type;

ALTER TABLE roles
  DROP COLUMN display_order,
  DROP COLUMN description;
