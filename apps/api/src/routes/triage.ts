import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessDepartment, type Principal } from "../security/access-control.js";
import { writeAuditEvent } from "../security/audit.js";
import {
  triageAssessmentUuidSchema,
  triageFacilitySchema,
  triageIdempotencyKeySchema,
  triageObservationSchema,
  type TriageObservation,
} from "../validation/triage.js";

interface TriageDepartmentRow extends RowDataPacket {
  department_id: number;
}

interface EncounterRow extends RowDataPacket {
  encounter_id: number;
  encounter_uuid: string;
  facility_id: number;
  status: "open" | "closed" | "cancelled";
}

interface TriageAssessmentRow extends RowDataPacket {
  triage_assessment_id: number;
  triage_uuid: string;
  facility_id: number;
  encounter_id: number;
  observation_id: number;
  status: "awaiting_review" | "reviewed";
  captured_by: number;
  reviewed_by: number | null;
}

interface ReplayRow extends TriageAssessmentRow {
  observation_recorded_by: number;
  systolic_bp_mmhg: string | number | null;
  diastolic_bp_mmhg: string | number | null;
  pulse_bpm: string | number | null;
  respiratory_rate_bpm: string | number | null;
  temperature_celsius: string | number | null;
  oxygen_saturation_percent: string | number | null;
  weight_kg: string | number | null;
  height_cm: string | number | null;
}

interface TriageQueueRow extends RowDataPacket {
  triage_uuid: string;
  encounter_uuid: string;
  record_number: string;
  status: "awaiting_review" | "reviewed";
  captured_at: Date;
  capturer_name: string;
  observation_uuid: string;
  systolic_bp_mmhg: string | number | null;
  diastolic_bp_mmhg: string | number | null;
  pulse_bpm: string | number | null;
  respiratory_rate_bpm: string | number | null;
  temperature_celsius: string | number | null;
  oxygen_saturation_percent: string | number | null;
  weight_kg: string | number | null;
  height_cm: string | number | null;
}

interface TriageArrivalRow extends RowDataPacket {
  encounter_uuid: string;
  record_number: string;
  encounter_type: "outpatient" | "emergency";
  opened_at: Date;
}

const observationFields = [
  ["systolicBpMmhg", "systolic_bp_mmhg"],
  ["diastolicBpMmhg", "diastolic_bp_mmhg"],
  ["pulseBpm", "pulse_bpm"],
  ["respiratoryRateBpm", "respiratory_rate_bpm"],
  ["temperatureCelsius", "temperature_celsius"],
  ["oxygenSaturationPercent", "oxygen_saturation_percent"],
  ["weightKg", "weight_kg"],
  ["heightCm", "height_cm"],
] as const satisfies readonly (readonly [keyof TriageObservation, string])[];

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ER_DUP_ENTRY";
}

function observationValues(observation: TriageObservation): (number | null)[] {
  return observationFields.map(([field]) => observation[field] ?? null);
}

function matchesObservation(row: ReplayRow, observation: TriageObservation, userId: number): boolean {
  return Number(row.observation_recorded_by) === userId &&
    observationFields.every(([field, column]) => {
      const stored = row[column];
      const submitted = observation[field];
      return (stored === null) === (submitted === undefined) &&
        (stored === null || Number(stored) === submitted);
    });
}

function serializeQueueRow(row: TriageQueueRow) {
  return {
    triageId: row.triage_uuid,
    encounterId: row.encounter_uuid,
    recordNumber: row.record_number,
    status: row.status,
    capturedAt: new Date(row.captured_at).toISOString(),
    capturedBy: row.capturer_name,
    observationId: row.observation_uuid,
    observations: {
      systolicBpMmhg: row.systolic_bp_mmhg === null ? null : Number(row.systolic_bp_mmhg),
      diastolicBpMmhg: row.diastolic_bp_mmhg === null ? null : Number(row.diastolic_bp_mmhg),
      pulseBpm: row.pulse_bpm === null ? null : Number(row.pulse_bpm),
      respiratoryRateBpm: row.respiratory_rate_bpm === null ? null : Number(row.respiratory_rate_bpm),
      temperatureCelsius: row.temperature_celsius === null ? null : Number(row.temperature_celsius),
      oxygenSaturationPercent: row.oxygen_saturation_percent === null ? null : Number(row.oxygen_saturation_percent),
      weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
      heightCm: row.height_cm === null ? null : Number(row.height_cm),
    },
  };
}

