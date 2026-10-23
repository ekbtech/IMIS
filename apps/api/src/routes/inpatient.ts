import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessFacility } from "../security/access-control.js";
import { writeAuditEvent } from "../security/audit.js";
import {
  inpatientAdmissionSchema,
  inpatientAdmissionUuidSchema,
  inpatientBedAssignmentSchema,
  inpatientDischargeSchema,
  inpatientEncounterUuidSchema,
  inpatientFacilityIdSchema,
  inpatientIdempotencyKeySchema,
} from "../validation/inpatient.js";

interface EncounterRow extends RowDataPacket {
  encounter_id: number;
  encounter_uuid: string;
  facility_id: number;
  status: "open" | "closed" | "cancelled";
  record_number: string;
}

interface AdmissionRow extends RowDataPacket {
  admission_id: number;
  admission_uuid: string;
  facility_id: number;
  encounter_id: number;
  encounter_uuid: string;
  record_number: string;
  status: "active" | "discharged";
  admitted_by: number;
  admitted_by_name: string;
  admitted_at: Date;
  discharged_by: number | null;
  discharged_by_name: string | null;
  discharged_at: Date | null;
  discharge_idempotency_key: string | null;
  current_bed_uuid: string | null;
  current_bed_code: string | null;
  current_ward_uuid: string | null;
  current_ward_code: string | null;
  current_ward_name: string | null;
}

interface BedRow extends RowDataPacket {
  bed_id: number;
  bed_uuid: string;
  bed_code: string;
  ward_id: number;
  ward_uuid: string;
  ward_code: string;
  ward_name: string;
}

interface AssignmentRow extends RowDataPacket {
  assignment_id: number;
  assignment_uuid: string;
  facility_id: number;
  admission_id: number;
  admission_uuid: string;
  bed_id: number;
  bed_uuid: string;
  bed_code: string;
  ward_uuid: string;
  ward_code: string;
  ward_name: string;
  assigned_by: number;
  assigner_name: string;
  assigned_at: Date;
  ended_by: number | null;
  ender_name: string | null;
  ended_at: Date | null;
  end_reason: "transferred" | "discharged" | null;
}

interface FacilityRow extends RowDataPacket {
  facility_id: number;
}

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ER_DUP_ENTRY";
}

async function inpatientEnabled(
  req: Request,
  facilityId: number,
  res: Response,
  connection?: PoolConnection,
  lock = false,
): Promise<boolean> {
  const executor = connection ?? pool;
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT enabled, workflow_approval_reference, approved_by, approved_at
     FROM inpatient_module_settings WHERE facility_id = ?
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [facilityId],
  );
  const settings = rows[0];
  if (!settings || Number(settings.enabled) !== 1 || !settings.workflow_approval_reference ||
      !settings.approved_by || !settings.approved_at) {
    await writeAuditEvent({
      actorUserId: req.principal?.userId ?? null,
      action: "inpatient.module.disabled",
      resourceType: "facility",
      resourceId: String(facilityId),
      outcome: "denied",
      ipAddress: req.ip,
    }, connection);
    respondError(res, 503, "INPATIENT_DISABLED", "Inpatient workflows are disabled until facility approval and activation are recorded.");
    return false;
  }
  return true;
}

async function checkFacilityAccess(
  req: Request,
  res: Response,
  facilityId: number,
  connection?: PoolConnection,
): Promise<boolean> {
  const principal = req.principal;
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return false;
  }
  if (!canAccessFacility(principal, facilityId)) {
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "inpatient.facility_access",
      resourceType: "facility",
      resourceId: String(facilityId),
      outcome: "denied",
      ipAddress: req.ip,
    }, connection);
    respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
    return false;
  }
  const [facilities] = await (connection ?? pool).execute<FacilityRow[]>(
    "SELECT facility_id FROM facilities WHERE facility_id = ? AND status = 'active' LIMIT 1",
    [facilityId],
  );
  if (!facilities[0]) {
    respondError(res, 404, "FACILITY_NOT_FOUND", "The requested facility is unavailable.");
    return false;
  }
  return true;
}

