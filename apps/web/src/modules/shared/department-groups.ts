export const departmentGroups = [
  { code: "hospital", label: "Hospital" },
  { code: "budget", label: "Budget" },
  { code: "inventory", label: "Inventory" },
  { code: "procurement", label: "Procurement" },
  { code: "hr", label: "HR" },
  { code: "finance", label: "Finance" },
  { code: "administration", label: "Administration" },
  { code: "system_tools", label: "System tools" },
  { code: "morgue", label: "Morgue" },
  { code: "reports", label: "Reports" },
] as const;

export type DepartmentGroupCode = typeof departmentGroups[number]["code"];

export const hospitalSubgroups = [
  { code: "outpatient", label: "OPD / Outpatient" },
  { code: "emergency", label: "Emergency & Triage" },
  { code: "inpatient", label: "Inpatient & Critical Care" },
  { code: "maternity", label: "Maternity & Newborn" },
  { code: "specialty_clinics", label: "Specialty Clinics" },
  { code: "diagnostics", label: "Diagnostics" },
  { code: "treatment_support", label: "Treatment & Support Services" },
  { code: "other", label: "Other Hospital Services" },
] as const;

export type HospitalSubgroupCode = typeof hospitalSubgroups[number]["code"];
