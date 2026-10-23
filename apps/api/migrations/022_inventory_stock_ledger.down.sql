DELETE rp FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE p.permission_code IN (
  'inventory.stock.read', 'inventory.catalog.manage',
  'inventory.stock.receive', 'inventory.stock.issue'
);

DELETE FROM permissions
WHERE permission_code IN (
  'inventory.stock.read', 'inventory.catalog.manage',
  'inventory.stock.receive', 'inventory.stock.issue'
);

DROP TABLE inventory_stock_movements;
DROP TABLE inventory_stock_lots;
DROP TABLE inventory_items;