async function checkDepartmentAssignment(
  principal: Principal,
  facilityId: number,
  executor: PoolConnection | typeof pool,
): Promise<boolean> {
  const [rows] = await executor.execute<TriageDepartmentRow[]>(
    `SELECT department_id FROM departments
     WHERE facility_id = ? AND department_code = 'TRIAGE' AND status = 'active'
     LIMIT 1`,
    [facilityId],
  );
  const departmentId = rows[0]?.department_id;
  return departmentId !== undefined && canAccessDepartment(principal, facilityId, Number(departmentId));
}

async function checkModuleEnabled(
  req: Request,
  res: Response,
  facilityId: number,
  connection?: PoolConnection,
): Promise<boolean> {
  const [rows] = await (connection ?? pool).execute<RowDataPacket[]>(
    `SELECT enabled, workflow_approval_reference, approved_by, approved_at
     FROM triage_module_settings WHERE facility_id = ? LIMIT 1`,
    [facilityId],
  );
  const settings = rows[0];
  if (!settings || Number(settings.enabled) !== 1 || !settings.workflow_approval_reference ||
      !settings.approved_by || !settings.approved_at) {
    await writeAuditEvent({
      actorUserId: req.principal?.userId ?? null,
      action: "triage.module.disabled",
      resourceType: "facility",
      resourceId: String(facilityId),
      outcome: "denied",
      ipAddress: req.ip,
    }, connection);
    respondError(res, 503, "TRIAGE_DISABLED", "Triage capture is disabled until facility approval and activation are recorded.");
    return false;
  }
  return true;
}

export const triageRouter = Router();
triageRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
triageRouter.use(requireSession);

