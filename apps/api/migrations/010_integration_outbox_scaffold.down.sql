DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT permission_id FROM permissions
  WHERE permission_code IN (
    'integration.outbox.read',
    'integration.reconciliation.read',
    'integration.reconciliation.update'
  )
);

DELETE FROM permissions
WHERE permission_code IN (
  'integration.outbox.read',
  'integration.reconciliation.read',
  'integration.reconciliation.update'
);

DROP TABLE integration_reconciliation;
DROP TABLE integration_delivery_attempts;
DROP TABLE integration_outbox;
DROP TABLE integration_connections;
