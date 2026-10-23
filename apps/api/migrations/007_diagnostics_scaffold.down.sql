DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT permission_id FROM permissions
  WHERE permission_code IN (
    'diagnostics.catalog.read', 'diagnostics.order.read',
    'diagnostics.order.create', 'diagnostics.order.cancel'
  )
);

DELETE FROM permissions
WHERE permission_code IN (
  'diagnostics.catalog.read', 'diagnostics.order.read',
  'diagnostics.order.create', 'diagnostics.order.cancel'
);

DROP TABLE diagnostic_orders;
DROP TABLE diagnostic_services;
DROP TABLE diagnostic_module_settings;
