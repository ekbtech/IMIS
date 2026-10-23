CREATE TABLE encounter_observations (
  observation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  observation_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id BIGINT UNSIGNED NOT NULL,
  encounter_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  systolic_bp_mmhg DECIMAL(6,2) NULL,
  diastolic_bp_mmhg DECIMAL(6,2) NULL,
  pulse_bpm DECIMAL(6,2) NULL,
  respiratory_rate_bpm DECIMAL(6,2) NULL,
  temperature_celsius DECIMAL(6,2) NULL,
  oxygen_saturation_percent DECIMAL(6,2) NULL,
  weight_kg DECIMAL(7,2) NULL,
  height_cm DECIMAL(6,2) NULL,
  recorded_by BIGINT UNSIGNED NOT NULL,
  recorded_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_observations_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_observations_encounter_facility FOREIGN KEY (facility_id, encounter_id)
    REFERENCES encounters(facility_id, encounter_id),
  CONSTRAINT fk_observations_recorder FOREIGN KEY (recorded_by) REFERENCES users(user_id),
  CONSTRAINT ck_observations_nonempty CHECK (
    systolic_bp_mmhg IS NOT NULL OR pulse_bpm IS NOT NULL OR respiratory_rate_bpm IS NOT NULL OR
    temperature_celsius IS NOT NULL OR oxygen_saturation_percent IS NOT NULL OR
    weight_kg IS NOT NULL OR height_cm IS NOT NULL
  ),
  CONSTRAINT ck_observations_bp_pair CHECK (
    (systolic_bp_mmhg IS NULL AND diastolic_bp_mmhg IS NULL) OR
    (systolic_bp_mmhg IS NOT NULL AND diastolic_bp_mmhg IS NOT NULL)
  ),
  CONSTRAINT ck_observations_bp_range CHECK (
    (systolic_bp_mmhg IS NULL OR systolic_bp_mmhg BETWEEN 0 AND 1000) AND
    (diastolic_bp_mmhg IS NULL OR diastolic_bp_mmhg BETWEEN 0 AND 1000)
  ),
  CONSTRAINT ck_observations_pulse_range CHECK (pulse_bpm IS NULL OR pulse_bpm BETWEEN 0 AND 1000),
  CONSTRAINT ck_observations_respiratory_range CHECK (
    respiratory_rate_bpm IS NULL OR respiratory_rate_bpm BETWEEN 0 AND 1000
  ),
  CONSTRAINT ck_observations_temperature_range CHECK (
    temperature_celsius IS NULL OR temperature_celsius BETWEEN -100 AND 200
  ),
  CONSTRAINT ck_observations_saturation_range CHECK (
    oxygen_saturation_percent IS NULL OR oxygen_saturation_percent BETWEEN 0 AND 100
  ),
  CONSTRAINT ck_observations_weight_range CHECK (weight_kg IS NULL OR weight_kg BETWEEN 0 AND 99999.99),
  CONSTRAINT ck_observations_height_range CHECK (height_cm IS NULL OR height_cm BETWEEN 0 AND 9999.99),
  UNIQUE KEY uq_observations_uuid (observation_uuid),
  UNIQUE KEY uq_observations_idempotency (facility_id, idempotency_key),
  KEY ix_observations_encounter_time (encounter_id, recorded_at, observation_id),
  KEY ix_observations_recorder_time (recorded_by, recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (permission_code, description) VALUES
  ('encounter.observation.read', 'Read recorded encounter observations at an assigned facility'),
  ('encounter.observation.record', 'Record encounter observations at an assigned facility');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r
JOIN permissions p ON p.permission_code IN ('encounter.observation.read', 'encounter.observation.record')
WHERE r.role_code = 'clinician';
