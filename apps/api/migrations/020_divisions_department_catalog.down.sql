ALTER TABLE departments
  DROP FOREIGN KEY fk_departments_division,
  DROP KEY ix_departments_facility_division_order,
  DROP COLUMN division_id;

DROP TABLE divisions;
