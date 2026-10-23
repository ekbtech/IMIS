import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessDepartment, canAccessFacility } from "../security/access-control.js";
import { decryptData, encryptData, isDataEncryptionConfigured } from "../security/data-encryption.js";
import { writeAuditEvent } from "../security/audit.js";
import {
  appointmentFacilityIdSchema,
  appointmentIdempotencyKeySchema,
  appointmentIdSchema,
  appointmentRequestSchema,
  appointmentTransitionSchema,
  eatDateTimeToUtc,
} from "../validation/appointments.js";

type AppointmentStatus = "requested" | "confirmed" | "declined" | "cancelled";

interface AppointmentRow extends RowDataPacket {
  appointment_id: number;
  appointment_uuid: string;
  facility_id: number;
  patient_id: number;
  record_number: string;
  department_id: number;
  department_name: string;
  idempotency_key: string;
  requested_at: Date;
  reason_ciphertext: Buffer;
  status: AppointmentStatus;
  requested_by: number;
  requester_name: string;
  created_at: Date;
  responded_by: number | null;
  responder_name: string | null;
  responded_at: Date | null;
}

interface AppointmentEventRow extends RowDataPacket {
  appointment_id: number;
  event_type: AppointmentStatus;
  previous_status: AppointmentStatus | null;
  new_status: AppointmentStatus;
  note_ciphertext: Buffer | null;
  actor_name: string;
  occurred_at: Date;
}

const appointmentSelect = `SELECT a.appointment_id, a.appointment_uuid, a.facility_id,
  a.patient_id, p.record_number, a.department_id, d.name AS department_name,
  a.idempotency_key, a.requested_at, a.reason_ciphertext, a.status,
  a.requested_by, requester.display_name AS requester_name, a.created_at,
  a.responded_by, responder.display_name AS responder_name, a.responded_at
  FROM appointments a
  JOIN patients p ON p.patient_id = a.patient_id AND p.facility_id = a.facility_id
  JOIN departments d ON d.department_id = a.department_id AND d.facility_id = a.facility_id
  JOIN users requester ON requester.user_id = a.requested_by
  LEFT JOIN users responder ON responder.user_id = a.responded_by`;

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function serializeAppointment(row: AppointmentRow) {
  return {
    appointmentId: row.appointment_uuid,
    patientId: Number(row.patient_id),
    recordNumber: row.record_number,
    departmentId: Number(row.department_id),
    department: row.department_name,
    requestedAt: new Date(row.requested_at).toISOString(),
    reason: decryptData(row.reason_ciphertext),
    status: row.status,
    requestedBy: row.requester_name,
    createdAt: new Date(row.created_at).toISOString(),
    respondedBy: row.responder_name,
    respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
    canCancel: false,
  };
}

async function departmentIsAssigned(
  req: Request,
  res: Response,
  facilityId: number,
  departmentId: number,
): Promise<boolean> {
  const principal = req.principal;
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return false;
  }
  if (canAccessDepartment(principal, facilityId, departmentId)) return true;
  await writeAuditEvent({
    actorUserId: principal.userId,
    action: "appointment.department_access",
    resourceType: "department",
    resourceId: String(departmentId),
    outcome: "denied",
    ipAddress: req.ip,
  });
  respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "You are not assigned to this appointment department.");
  return false;
}

export const appointmentsRouter = Router();
appointmentsRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
appointmentsRouter.use(requireSession);

appointmentsRouter.get(
  "/facilities/:facilityId/departments",
  requirePermission("appointment.request.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const facilityId = appointmentFacilityIdSchema.safeParse(req.params.facilityId);
    if (!facilityId.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid facility identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!canAccessFacility(principal, facilityId.data)) {
      respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
      return;
    }
    try {
      const [departments] = await pool.execute<RowDataPacket[]>(
        `SELECT d.department_id, d.name
         FROM departments d
         JOIN user_departments ud
           ON ud.facility_id = d.facility_id AND ud.department_id = d.department_id
         WHERE d.facility_id = ? AND d.status = 'active' AND ud.user_id = ?
         ORDER BY d.name LIMIT 100`,
        [facilityId.data, principal.userId],
      );
      res.json({ departments });
    } catch (error) {
      next(error);
    }
  },
);

