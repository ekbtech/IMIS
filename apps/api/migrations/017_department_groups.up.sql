ALTER TABLE departments
  ADD COLUMN department_group ENUM(
    'hospital',
    'budget',
    'inventory',
    'procurement',
    'hr',
    'finance',
    'administration',
    'system_tools',
    'morgue',
    'reports'
  ) NOT NULL DEFAULT 'hospital'
  AFTER department_code;

UPDATE departments
SET department_group = CASE department_code
  WHEN 'STORES' THEN 'inventory'
  WHEN 'PROCUREMENT' THEN 'procurement'
  WHEN 'HR' THEN 'hr'
  WHEN 'STAFF_HEALTH' THEN 'hr'
  WHEN 'FINANCE' THEN 'finance'
  WHEN 'MORTUARY' THEN 'morgue'
  WHEN 'ICT' THEN 'system_tools'
  WHEN 'HMIS' THEN 'reports'
  WHEN 'RECORDS' THEN 'reports'
  WHEN 'SOCIAL_WORK' THEN 'administration'
  WHEN 'IPC' THEN 'administration'
  WHEN 'QUALITY' THEN 'administration'
  WHEN 'RESEARCH' THEN 'administration'
  WHEN 'CATERING' THEN 'administration'
  WHEN 'LAUNDRY' THEN 'administration'
  WHEN 'CLEANING' THEN 'administration'
  WHEN 'SECURITY' THEN 'administration'
  WHEN 'WASTE_MANAGEMENT' THEN 'administration'
  WHEN 'CHAPLAINCY' THEN 'administration'
  ELSE 'hospital'
END;