triageRouter.get(
  "/queue",
  requirePermission("triage.queue.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsed = triageFacilitySchema.safeParse(req.query);
    if (!parsed.success) {
      respondError(res, 400, "INVALID_REQUEST", "Choose a valid facility.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    const facilityId = parsed.data.facilityId;
    if (!principal.facilityIds.has(facilityId)) {
      respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
      return;
    }
    try {
      if (!await checkDepartmentAssignment(principal, facilityId, pool)) {
        respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "You are not assigned to the triage department.");
        return;
      }
      if (!await checkModuleEnabled(req, res, facilityId)) return;
      const [arrivalRows] = await pool.execute<TriageArrivalRow[]>(
        `SELECT e.encounter_uuid, p.record_number, e.encounter_type, e.opened_at
         FROM encounters e
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         WHERE e.facility_id = ? AND e.status = 'open' AND p.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM triage_assessments t
             WHERE t.facility_id = e.facility_id AND t.encounter_id = e.encounter_id
               AND t.status = 'awaiting_review'
           )
         ORDER BY e.opened_at, e.encounter_id
         LIMIT 100`,
        [facilityId],
      );
      const [rows] = await pool.execute<TriageQueueRow[]>(
        `SELECT t.triage_uuid, e.encounter_uuid, p.record_number, t.status, t.captured_at,
                capturer.display_name AS capturer_name, o.observation_uuid,
                o.systolic_bp_mmhg, o.diastolic_bp_mmhg, o.pulse_bpm,
                o.respiratory_rate_bpm, o.temperature_celsius,
                o.oxygen_saturation_percent, o.weight_kg, o.height_cm
         FROM triage_assessments t
         JOIN encounters e ON e.encounter_id = t.encounter_id AND e.facility_id = t.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN encounter_observations o ON o.observation_id = t.observation_id AND o.facility_id = t.facility_id
         JOIN users capturer ON capturer.user_id = t.captured_by
         WHERE t.facility_id = ? AND t.status = 'awaiting_review' AND p.status = 'active'
         ORDER BY t.captured_at, t.triage_assessment_id
         LIMIT 100`,
        [facilityId],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "triage.queue.read",
        resourceType: "facility",
        resourceId: String(facilityId),
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({
        arrivals: arrivalRows.map((row) => ({
          encounterId: row.encounter_uuid,
          recordNumber: row.record_number,
          encounterType: row.encounter_type,
          openedAt: new Date(row.opened_at).toISOString(),
        })),
        assessments: rows.map(serializeQueueRow),
        truncated: rows.length === 100 || arrivalRows.length === 100,
      });
    } catch (error) {
      next(error);
    }
  },
);

triageRouter.post(
  "/encounters/:encounterId/assessments",
  requirePermission("triage.assessment.capture"),
  async (req, res, next) => {
    const principal = req.principal;
    const encounterUuid = triageAssessmentUuidSchema.safeParse(req.params.encounterId);
    const observation = triageObservationSchema.safeParse(req.body);
    const idempotencyKey = triageIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!encounterUuid.success || !observation.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter, observations and Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }

    const connection = await pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const [encounters] = await connection.execute<EncounterRow[]>(
        `SELECT e.encounter_id, e.encounter_uuid, e.facility_id, e.status
         FROM encounters e
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         WHERE e.encounter_uuid = ? AND p.status = 'active' LIMIT 1 FOR UPDATE`,
        [encounterUuid.data],
      );
      const encounter = encounters[0];
      if (!encounter) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "ENCOUNTER_NOT_FOUND", "The encounter was not found.");
        return;
      }
      const facilityId = Number(encounter.facility_id);
      if (!principal.facilityIds.has(facilityId)) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
        return;
      }
      if (!await checkDepartmentAssignment(principal, facilityId, connection)) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "You are not assigned to the triage department.");
        return;
      }
      if (!await checkModuleEnabled(req, res, facilityId, connection)) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      if (encounter.status !== "open") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "ENCOUNTER_NOT_OPEN", "Triage observations can only be added to an open encounter.");
        return;
      }

      const [existingRows] = await connection.execute<ReplayRow[]>(
        `SELECT t.triage_assessment_id, t.triage_uuid, t.facility_id, t.encounter_id,
                t.observation_id, t.status, t.captured_by, t.reviewed_by,
                o.recorded_by AS observation_recorded_by,
                o.systolic_bp_mmhg, o.diastolic_bp_mmhg, o.pulse_bpm,
                o.respiratory_rate_bpm, o.temperature_celsius,
                o.oxygen_saturation_percent, o.weight_kg, o.height_cm
         FROM triage_assessments t
         JOIN encounter_observations o ON o.observation_id = t.observation_id
           AND o.facility_id = t.facility_id
         WHERE t.facility_id = ? AND t.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [facilityId, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        if (Number(existing.encounter_id) !== Number(encounter.encounter_id) ||
            Number(existing.captured_by) !== principal.userId ||
            !matchesObservation(existing, observation.data, principal.userId)) {
          await connection.rollback();
          transactionStarted = false;
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for different triage data.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "triage.assessment.idempotent_replay",
          resourceType: "triage_assessment",
          resourceId: existing.triage_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        }, connection);
        await connection.commit();
        transactionStarted = false;
        res.json({ triageId: existing.triage_uuid, status: existing.status, idempotentReplay: true });
        return;
      }

      const observationUuid = randomUUID();
      const [observationResult] = await connection.execute<ResultSetHeader>(
        `INSERT INTO encounter_observations
          (observation_uuid, facility_id, encounter_id, idempotency_key,
           systolic_bp_mmhg, diastolic_bp_mmhg, pulse_bpm, respiratory_rate_bpm,
           temperature_celsius, oxygen_saturation_percent, weight_kg, height_cm,
           recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [
          observationUuid, facilityId, encounter.encounter_id, idempotencyKey.data,
          ...observationValues(observation.data), principal.userId,
        ],
      );
      const triageUuid = randomUUID();
      await connection.execute(
        `INSERT INTO triage_assessments
          (triage_uuid, facility_id, encounter_id, observation_id, idempotency_key,
           status, captured_by, captured_at, reviewed_by, reviewed_at)
         VALUES (?, ?, ?, ?, ?, 'awaiting_review', ?, UTC_TIMESTAMP(6), NULL, NULL)`,
        [triageUuid, facilityId, encounter.encounter_id, observationResult.insertId, idempotencyKey.data, principal.userId],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "triage.assessment.capture",
        resourceType: "triage_assessment",
        resourceId: triageUuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ triageId: triageUuid, status: "awaiting_review", idempotentReplay: false });
    } catch (error) {
      if (transactionStarted) await connection.rollback();
      if (isDuplicateKeyError(error)) {
        respondError(res, 409, "TRIAGE_ALREADY_PENDING", "This encounter already has an assessment awaiting clinician review.");
        return;
      }
      next(error);
    } finally {
      connection.release();
    }
  },
);

