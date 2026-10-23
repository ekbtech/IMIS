import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessFacility } from "../security/access-control.js";
import { writeAuditEvent } from "../security/audit.js";
import {
  encounterQueueSchema,
  encounterRegistrationSchema,
  idempotencyKeySchema,
} from "../validation/encounter.js";

interface EncounterRow extends RowDataPacket {
  encounter_id: number;
  encounter_uuid: string;
  facility_id: number;
  patient_id: number;
  record_number: string;
  encounter_type: "outpatient" | "emergency";
  status: "open" | "closed" | "cancelled";
  idempotency_key: string;
  opened_at: Date;
  created_by: number;
}

interface FacilityRow extends RowDataPacket {
  facility_id: number;
}

interface PatientRow extends RowDataPacket {
  patient_id: number;
  record_number: string;
}

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

async function checkFacilityAccess(req: Request, res: Response, facilityId: number): Promise<boolean> {
  const principal = req.principal;
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return false;
  }
  if (!canAccessFacility(principal, facilityId)) {
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "encounter.facility_access",
      resourceType: "facility",
      resourceId: String(facilityId),
      outcome: "denied",
      ipAddress: req.ip,
    });
    respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
    return false;
  }
  const [facilities] = await pool.execute<FacilityRow[]>(
    "SELECT facility_id FROM facilities WHERE facility_id = ? AND status = 'active' LIMIT 1",
    [facilityId],
  );
  if (!facilities[0]) {
    respondError(res, 404, "FACILITY_NOT_FOUND", "The requested facility is unavailable.");
    return false;
  }
  return true;
}

function toEncounter(row: Pick<EncounterRow, "encounter_uuid" | "patient_id" | "record_number" | "encounter_type" | "status" | "opened_at">) {
  return {
    encounterId: row.encounter_uuid,
    patientId: row.patient_id,
    recordNumber: row.record_number,
    encounterType: row.encounter_type,
    status: row.status,
    openedAt: new Date(row.opened_at).toISOString(),
  };
}

function matchesIdempotentRequest(
  existing: EncounterRow,
  request: { patientId: number; encounterType: string },
  userId: number,
): boolean {
  return Number(existing.patient_id) === request.patientId &&
    existing.encounter_type === request.encounterType &&
    Number(existing.created_by) === userId;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ER_DUP_ENTRY";
}

export const encountersRouter = Router();
encountersRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
encountersRouter.use(requireSession);

encountersRouter.get("/", requirePermission("encounter.queue.read"), async (req, res, next) => {
  const principal = req.principal;
  const parsed = encounterQueueSchema.safeParse(req.query);
  if (!parsed.success) {
    respondError(res, 400, "INVALID_REQUEST", "Choose a valid facility.");
    return;
  }
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return;
  }

  try {
    if (!await checkFacilityAccess(req, res, parsed.data.facilityId)) return;
    const [rows] = await pool.execute<EncounterRow[]>(
      `SELECT e.encounter_id, e.encounter_uuid, e.facility_id, e.patient_id,
              p.record_number, e.encounter_type, e.status, e.idempotency_key,
              e.opened_at, e.created_by
       FROM encounters e
       JOIN patients p ON p.patient_id = e.patient_id
       WHERE e.facility_id = ? AND e.status = 'open'
       ORDER BY e.opened_at DESC, e.encounter_id DESC
       LIMIT 100`,
      [parsed.data.facilityId],
    );
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "encounter.queue.read",
      resourceType: "facility",
      resourceId: String(parsed.data.facilityId),
      outcome: "allowed",
      ipAddress: req.ip,
    });
    res.json({ encounters: rows.map(toEncounter), truncated: rows.length === 100 });
  } catch (error) {
    next(error);
  }
});