appointmentsRouter.get(
  "/facilities/:facilityId/requests",
  requirePermission("appointment.request.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const facilityId = appointmentFacilityIdSchema.safeParse(req.params.facilityId);
    if (!facilityId.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid facility identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!canAccessFacility(principal, facilityId.data)) {
      respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "APPOINTMENT_DATA_KEY_REQUIRED", "Appointment encryption is not configured.");
      return;
    }
    try {
      const [rows] = await pool.execute<AppointmentRow[]>(
        `${appointmentSelect}
         JOIN user_departments ud ON ud.facility_id = a.facility_id
           AND ud.department_id = a.department_id AND ud.user_id = ?
         WHERE a.facility_id = ?
         ORDER BY (a.status = 'requested') DESC, a.requested_at ASC, a.appointment_id ASC LIMIT 101`,
        [principal.userId, facilityId.data],
      );
      const appointmentIds = rows.slice(0, 100).map((row) => Number(row.appointment_id));
      let events: AppointmentEventRow[] = [];
      if (appointmentIds.length > 0) {
        const placeholders = appointmentIds.map(() => "?").join(", ");
        const [eventRows] = await pool.execute<AppointmentEventRow[]>(
          `SELECT e.event_type, e.previous_status, e.new_status, e.note_ciphertext,
                  u.display_name AS actor_name, e.occurred_at, e.appointment_id
           FROM appointment_events e
           JOIN users u ON u.user_id = e.actor_user_id
           WHERE e.facility_id = ? AND e.appointment_id IN (${placeholders})
           ORDER BY e.occurred_at, e.appointment_event_id`,
          [facilityId.data, ...appointmentIds],
        );
        events = eventRows;
      }
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "appointment.request.list",
        resourceType: "facility",
        resourceId: String(facilityId.data),
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({
        appointments: rows.slice(0, 100).map((row) => ({
          ...serializeAppointment(row),
          canCancel: Number(row.requested_by) === principal.userId,
          events: events
            .filter((event) => Number(event.appointment_id) === Number(row.appointment_id))
            .map((event) => ({
              type: event.event_type,
              previousStatus: event.previous_status,
              status: event.new_status,
              note: event.note_ciphertext ? decryptData(event.note_ciphertext) : null,
              actor: event.actor_name,
              occurredAt: new Date(event.occurred_at).toISOString(),
            })),
        })),
        truncated: rows.length > 100,
      });
    } catch (error) {
      next(error);
    }
  },
);

