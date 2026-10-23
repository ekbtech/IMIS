DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT permission_id FROM permissions
  WHERE permission_code IN (
    'inpatient.catalog.read', 'inpatient.admission.read',
    'inpatient.admission.create', 'inpatient.bed.assign',
    'inpatient.admission.discharge'
  )
);

DELETE FROM permissions
WHERE permission_code IN (
  'inpatient.catalog.read', 'inpatient.admission.read',
  'inpatient.admission.create', 'inpatient.bed.assign',
  'inpatient.admission.discharge'
);

DROP TABLE inpatient_bed_assignments;
DROP TABLE inpatient_admissions;
DROP TABLE inpatient_beds;
DROP TABLE inpatient_wards;
DROP TABLE inpatient_module_settings;