async function loadEncounter(
  req: Request,
  res: Response,
  encounterUuid: string,
  connection: PoolConnection,
): Promise<EncounterRow | null> {
  const principal = req.principal;
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return null;
  }
  const [rows] = await connection.execute<EncounterRow[]>(
    `SELECT e.encounter_id, e.encounter_uuid, e.facility_id, e.status, p.record_number
     FROM encounters e
     JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
     WHERE e.encounter_uuid = ? AND p.status = 'active'
     LIMIT 1 FOR UPDATE`,
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
      action: "inpatient.facility_access",
      resourceType: "encounter",
      resourceId: encounterUuid,
      outcome: "denied",
      ipAddress: req.ip,
    }, connection);
    respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
    return null;
  }
  const [facilities] = await connection.execute<FacilityRow[]>(
    "SELECT facility_id FROM facilities WHERE facility_id = ? AND status = 'active' LIMIT 1",
    [encounter.facility_id],
  );
  if (!facilities[0]) {
    respondError(res, 404, "FACILITY_NOT_FOUND", "The requested facility is unavailable.");
    return null;
  }
  return encounter;
}

async function loadAdmission(
  connection: PoolConnection | typeof pool,
  admissionUuid: string,
  lock = false,
): Promise<AdmissionRow | null> {
  const [rows] = await connection.execute<AdmissionRow[]>(
    `SELECT a.admission_id, a.admission_uuid, a.facility_id, a.encounter_id,
            e.encounter_uuid, p.record_number, a.status, a.admitted_by,
            adm.display_name AS admitted_by_name, a.admitted_at, a.discharged_by,
            dis.display_name AS discharged_by_name, a.discharged_at,
            a.discharge_idempotency_key, b.bed_uuid AS current_bed_uuid,
            b.bed_code AS current_bed_code, w.ward_uuid AS current_ward_uuid,
            w.ward_code AS current_ward_code, w.display_name AS current_ward_name
     FROM inpatient_admissions a
     JOIN encounters e ON e.encounter_id = a.encounter_id AND e.facility_id = a.facility_id
     JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
     JOIN users adm ON adm.user_id = a.admitted_by
     LEFT JOIN users dis ON dis.user_id = a.discharged_by
     LEFT JOIN inpatient_bed_assignments ba
       ON ba.facility_id = a.facility_id AND ba.admission_id = a.admission_id AND ba.ended_at IS NULL
     LEFT JOIN inpatient_beds b ON b.facility_id = ba.facility_id AND b.bed_id = ba.bed_id
     LEFT JOIN inpatient_wards w ON w.facility_id = b.facility_id AND w.ward_id = b.ward_id
     WHERE a.admission_uuid = ? AND p.status = 'active'
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [admissionUuid],
  );
  return rows[0] ?? null;
}

function serializeAdmission(row: AdmissionRow) {
  return {
    admissionId: row.admission_uuid,
    encounterId: row.encounter_uuid,
    recordNumber: row.record_number,
    status: row.status,
    admittedByUserId: Number(row.admitted_by),
    admittedBy: row.admitted_by_name,
    admittedAt: new Date(row.admitted_at).toISOString(),
    dischargedByUserId: row.discharged_by === null ? null : Number(row.discharged_by),
    dischargedBy: row.discharged_by_name,
    dischargedAt: row.discharged_at ? new Date(row.discharged_at).toISOString() : null,
    currentBed: row.current_bed_uuid ? {
      bedId: row.current_bed_uuid,
      bedCode: row.current_bed_code,
      wardId: row.current_ward_uuid,
      wardCode: row.current_ward_code,
      wardName: row.current_ward_name,
    } : null,
  };
}

function serializeAssignment(row: AssignmentRow) {
  return {
    assignmentId: row.assignment_uuid,
    admissionId: row.admission_uuid,
    bed: {
      bedId: row.bed_uuid,
      bedCode: row.bed_code,
      wardId: row.ward_uuid,
      wardCode: row.ward_code,
      wardName: row.ward_name,
    },
    assignedByUserId: Number(row.assigned_by),
    assignedBy: row.assigner_name,
    assignedAt: new Date(row.assigned_at).toISOString(),
    endedByUserId: row.ended_by === null ? null : Number(row.ended_by),
    endedBy: row.ender_name,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    endReason: row.end_reason,
  };
}

async function loadAssignment(
  connection: PoolConnection,
  assignmentUuid: string,
): Promise<AssignmentRow | null> {
  const [rows] = await connection.execute<AssignmentRow[]>(
    `SELECT ba.assignment_id, ba.assignment_uuid, ba.facility_id, ba.admission_id,
            a.admission_uuid, ba.bed_id, b.bed_uuid, b.bed_code, w.ward_uuid,
            w.ward_code, w.display_name AS ward_name, ba.assigned_by,
            assigner.display_name AS assigner_name, ba.assigned_at, ba.ended_by,
            ender.display_name AS ender_name, ba.ended_at, ba.end_reason
     FROM inpatient_bed_assignments ba
     JOIN inpatient_admissions a ON a.admission_id = ba.admission_id AND a.facility_id = ba.facility_id
     JOIN inpatient_beds b ON b.bed_id = ba.bed_id AND b.facility_id = ba.facility_id
     JOIN inpatient_wards w ON w.ward_id = b.ward_id AND w.facility_id = b.facility_id
     JOIN users assigner ON assigner.user_id = ba.assigned_by
     LEFT JOIN users ender ON ender.user_id = ba.ended_by
     WHERE ba.assignment_uuid = ?
     LIMIT 1`,
    [assignmentUuid],
  );
  return rows[0] ?? null;
}

export const inpatientRouter = Router();
inpatientRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
inpatientRouter.use(requireSession);

inpatientRouter.get(
  "/facilities/:facilityId/locations",
  requirePermission("inpatient.catalog.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedFacility = inpatientFacilityIdSchema.safeParse(req.params.facilityId);
    if (!parsedFacility.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid facility identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    try {
      if (!await checkFacilityAccess(req, res, parsedFacility.data)) return;
      if (!await inpatientEnabled(req, parsedFacility.data, res)) return;
      const [rows] = await pool.execute<BedRow[]>(
        `SELECT b.bed_id, b.bed_uuid, b.bed_code, w.ward_id, w.ward_uuid,
                w.ward_code, w.display_name AS ward_name
         FROM inpatient_beds b
         JOIN inpatient_wards w ON w.ward_id = b.ward_id AND w.facility_id = b.facility_id
         WHERE b.facility_id = ? AND b.status = 'active' AND w.status = 'active'
         ORDER BY w.ward_code, b.bed_code
         LIMIT 1000`,
        [parsedFacility.data],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "inpatient.catalog.read",
        resourceType: "facility",
        resourceId: String(parsedFacility.data),
        outcome: "allowed",
        ipAddress: req.ip,
      });
      const wards = new Map<string, {
        wardId: string;
        wardCode: string;
        wardName: string;
        beds: { bedId: string; bedCode: string }[];
      }>();
      for (const row of rows) {
        let ward = wards.get(row.ward_uuid);
        if (!ward) {
          ward = {
            wardId: row.ward_uuid,
            wardCode: row.ward_code,
            wardName: row.ward_name,
            beds: [],
          };
          wards.set(row.ward_uuid, ward);
        }
        ward.beds.push({ bedId: row.bed_uuid, bedCode: row.bed_code });
      }
      res.json({ wards: [...wards.values()], truncated: rows.length === 1000 });
    } catch (error) {
      next(error);
    }
  },
);

inpatientRouter.get(
  "/encounters/:encounterId/admissions",
  requirePermission("inpatient.admission.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedEncounter = inpatientEncounterUuidSchema.safeParse(req.params.encounterId);
    if (!parsedEncounter.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    try {
      const [encounters] = await pool.execute<EncounterRow[]>(
        `SELECT e.encounter_id, e.encounter_uuid, e.facility_id, e.status, p.record_number
         FROM encounters e
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         WHERE e.encounter_uuid = ? AND p.status = 'active'
         LIMIT 1`,
        [parsedEncounter.data],
      );
      const encounter = encounters[0];
      if (!encounter) {
        respondError(res, 404, "ENCOUNTER_NOT_FOUND", "The active encounter was not found.");
        return;
      }
      if (!await checkFacilityAccess(req, res, Number(encounter.facility_id))) return;
      if (!await inpatientEnabled(req, Number(encounter.facility_id), res)) return;
      const [rows] = await pool.execute<AdmissionRow[]>(
        `SELECT a.admission_id, a.admission_uuid, a.facility_id, a.encounter_id,
                e.encounter_uuid, p.record_number, a.status, a.admitted_by,
                adm.display_name AS admitted_by_name, a.admitted_at, a.discharged_by,
                dis.display_name AS discharged_by_name, a.discharged_at,
                a.discharge_idempotency_key, b.bed_uuid AS current_bed_uuid,
                b.bed_code AS current_bed_code, w.ward_uuid AS current_ward_uuid,
                w.ward_code AS current_ward_code, w.display_name AS current_ward_name
         FROM inpatient_admissions a
         JOIN encounters e ON e.encounter_id = a.encounter_id AND e.facility_id = a.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users adm ON adm.user_id = a.admitted_by
         LEFT JOIN users dis ON dis.user_id = a.discharged_by
         LEFT JOIN inpatient_bed_assignments ba
           ON ba.facility_id = a.facility_id AND ba.admission_id = a.admission_id AND ba.ended_at IS NULL
         LEFT JOIN inpatient_beds b ON b.facility_id = ba.facility_id AND b.bed_id = ba.bed_id
         LEFT JOIN inpatient_wards w ON w.facility_id = b.facility_id AND w.ward_id = b.ward_id
         WHERE a.facility_id = ? AND a.encounter_id = ?
         ORDER BY a.admitted_at DESC, a.admission_id DESC
         LIMIT 100`,
        [encounter.facility_id, encounter.encounter_id],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "inpatient.admission.read",
        resourceType: "encounter",
        resourceId: parsedEncounter.data,
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({ admissions: rows.map(serializeAdmission), truncated: rows.length === 100 });
    } catch (error) {
      next(error);
    }
  },
);

inpatientRouter.post(
  "/encounters/:encounterId/admissions",
  requirePermission("inpatient.admission.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedEncounter = inpatientEncounterUuidSchema.safeParse(req.params.encounterId);
    const parsedBody = inpatientAdmissionSchema.safeParse(req.body);
    const idempotencyKey = inpatientIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!parsedEncounter.success || !parsedBody.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter and Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const encounter = await loadEncounter(req, res, parsedEncounter.data, connection);
      if (!encounter) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      if (!await inpatientEnabled(req, Number(encounter.facility_id), res, connection, true)) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      const [existingRows] = await connection.execute<AdmissionRow[]>(
        `SELECT a.admission_id, a.admission_uuid, a.facility_id, a.encounter_id,
                e.encounter_uuid, p.record_number, a.status, a.admitted_by,
                adm.display_name AS admitted_by_name, a.admitted_at, a.discharged_by,
                dis.display_name AS discharged_by_name, a.discharged_at,
                a.discharge_idempotency_key, NULL AS current_bed_uuid,
                NULL AS current_bed_code, NULL AS current_ward_uuid,
                NULL AS current_ward_code, NULL AS current_ward_name
         FROM inpatient_admissions a
         JOIN encounters e ON e.encounter_id = a.encounter_id AND e.facility_id = a.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users adm ON adm.user_id = a.admitted_by
         LEFT JOIN users dis ON dis.user_id = a.discharged_by
         WHERE a.facility_id = ? AND a.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [encounter.facility_id, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        const matches = Number(existing.encounter_id) === Number(encounter.encounter_id) &&
          Number(existing.admitted_by) === principal.userId;
        const existingAdmission = matches
          ? await loadAdmission(connection, existing.admission_uuid, true)
          : null;
        await connection.rollback();
        transactionStarted = false;
        if (!matches) {
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for another admission.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "inpatient.admission.idempotent_replay",
          resourceType: "inpatient_admission",
          resourceId: existing.admission_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        });
        if (!existingAdmission) {
          respondError(res, 404, "ADMISSION_NOT_FOUND", "The previously created admission is no longer available.");
          return;
        }
        res.json({ admission: serializeAdmission(existingAdmission), idempotentReplay: true });
        return;
      }
      if (encounter.status !== "open") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "ENCOUNTER_NOT_OPEN", "An admission can only be created from an open encounter.");
        return;
      }
      const admissionUuid = randomUUID();
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO inpatient_admissions
          (admission_uuid, facility_id, encounter_id, idempotency_key, status,
           admitted_by, admitted_at, discharged_by, discharged_at, discharge_idempotency_key)
         VALUES (?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(6), NULL, NULL, NULL)`,
        [admissionUuid, encounter.facility_id, encounter.encounter_id, idempotencyKey.data, principal.userId],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "inpatient.admission.create",
        resourceType: "inpatient_admission",
        resourceId: String(result.insertId),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const admission = await loadAdmission(connection, admissionUuid);
      if (!admission) throw new Error("The newly created admission could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ admission: serializeAdmission(admission), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (isDuplicateKeyError(error)) {
        respondError(res, 409, "ACTIVE_ADMISSION_EXISTS", "An active admission or matching request already exists; reload the encounter.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);

inpatientRouter.post(
  "/admissions/:admissionId/bed-assignments",
  requirePermission("inpatient.bed.assign"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedAdmission = inpatientAdmissionUuidSchema.safeParse(req.params.admissionId);
    const parsedBody = inpatientBedAssignmentSchema.safeParse(req.body);
    const idempotencyKey = inpatientIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!parsedAdmission.success || !parsedBody.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid admission, bed, and Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const admission = await loadAdmission(connection, parsedAdmission.data, true);
      if (!admission) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "ADMISSION_NOT_FOUND", "The inpatient admission was not found.");
        return;
      }
      if (!await checkFacilityAccess(req, res, Number(admission.facility_id), connection)) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      if (!await inpatientEnabled(req, Number(admission.facility_id), res, connection, true)) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      const [existingRows] = await connection.execute<AssignmentRow[]>(
        `SELECT ba.assignment_id, ba.assignment_uuid, ba.facility_id, ba.admission_id,
                a.admission_uuid, ba.bed_id, b.bed_uuid, b.bed_code, w.ward_uuid,
                w.ward_code, w.display_name AS ward_name, ba.assigned_by,
                assigner.display_name AS assigner_name, ba.assigned_at, ba.ended_by,
                ender.display_name AS ender_name, ba.ended_at, ba.end_reason
         FROM inpatient_bed_assignments ba
         JOIN inpatient_admissions a ON a.admission_id = ba.admission_id AND a.facility_id = ba.facility_id
         JOIN inpatient_beds b ON b.bed_id = ba.bed_id AND b.facility_id = ba.facility_id
         JOIN inpatient_wards w ON w.ward_id = b.ward_id AND w.facility_id = b.facility_id
         JOIN users assigner ON assigner.user_id = ba.assigned_by
         LEFT JOIN users ender ON ender.user_id = ba.ended_by
         WHERE ba.facility_id = ? AND ba.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [admission.facility_id, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        const matches = existing.admission_uuid === admission.admission_uuid &&
          existing.bed_uuid === parsedBody.data.bedId &&
          Number(existing.assigned_by) === principal.userId;
        await connection.rollback();
        transactionStarted = false;
        if (!matches) {
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different bed assignment.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "inpatient.bed_assignment.idempotent_replay",
          resourceType: "inpatient_bed_assignment",
          resourceId: existing.assignment_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        });
        res.json({ assignment: serializeAssignment(existing), idempotentReplay: true });
        return;
      }
      if (admission.status !== "active") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "ADMISSION_NOT_ACTIVE", "A discharged admission cannot be assigned to a bed.");
        return;
      }
      const [bedRows] = await connection.execute<BedRow[]>(
        `SELECT b.bed_id, b.bed_uuid, b.bed_code, w.ward_id, w.ward_uuid,
                w.ward_code, w.display_name AS ward_name
         FROM inpatient_beds b
         JOIN inpatient_wards w ON w.ward_id = b.ward_id AND w.facility_id = b.facility_id
         WHERE b.facility_id = ? AND b.bed_uuid = ?
           AND b.status = 'active' AND w.status = 'active'
         LIMIT 1 FOR UPDATE`,
        [admission.facility_id, parsedBody.data.bedId],
      );
      const bed = bedRows[0];
      if (!bed) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "ACTIVE_BED_NOT_FOUND", "The approved active bed was not found.");
        return;
      }
      const [occupancyRows] = await connection.execute<RowDataPacket[]>(
        `SELECT admission_id FROM inpatient_bed_assignments
         WHERE facility_id = ? AND bed_id = ? AND ended_at IS NULL
         LIMIT 1 FOR UPDATE`,
        [admission.facility_id, bed.bed_id],
      );
      if (occupancyRows[0] && Number(occupancyRows[0].admission_id) !== Number(admission.admission_id)) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "BED_UNAVAILABLE", "The selected bed already has an active assignment.");
        return;
      }
      if (admission.current_bed_uuid === bed.bed_uuid) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "BED_ALREADY_ASSIGNED", "This admission is already assigned to the selected bed.");
        return;
      }
      const transferring = admission.current_bed_uuid !== null;
      if (transferring) {
        await connection.execute(
          `UPDATE inpatient_bed_assignments
           SET ended_by = ?, ended_at = UTC_TIMESTAMP(6), end_reason = 'transferred'
           WHERE facility_id = ? AND admission_id = ? AND ended_at IS NULL`,
          [principal.userId, admission.facility_id, admission.admission_id],
        );
      }
      const assignmentUuid = randomUUID();
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO inpatient_bed_assignments
          (assignment_uuid, facility_id, admission_id, bed_id, idempotency_key,
           assigned_by, assigned_at, ended_by, ended_at, end_reason)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), NULL, NULL, NULL)`,
        [
          assignmentUuid, admission.facility_id, admission.admission_id, bed.bed_id,
          idempotencyKey.data, principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: transferring ? "inpatient.bed.transfer" : "inpatient.bed.assign",
        resourceType: "inpatient_bed_assignment",
        resourceId: String(result.insertId),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const assignment = await loadAssignment(connection, assignmentUuid);
      if (!assignment) throw new Error("The new bed assignment could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ assignment: serializeAssignment(assignment), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (isDuplicateKeyError(error)) {
        respondError(res, 409, "BED_ASSIGNMENT_CONFLICT", "The bed or admission has an active assignment; reload the current inpatient state.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);

inpatientRouter.post(
  "/admissions/:admissionId/discharge",
  requirePermission("inpatient.admission.discharge"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedAdmission = inpatientAdmissionUuidSchema.safeParse(req.params.admissionId);
    const parsedBody = inpatientDischargeSchema.safeParse(req.body);
    const idempotencyKey = inpatientIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!parsedAdmission.success || !parsedBody.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid admission and Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const admission = await loadAdmission(connection, parsedAdmission.data, true);
      if (!admission) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "ADMISSION_NOT_FOUND", "The inpatient admission was not found.");
        return;
      }
      if (!await checkFacilityAccess(req, res, Number(admission.facility_id), connection)) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      if (!await inpatientEnabled(req, Number(admission.facility_id), res, connection, true)) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      if (admission.status === "discharged") {
        const replay = admission.discharge_idempotency_key === idempotencyKey.data &&
          Number(admission.discharged_by) === principal.userId;
        await connection.rollback();
        transactionStarted = false;
        if (!replay) {
          respondError(res, 409, "ADMISSION_ALREADY_DISCHARGED", "This admission has already been discharged.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "inpatient.admission.discharge.idempotent_replay",
          resourceType: "inpatient_admission",
          resourceId: admission.admission_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        });
        res.json({ admission: serializeAdmission(admission), idempotentReplay: true });
        return;
      }
      const [assignmentRows] = await connection.execute<RowDataPacket[]>(
        `SELECT assignment_id FROM inpatient_bed_assignments
         WHERE facility_id = ? AND admission_id = ? AND ended_at IS NULL
         LIMIT 1 FOR UPDATE`,
        [admission.facility_id, admission.admission_id],
      );
      if (assignmentRows[0]) {
        await connection.execute(
          `UPDATE inpatient_bed_assignments
           SET ended_by = ?, ended_at = UTC_TIMESTAMP(6), end_reason = 'discharged'
           WHERE assignment_id = ? AND ended_at IS NULL`,
          [principal.userId, assignmentRows[0].assignment_id],
        );
      }
      await connection.execute(
        `UPDATE inpatient_admissions
         SET status = 'discharged', discharged_by = ?, discharged_at = UTC_TIMESTAMP(6),
             discharge_idempotency_key = ?
         WHERE admission_id = ? AND facility_id = ? AND status = 'active'`,
        [principal.userId, idempotencyKey.data, admission.admission_id, admission.facility_id],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "inpatient.admission.discharge",
        resourceType: "inpatient_admission",
        resourceId: admission.admission_uuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const discharged = await loadAdmission(connection, admission.admission_uuid);
      if (!discharged) throw new Error("The discharged admission could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.json({ admission: serializeAdmission(discharged), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (isDuplicateKeyError(error)) {
        respondError(res, 409, "DISCHARGE_KEY_REUSED", "This discharge request key is already in use.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);
