DELETE rp FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE p.permission_code IN (
  'encounter.note.read', 'encounter.note.create', 'encounter.note.sign', 'encounter.note.amend'
);

DELETE FROM permissions
WHERE permission_code IN (
  'encounter.note.read', 'encounter.note.create', 'encounter.note.sign', 'encounter.note.amend'
);

DROP TABLE encounter_notes;
