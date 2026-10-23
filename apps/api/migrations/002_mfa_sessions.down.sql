DELETE rp FROM role_permissions rp
JOIN roles r ON r.role_id = rp.role_id
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE r.role_code = 'system_admin' AND p.permission_code = 'security.mfa.manage';

DELETE FROM permissions WHERE permission_code = 'security.mfa.manage';
DROP TABLE IF EXISTS user_mfa_credentials;
ALTER TABLE sessions DROP COLUMN mfa_verified_at;
ALTER TABLE users DROP COLUMN must_change_password;
ALTER TABLE roles DROP COLUMN mfa_required;