appointmentsRouter.post(
  "/facilities/:facilityId/requests",
  requirePermission("appointment.request.create"),
  requirePermission("patient.mpi.search"),
  async (req, res, next) => {
    const principal = req.principal;
    const facilityId = appointmentFacilityIdSchema.safeParse(req.params.facilityId);
    const input = appointmentRequestSchema.safeParse(req.body);
    const idempotencyKey = appointmentIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!facilityId.success || !input.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid facility, patient, department, future EAT date/time, reason, and Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!canAccessFacility(principal, facilityId.data)) {
      respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
      return;
    }
    if (!await departmentIsAssigned(req, res, facilityId.data, input.data.departmentId)) return;
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "APPOINTMENT_DATA_KEY_REQUIRED", "Appointment encryption is not configured.");
      return;
    }

    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [patients] = await connection.execute<RowDataPacket[]>(
        `SELECT patient_id FROM patients
         WHERE patient_id = ? AND facility_id = ? AND status = 'active'
         LIMIT 1 FOR UPDATE`,
        [input.data.patientId, facilityId.data],
      );
      if (!patients[0]) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "PATIENT_NOT_FOUND", "No active patient record was found at this facility.");
        return;
      }
      const [departments] = await connection.execute<RowDataPacket[]>(
        `SELECT department_id FROM departments
         WHERE facility_id = ? AND department_id = ? AND status = 'active'
         LIMIT 1 FOR UPDATE`,
        [facilityId.data, input.data.departmentId],
      );
      if (!departments[0]) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "DEPARTMENT_NOT_FOUND", "The selected department is not active at this facility.");
        return;
      }
      const [existingRows] = await connection.execute<AppointmentRow[]>(
        `${appointmentSelect}
         WHERE a.facility_id = ? AND a.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [facilityId.data, idempotencyKey.data],
      );
      const existing = existingRows[0];
      const requestedAt = eatDateTimeToUtc(input.data.requestedAt);
      if (existing) {
        const matches = Number(existing.patient_id) === input.data.patientId &&
          Number(existing.department_id) === input.data.departmentId &&
          Number(existing.requested_by) === principal.userId &&
          new Date(existing.requested_at).toISOString().slice(0, 19).replace("T", " ") === requestedAt &&
          decryptData(existing.reason_ciphertext) === input.data.reason;
        await connection.rollback();
        transactionStarted = false;
        if (!matches) {
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different appointment.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "appointment.request.idempotent_replay",
          resourceType: "appointment",
          resourceId: existing.appointment_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        });
        res.json({
          appointment: {
            ...serializeAppointment(existing),
            canCancel: existing.status === "requested" && Number(existing.requested_by) === principal.userId,
          },
          idempotentReplay: true,
        });
        return;
      }
      const appointmentUuid = randomUUID();
      const [inserted] = await connection.execute<ResultSetHeader>(
        `INSERT INTO appointments
          (appointment_uuid, facility_id, patient_id, department_id, idempotency_key,
           requested_at, reason_ciphertext, status, requested_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, UTC_TIMESTAMP(6))`,
        [
          appointmentUuid, facilityId.data, input.data.patientId, input.data.departmentId,
          idempotencyKey.data, requestedAt, encryptData(input.data.reason), principal.userId,
        ],
      );
      await connection.execute(
        `INSERT INTO appointment_events
          (facility_id, appointment_id, event_type, previous_status, new_status,
           actor_user_id, occurred_at)
         VALUES (?, ?, 'requested', NULL, 'requested', ?, UTC_TIMESTAMP(6))`,
        [facilityId.data, inserted.insertId, principal.userId],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "appointment.request.create",
        resourceType: "appointment",
        resourceId: appointmentUuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const [createdRows] = await connection.execute<AppointmentRow[]>(
        `${appointmentSelect} WHERE a.appointment_uuid = ? LIMIT 1`,
        [appointmentUuid],
      );
      if (!createdRows[0]) throw new Error("The appointment request could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({
        appointment: { ...serializeAppointment(createdRows[0]), canCancel: true },
        idempotentReplay: false,
      });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
        respondError(res, 409, "APPOINTMENT_CONFLICT", "This appointment request already exists; reload and retry.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);

appointmentsRouter.post(
  "/requests/:appointmentId/respond",
  requirePermission("appointment.request.confirm"),
  async (req, res, next) => {
    const principal = req.principal;
    const appointmentId = appointmentIdSchema.safeParse(req.params.appointmentId);
    const input = appointmentTransitionSchema.safeParse(req.body);
    if (!appointmentId.success || !input.success || input.data.action === "cancel") {
      respondError(res, 400, "INVALID_REQUEST", "Choose confirm or decline and provide valid response details.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "APPOINTMENT_DATA_KEY_REQUIRED", "Appointment encryption is not configured.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [rows] = await connection.execute<AppointmentRow[]>(
        `${appointmentSelect} WHERE a.appointment_uuid = ? LIMIT 1 FOR UPDATE`,
        [appointmentId.data],
      );
      const appointment = rows[0];
      if (!appointment || !canAccessFacility(principal, Number(appointment.facility_id))) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "APPOINTMENT_NOT_FOUND", "The appointment request was not found.");
        return;
      }
      if (!await departmentIsAssigned(req, res, Number(appointment.facility_id), Number(appointment.department_id))) {
        await connection.rollback();
        transactionStarted = false;
        return;
      }
      if (appointment.status !== "requested") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "APPOINTMENT_ALREADY_RESPONDED", "Only pending appointment requests can be confirmed or declined.");
        return;
      }
      if (input.data.action === "confirm" && new Date(appointment.requested_at).getTime() <= Date.now()) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "APPOINTMENT_TIME_PASSED", "This requested appointment time has passed; submit a new request instead.");
        return;
      }
      const status: AppointmentStatus = input.data.action === "confirm" ? "confirmed" : "declined";
      await connection.execute(
        `UPDATE appointments SET status = ?, responded_by = ?, responded_at = UTC_TIMESTAMP(6)
         WHERE appointment_id = ? AND facility_id = ?`,
        [status, principal.userId, appointment.appointment_id, appointment.facility_id],
      );
      await connection.execute(
        `INSERT INTO appointment_events
          (facility_id, appointment_id, event_type, previous_status, new_status,
           note_ciphertext, actor_user_id, occurred_at)
         VALUES (?, ?, ?, 'requested', ?, ?, ?, UTC_TIMESTAMP(6))`,
        [
          appointment.facility_id, appointment.appointment_id, status, status,
          input.data.note ? encryptData(input.data.note) : null, principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: `appointment.request.${input.data.action}`,
        resourceType: "appointment",
        resourceId: appointment.appointment_uuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const [updatedRows] = await connection.execute<AppointmentRow[]>(
        `${appointmentSelect} WHERE a.appointment_uuid = ? LIMIT 1`,
        [appointment.appointment_uuid],
      );
      if (!updatedRows[0]) throw new Error("The appointment response could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.json({ appointment: { ...serializeAppointment(updatedRows[0]), canCancel: false } });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      next(error);
    } finally {
      connection?.release();
    }
  },
);

appointmentsRouter.post(
  "/requests/:appointmentId/cancel",
  requirePermission("appointment.request.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const appointmentId = appointmentIdSchema.safeParse(req.params.appointmentId);
    if (!appointmentId.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid appointment identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "APPOINTMENT_DATA_KEY_REQUIRED", "Appointment encryption is not configured.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [rows] = await connection.execute<AppointmentRow[]>(
        `${appointmentSelect} WHERE a.appointment_uuid = ? LIMIT 1 FOR UPDATE`,
        [appointmentId.data],
      );
      const appointment = rows[0];
      if (!appointment || !canAccessFacility(principal, Number(appointment.facility_id)) ||
          Number(appointment.requested_by) !== principal.userId) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "APPOINTMENT_NOT_FOUND", "The appointment request was not found.");
        return;
      }
      if (appointment.status !== "requested") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "APPOINTMENT_ALREADY_RESPONDED", "Only pending appointment requests can be cancelled.");
        return;
      }
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : "";
      await connection.execute(
        `UPDATE appointments SET status = 'cancelled', responded_by = ?, responded_at = UTC_TIMESTAMP(6)
         WHERE appointment_id = ? AND facility_id = ?`,
        [principal.userId, appointment.appointment_id, appointment.facility_id],
      );
      await connection.execute(
        `INSERT INTO appointment_events
          (facility_id, appointment_id, event_type, previous_status, new_status,
           note_ciphertext, actor_user_id, occurred_at)
         VALUES (?, ?, 'cancelled', 'requested', 'cancelled', ?, ?, UTC_TIMESTAMP(6))`,
        [
          appointment.facility_id, appointment.appointment_id,
          note ? encryptData(note) : null, principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "appointment.request.cancel",
        resourceType: "appointment",
        resourceId: appointment.appointment_uuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const [updatedRows] = await connection.execute<AppointmentRow[]>(
        `${appointmentSelect} WHERE a.appointment_uuid = ? LIMIT 1`,
        [appointment.appointment_uuid],
      );
      if (!updatedRows[0]) throw new Error("The cancelled appointment request could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.json({ appointment: serializeAppointment(updatedRows[0]) });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      next(error);
    } finally {
      connection?.release();
    }
  },
);
