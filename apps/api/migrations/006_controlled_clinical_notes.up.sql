CREATE TABLE encounter_notes (
  note_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  note_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  root_note_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_note_id BIGINT UNSIGNED NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  encounter_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  note_type ENUM('clinical', 'nursing', 'handover', 'other') NOT NULL,
  title_ciphertext VARBINARY(768) NOT NULL,
  content_ciphertext VARBINARY(32768) NOT NULL,
  status ENUM('draft', 'signed') NOT NULL DEFAULT 'draft',
  version_number INT UNSIGNED NOT NULL,
  amendment_reason_ciphertext VARBINARY(4096) NULL,
  authored_by BIGINT UNSIGNED NOT NULL,
  signed_by BIGINT UNSIGNED NULL,
  signed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_notes_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_notes_encounter_facility FOREIGN KEY (facility_id, encounter_id)
    REFERENCES encounters(facility_id, encounter_id),
  CONSTRAINT fk_notes_parent FOREIGN KEY (parent_note_id) REFERENCES encounter_notes(note_id),
  CONSTRAINT fk_notes_author FOREIGN KEY (authored_by) REFERENCES users(user_id),
  CONSTRAINT fk_notes_signer FOREIGN KEY (signed_by) REFERENCES users(user_id),
  CONSTRAINT ck_notes_signature_state CHECK (
    (status = 'draft' AND signed_by IS NULL AND signed_at IS NULL) OR
    (status = 'signed' AND signed_by IS NOT NULL AND signed_at IS NOT NULL)
  ),
  CONSTRAINT ck_notes_version_reason CHECK (
    (version_number = 1 AND parent_note_id IS NULL AND amendment_reason_ciphertext IS NULL) OR
    (version_number > 1 AND parent_note_id IS NOT NULL AND amendment_reason_ciphertext IS NOT NULL)
  ),
  UNIQUE KEY uq_notes_uuid (note_uuid),
  UNIQUE KEY uq_notes_idempotency (facility_id, idempotency_key),
  UNIQUE KEY uq_notes_root_version (root_note_uuid, version_number),
  UNIQUE KEY uq_notes_facility_note (facility_id, note_id),
  KEY ix_notes_encounter_created (facility_id, encounter_id, created_at, note_id),
  KEY ix_notes_root_version (root_note_uuid, version_number),
  KEY ix_notes_author_status (authored_by, status, updated_at),
  CONSTRAINT fk_notes_parent_facility FOREIGN KEY (facility_id, parent_note_id)
    REFERENCES encounter_notes(facility_id, note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('encounter.note.read', 'Read clinical notes for encounters at an assigned facility'),
  ('encounter.note.create', 'Create clinical note drafts at an assigned facility'),
  ('encounter.note.sign', 'Sign own clinical note drafts at an assigned facility'),
  ('encounter.note.amend', 'Create a reasoned amendment to a signed clinical note');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r
JOIN permissions p ON p.permission_code IN (
  'encounter.note.read', 'encounter.note.create', 'encounter.note.sign', 'encounter.note.amend'
)
WHERE r.role_code = 'clinician';
