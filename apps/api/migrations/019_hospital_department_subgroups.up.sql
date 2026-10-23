ALTER TABLE departments
  ADD COLUMN hospital_subgroup ENUM(
    'outpatient',
    'emergency',
    'inpatient',
    'maternity',
    'specialty_clinics',
    'diagnostics',
    'treatment_support',
    'other'
  ) NULL
  AFTER department_group;

UPDATE departments
SET hospital_subgroup = CASE department_code
  WHEN 'OPD' THEN 'outpatient'
  WHEN 'OUTREACH' THEN 'outpatient'
  WHEN 'EMERGENCY' THEN 'emergency'
  WHEN 'TRIAGE' THEN 'emergency'
  WHEN 'AMBULANCE' THEN 'emergency'
  WHEN 'WARD' THEN 'inpatient'
  WHEN 'ICU' THEN 'inpatient'
  WHEN 'NICU' THEN 'inpatient'
  WHEN 'HDU' THEN 'inpatient'
  WHEN 'BURNS' THEN 'inpatient'
  WHEN 'MATERNITY' THEN 'maternity'
  WHEN 'OBSTETRICS_GYNAECOLOGY' THEN 'maternity'
  WHEN 'ANC' THEN 'maternity'
  WHEN 'PNC' THEN 'maternity'
  WHEN 'FAMILY_PLANNING' THEN 'maternity'
  WHEN 'CHILD_WELFARE' THEN 'maternity'
  WHEN 'LABOUR_WARD' THEN 'maternity'
  WHEN 'POSTNATAL_WARD' THEN 'maternity'
  WHEN 'LABORATORY' THEN 'diagnostics'
  WHEN 'RADIOLOGY' THEN 'diagnostics'
  WHEN 'BLOOD_BANK' THEN 'diagnostics'
  WHEN 'GENERAL_MEDICINE' THEN 'specialty_clinics'
  WHEN 'GENERAL_SURGERY' THEN 'specialty_clinics'
  WHEN 'PAEDIATRICS' THEN 'specialty_clinics'
  WHEN 'ORTHOPAEDICS' THEN 'specialty_clinics'
  WHEN 'UROLOGY' THEN 'specialty_clinics'
  WHEN 'CARDIOLOGY' THEN 'specialty_clinics'
  WHEN 'NEUROLOGY' THEN 'specialty_clinics'
  WHEN 'DERMATOLOGY' THEN 'specialty_clinics'
  WHEN 'PALLIATIVE_CARE' THEN 'specialty_clinics'
  WHEN 'EYE_CLINIC' THEN 'specialty_clinics'
  WHEN 'DENTAL_CLINIC' THEN 'specialty_clinics'
  WHEN 'RENAL_CLINIC' THEN 'specialty_clinics'
  WHEN 'DENTAL' THEN 'specialty_clinics'
  WHEN 'OPHTHALMOLOGY' THEN 'specialty_clinics'
  WHEN 'ENT' THEN 'specialty_clinics'
  WHEN 'ONCOLOGY' THEN 'specialty_clinics'
  WHEN 'DIALYSIS' THEN 'specialty_clinics'
  WHEN 'HIV_ART' THEN 'specialty_clinics'
  WHEN 'TB' THEN 'specialty_clinics'
  WHEN 'MENTAL_HEALTH' THEN 'specialty_clinics'
  WHEN 'REHABILITATION' THEN 'specialty_clinics'
  WHEN 'PHARMACY' THEN 'treatment_support'
  WHEN 'THEATRE' THEN 'treatment_support'
  WHEN 'CSSD' THEN 'treatment_support'
  WHEN 'ENDOSCOPY' THEN 'treatment_support'
  WHEN 'NUTRITION' THEN 'treatment_support'
  WHEN 'PHYSIOTHERAPY' THEN 'treatment_support'
  WHEN 'OCCUPATIONAL_THERAPY' THEN 'treatment_support'
  WHEN 'SPEECH_THERAPY' THEN 'treatment_support'
  WHEN 'SOCIAL_WORK' THEN 'treatment_support'
  WHEN 'IPC' THEN 'treatment_support'
  ELSE 'other'
END
WHERE department_group = 'hospital';
