import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessFacility } from "../security/access-control.js";
import { writeAuditEvent } from "../security/audit.js";
import {
  encounterUuidSchema,
  observationIdempotencyKeySchema,
  observationRecordSchema,
  type ObservationRecord,
} from "../validation/observation.js";

interface EncounterRow extends RowDataPacket {
  encounter_id: number;
  encounter_uuid: string;
  facility_id: number;
  status: "open" | "closed" | "cancelled";
  record_number: string;
}

interface ObservationRow extends RowDataPacket {
  observation_uuid: string;
  encounter_uuid: string;
  record_number: string;
  systolic_bp_mmhg: string | number | null;
  diastolic_bp_mmhg: string | number | null;
  pulse_bpm: string | number | null;
  respiratory_rate_bpm: string | number | null;
  temperature_celsius: string | number | null;
  oxygen_saturation_percent: string | number | null;
  weight_kg: string | number | null;
  height_cm: string | number | null;
  recorded_at: Date;
}

interface ObservationReplayRow extends ObservationRow {
  encounter_id: number;
  recorded_by: number;
  recorder_name: string;
}

interface FacilityRow extends RowDataPacket {
  facility_id: number;
}

const databaseFields = [
  ["systolicBpMmhg", "systolic_bp_mmhg"],
  ["diastolicBpMmhg", "diastolic_bp_mmhg"],
  ["pulseBpm", "pulse_bpm"],
  ["respiratoryRateBpm", "respiratory_rate_bpm"],
  ["temperatureCelsius", "temperature_celsius"],
  ["oxygenSaturationPercent", "oxygen_saturation_percent"],
  ["weightKg", "weight_kg"],
  ["heightCm", "height_cm"],
] as const satisfies readonly (readonly [keyof ObservationRecord, string])[];

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ER_DUP_ENTRY";
}

function observationValues(observation: ObservationRecord): (number | null)[] {
  return databaseFields.map(([field]) => observation[field] ?? null);
}

function matchesReplay(
  row: ObservationReplayRow,
  observation: ObservationRecord,
  encounterId: number,
  userId: number,
): boolean {
  const existingValues = [
    row.systolic_bp_mmhg,
    row.diastolic_bp_mmhg,
    row.pulse_bpm,
    row.respiratory_rate_bpm,
    row.temperature_celsius,
    row.oxygen_saturation_percent,
    row.weight_kg,
    row.height_cm,
  ];
  const submittedValues = [
    observation.systolicBpMmhg,
    observation.diastolicBpMmhg,
    observation.pulseBpm,
    observation.respiratoryRateBpm,
    observation.temperatureCelsius,
    observation.oxygenSaturationPercent,
    observation.weightKg,
    observation.heightCm,
  ];
  return Number(row.encounter_id) === encounterId &&
    Number(row.recorded_by) === userId &&
    existingValues.every((value, index) =>
      (value === null) === (submittedValues[index] === undefined) &&
      (value === null || Number(value) === submittedValues[index]));
}

