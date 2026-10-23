DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT permission_id FROM permissions
  WHERE permission_code IN (
    'finance.charge.read', 'finance.charge.create', 'finance.invoice.read',
    'finance.invoice.create', 'finance.adjustment.create'
  )
);

DELETE FROM permissions
WHERE permission_code IN (
  'finance.charge.read', 'finance.charge.create', 'finance.invoice.read',
  'finance.invoice.create', 'finance.adjustment.create'
);

DROP TABLE finance_adjustments;
DROP TABLE finance_invoice_lines;
DROP TABLE finance_invoices;
DROP TABLE finance_charges;
DROP TABLE finance_module_settings;
