ALTER TABLE roles
  ADD COLUMN mfa_required BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE roles SET mfa_required = TRUE
WHERE role_code IN ('system_admin', 'clinician', 'privacy_officer');

ALTER TABLE sessions
  ADD COLUMN mfa_verified_at DATETIME(6) NULL;

ALTER TABLE users
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE user_mfa_credentials (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  secret_ciphertext VARBINARY(512) NULL,
  pending_secret_ciphertext VARBINARY(512) NULL,
  pending_expires_at DATETIME(6) NULL,
  confirmed_at DATETIME(6) NULL,
  last_verified_step BIGINT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_user_mfa_credentials_user FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description)
VALUES ('security.mfa.manage', 'Enroll and manage own multi-factor authentication');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r JOIN permissions p ON p.permission_code = 'security.mfa.manage'
WHERE r.role_code = 'system_admin';
