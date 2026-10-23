DELETE rp FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE p.permission_code IN ('asset.register.read', 'asset.register.manage');

DELETE FROM permissions
WHERE permission_code IN ('asset.register.read', 'asset.register.manage');

DROP TABLE facility_asset_events;
DROP TABLE facility_assets;