triageRouter.post(
  "/assessments/:triageId/review",
  requirePermission("triage.assessment.review"),
  async (req, res, next) => {
    const principal = req.principal;
    const triageUuid = triageAssessmentUuidSchema.safeParse(req.params.triageId);
    if (!triageUuid.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid triage assessment identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }

    const connection = await pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const [rows] = await connection.execute<TriageAssessmentRow[]>(
        `SELECT t.triage_assessment_id, t.triage_uuid, t.facility_id, t.encounter_id,
                t.observation_id, t.status, t.captured_by, t.reviewed_by
         FROM triage_assessments t
         JOIN encounters e ON e.encounter_id = t.encounter_id AND e.facility_id = t.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         WHERE t.triage_uuid = ? AND p.status = 'active'
         LIMIT 1 FOR UPDATE`,
        [triageUuid.data],
      );
      const assessment = rows[0];
      if (!assessment) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "TRIAGE_ASSESSMENT_NOT_FOUND", "The triage assessment was not found.");
        return;
      }
      const facilityId = Number(assessment.facility_id);
      if (!principal.facilityIds.has(facilityId)) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
        return;
      }
      if (!await checkDepartmentAssignment(principal, facilityId, connection)) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "You are not assigned to the triage department.");
        return;
      }
      if (!await checkModuleEnabled(req, res, facilityId, connection)) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      if (assessment.status === "reviewed") {
        if (Number(assessment.reviewed_by) !== principal.userId) {
          await connection.rollback();
          transactionStarted = false;
          respondError(res, 409, "TRIAGE_ALREADY_REVIEWED", "Another clinician has already reviewed this assessment.");
          return;
        }
        await connection.commit();
        transactionStarted = false;
        res.json({ triageId: assessment.triage_uuid, status: "reviewed", idempotentReplay: true });
        return;
      }

      await connection.execute(
        `UPDATE triage_assessments
         SET status = 'reviewed', reviewed_by = ?, reviewed_at = UTC_TIMESTAMP(6)
         WHERE triage_assessment_id = ? AND status = 'awaiting_review'`,
        [principal.userId, assessment.triage_assessment_id],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "triage.assessment.review",
        resourceType: "triage_assessment",
        resourceId: assessment.triage_uuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;
      res.json({ triageId: assessment.triage_uuid, status: "reviewed", idempotentReplay: false });
    } catch (error) {
      if (transactionStarted) await connection.rollback();
      next(error);
    } finally {
      connection.release();
    }
  },
);