encountersRouter.post(
  "/",
  requirePermission("encounter.registration.create"),
  requirePermission("patient.mpi.search"),
  async (req, res, next) => {
  const principal = req.principal;
  const parsed = encounterRegistrationSchema.safeParse(req.body);
  const idempotencyKey = idempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
  if (!parsed.success || !idempotencyKey.success) {
    respondError(res, 400, "INVALID_REQUEST", "Provide a valid facility, patient, encounter type, and Idempotency-Key UUID.");
    return;
  }
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return;
  }

  let connection: PoolConnection | undefined;
  let transactionStarted = false;
  try {
    if (!await checkFacilityAccess(req, res, parsed.data.facilityId)) return;
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [existingRows] = await connection.execute<EncounterRow[]>(
      `SELECT e.encounter_id, e.encounter_uuid, e.facility_id, e.patient_id,
              p.record_number, e.encounter_type, e.status, e.idempotency_key,
              e.opened_at, e.created_by
       FROM encounters e
       JOIN patients p ON p.patient_id = e.patient_id
       WHERE e.facility_id = ? AND e.idempotency_key = ?
       LIMIT 1 FOR UPDATE`,
      [parsed.data.facilityId, idempotencyKey.data],
    );
    const existing = existingRows[0];
    if (existing) {
      if (!matchesIdempotentRequest(existing, parsed.data, principal.userId)) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different encounter.");
        return;
      }
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "encounter.registration.idempotent_replay",
        resourceType: "encounter",
        resourceId: existing.encounter_uuid,
        outcome: "allowed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;
      res.json({ encounter: toEncounter(existing), idempotentReplay: true });
      return;
    }

    const [patients] = await connection.execute<PatientRow[]>(
      "SELECT patient_id, record_number FROM patients WHERE patient_id = ? AND facility_id = ? AND status = 'active' LIMIT 1 FOR UPDATE",
      [parsed.data.patientId, parsed.data.facilityId],
    );
    if (!patients[0]) {
      await connection.rollback();
      transactionStarted = false;
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "encounter.registration.patient_unavailable",
        resourceType: "facility",
        resourceId: String(parsed.data.facilityId),
        outcome: "denied",
        ipAddress: req.ip,
        },
      );
      respondError(res, 404, "PATIENT_NOT_FOUND", "The active patient record was not found at this facility.");
      return;
    }

    const encounterUuid = randomUUID();
    const [insertResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO encounters
        (encounter_uuid, facility_id, patient_id, encounter_type, status, idempotency_key,
         opened_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, UTC_TIMESTAMP(6), ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [
        encounterUuid,
        parsed.data.facilityId,
        parsed.data.patientId,
        parsed.data.encounterType,
        idempotencyKey.data,
        principal.userId,
      ],
    );
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "encounter.registration.create",
      resourceType: "encounter",
      resourceId: String(insertResult.insertId),
      outcome: "changed",
      ipAddress: req.ip,
    }, connection);
    await connection.commit();
    transactionStarted = false;
    const row = {
      encounter_uuid: encounterUuid,
      patient_id: parsed.data.patientId,
      record_number: patients[0].record_number,
      encounter_type: parsed.data.encounterType,
      status: "open" as const,
      opened_at: new Date(),
    };
    res.status(201).json({ encounter: toEncounter(row), idempotentReplay: false });
  } catch (error) {
    if (transactionStarted && connection) await connection.rollback();
    transactionStarted = false;
    if (isDuplicateKeyError(error)) {
      try {
        const [rows] = await pool.execute<EncounterRow[]>(
          `SELECT e.encounter_id, e.encounter_uuid, e.facility_id, e.patient_id,
                  p.record_number, e.encounter_type, e.status, e.idempotency_key,
                  e.opened_at, e.created_by
           FROM encounters e
           JOIN patients p ON p.patient_id = e.patient_id
           WHERE e.facility_id = ? AND e.idempotency_key = ?
           LIMIT 1`,
          [parsed.data.facilityId, idempotencyKey.data],
        );
        const existing = rows[0];
        if (existing && matchesIdempotentRequest(existing, parsed.data, principal.userId)) {
          await writeAuditEvent({
            actorUserId: principal.userId,
            action: "encounter.registration.idempotent_replay",
            resourceType: "encounter",
            resourceId: existing.encounter_uuid,
            outcome: "allowed",
            ipAddress: req.ip,
          });
          res.json({ encounter: toEncounter(existing), idempotentReplay: true });
          return;
        }
        if (existing) {
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different encounter.");
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
});