function serializeObservation(row: ObservationRow) {
  return {
    observationId: row.observation_uuid,
    encounterId: row.encounter_uuid,
    recordNumber: row.record_number,
    systolicBpMmhg: row.systolic_bp_mmhg === null ? null : Number(row.systolic_bp_mmhg),
    diastolicBpMmhg: row.diastolic_bp_mmhg === null ? null : Number(row.diastolic_bp_mmhg),
    pulseBpm: row.pulse_bpm === null ? null : Number(row.pulse_bpm),
    respiratoryRateBpm: row.respiratory_rate_bpm === null ? null : Number(row.respiratory_rate_bpm),
    temperatureCelsius: row.temperature_celsius === null ? null : Number(row.temperature_celsius),
    oxygenSaturationPercent: row.oxygen_saturation_percent === null ? null : Number(row.oxygen_saturation_percent),
    weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
    heightCm: row.height_cm === null ? null : Number(row.height_cm),
    recordedBy: row.recorder_name,
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

async function loadEncounter(
  req: Request,
  res: Response,
  encounterUuid: string,
  connection?: PoolConnection,
  lock = false,
): Promise<EncounterRow | null> {
  const principal = req.principal;
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return null;
  }
  const executor = connection ?? pool;
  const [rows] = await executor.execute<EncounterRow[]>(
    `SELECT e.encounter_id, e.encounter_uuid, e.facility_id, e.status, p.record_number
     FROM encounters e
     JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
     WHERE e.encounter_uuid = ? AND p.status = 'active'
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [encounterUuid],
  );
  const encounter = rows[0];
  if (!encounter) {
    respondError(res, 404, "ENCOUNTER_NOT_FOUND", "The active encounter was not found.");
    return null;
  }
  if (!canAccessFacility(principal, Number(encounter.facility_id))) {
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "encounter.observation.facility_access",
      resourceType: "encounter",
      resourceId: encounterUuid,
      outcome: "denied",
      ipAddress: req.ip,
    });
    respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
    return null;
  }
  const [facilities] = await executor.execute<FacilityRow[]>(
    "SELECT facility_id FROM facilities WHERE facility_id = ? AND status = 'active' LIMIT 1",
    [encounter.facility_id],
  );
  if (!facilities[0]) {
    respondError(res, 404, "FACILITY_NOT_FOUND", "The requested facility is unavailable.");
    return null;
  }
  return encounter;
}

export const observationsRouter = Router();
observationsRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

observationsRouter.get(
  "/:encounterId/observations",
  requireSession,
  requirePermission("encounter.observation.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedId = encounterUuidSchema.safeParse(req.params.encounterId);
    if (!parsedId.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    try {
      const encounter = await loadEncounter(req, res, parsedId.data);
      if (!encounter) return;
      const [rows] = await pool.execute<ObservationRow[]>(
        `SELECT o.observation_uuid, e.encounter_uuid, p.record_number, u.display_name AS recorder_name,
                o.systolic_bp_mmhg, o.diastolic_bp_mmhg, o.pulse_bpm,
                o.respiratory_rate_bpm, o.temperature_celsius,
                o.oxygen_saturation_percent, o.weight_kg, o.height_cm, o.recorded_at
         FROM encounter_observations o
         JOIN encounters e ON e.encounter_id = o.encounter_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users u ON u.user_id = o.recorded_by
         WHERE o.encounter_id = ? AND o.facility_id = ?
         ORDER BY o.recorded_at DESC, o.observation_id DESC
         LIMIT 100`,
        [encounter.encounter_id, encounter.facility_id],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "encounter.observation.read",
        resourceType: "encounter",
        resourceId: parsedId.data,
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({
        observations: rows.map(serializeObservation),
        truncated: rows.length === 100,
      });
    } catch (error) {
      next(error);
    }
  },
);

observationsRouter.post(
  "/:encounterId/observations",
  requireSession,
  requirePermission("encounter.observation.record"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedId = encounterUuidSchema.safeParse(req.params.encounterId);
    const parsedObservation = observationRecordSchema.safeParse(req.body);
    const idempotencyKey = observationIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!parsedId.success || !parsedObservation.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter, measurement set, and Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }

    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    let facilityId: number | undefined;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const encounter = await loadEncounter(req, res, parsedId.data, connection, true);
      if (!encounter) {
        await connection.rollback();
        transactionStarted = false;
        return;
      }
      facilityId = Number(encounter.facility_id);
      if (encounter.status !== "open") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "ENCOUNTER_NOT_OPEN", "Observations can only be added to an open encounter.");
        return;
      }

      const [existingRows] = await connection.execute<ObservationReplayRow[]>(
        `SELECT o.observation_uuid, o.encounter_id, o.recorded_by, o.idempotency_key,
                e.encounter_uuid, p.record_number, u.display_name AS recorder_name, o.systolic_bp_mmhg, o.diastolic_bp_mmhg,
                o.pulse_bpm, o.respiratory_rate_bpm, o.temperature_celsius,
                o.oxygen_saturation_percent, o.weight_kg, o.height_cm, o.recorded_at
         FROM encounter_observations o
         JOIN encounters e ON e.encounter_id = o.encounter_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users u ON u.user_id = o.recorded_by
         WHERE o.facility_id = ? AND o.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [encounter.facility_id, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        if (!matchesReplay(existing, parsedObservation.data, Number(encounter.encounter_id), principal.userId)) {
          await connection.rollback();
          transactionStarted = false;
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different observation.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "encounter.observation.idempotent_replay",
          resourceType: "encounter",
          resourceId: parsedId.data,
          outcome: "allowed",
          ipAddress: req.ip,
        }, connection);
        await connection.commit();
        transactionStarted = false;
        res.json({ observation: serializeObservation(existing), idempotentReplay: true });
        return;
      }

      const observationUuid = randomUUID();
      const columns = databaseFields.map(([, column]) => column);
      const placeholders = databaseFields.map(() => "?");
      const values = observationValues(parsedObservation.data);
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO encounter_observations
          (observation_uuid, facility_id, encounter_id, idempotency_key, ${columns.join(", ")},
           recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ${placeholders.join(", ")}, ?, UTC_TIMESTAMP(6))`,
        [observationUuid, encounter.facility_id, encounter.encounter_id, idempotencyKey.data, ...values, principal.userId],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "encounter.observation.record",
        resourceType: "encounter",
        resourceId: String(result.insertId),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;

      const [rows] = await pool.execute<ObservationRow[]>(
        `SELECT o.observation_uuid, e.encounter_uuid, p.record_number, u.display_name AS recorder_name,
                o.systolic_bp_mmhg, o.diastolic_bp_mmhg, o.pulse_bpm,
                o.respiratory_rate_bpm, o.temperature_celsius,
                o.oxygen_saturation_percent, o.weight_kg, o.height_cm, o.recorded_at
         FROM encounter_observations o
         JOIN encounters e ON e.encounter_id = o.encounter_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users u ON u.user_id = o.recorded_by
         WHERE o.observation_uuid = ? AND o.facility_id = ?
         LIMIT 1`,
        [observationUuid, encounter.facility_id],
      );
      if (!rows[0]) throw new Error("The newly recorded observation could not be read back.");
      res.status(201).json({ observation: serializeObservation(rows[0]), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      transactionStarted = false;
      if (isDuplicateKeyError(error) && facilityId !== undefined) {
        try {
          const [rows] = await pool.execute<ObservationReplayRow[]>(
            `SELECT o.observation_uuid, o.encounter_id, o.recorded_by, o.idempotency_key,
                    e.encounter_uuid, p.record_number, u.display_name AS recorder_name, o.systolic_bp_mmhg, o.diastolic_bp_mmhg,
                    o.pulse_bpm, o.respiratory_rate_bpm, o.temperature_celsius,
                    o.oxygen_saturation_percent, o.weight_kg, o.height_cm, o.recorded_at
             FROM encounter_observations o
             JOIN encounters e ON e.encounter_id = o.encounter_id
             JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
             JOIN users u ON u.user_id = o.recorded_by
             WHERE o.facility_id = ? AND o.idempotency_key = ?
             LIMIT 1`,
            [facilityId, idempotencyKey.data],
          );
          const existing = rows[0];
          if (existing && parsedObservation.success &&
              existing.encounter_uuid === parsedId.data &&
              matchesReplay(existing, parsedObservation.data, Number(existing.encounter_id), principal.userId)) {
            await writeAuditEvent({
              actorUserId: principal.userId,
              action: "encounter.observation.idempotent_replay",
              resourceType: "encounter",
              resourceId: parsedId.data,
              outcome: "allowed",
              ipAddress: req.ip,
            });
            res.json({ observation: serializeObservation(existing), idempotentReplay: true });
            return;
          }
          if (existing) {
            respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different observation.");
            return;
          }
        } catch (recoveryError) {
          next(recoveryError);
          return;
        }
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);
