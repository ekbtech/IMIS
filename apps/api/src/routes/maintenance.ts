import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Response } from "express";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessDepartment, canAccessFacility } from "../security/access-control.js";
import { decryptData, encryptData, isDataEncryptionConfigured } from "../security/data-encryption.js";
import { writeAuditEvent } from "../security/audit.js";
import {
  maintenanceFacilityIdSchema,
  maintenanceIdempotencyKeySchema,
  maintenanceRequestIdSchema,
  maintenanceRequestSchema,
  maintenanceTransitionSchema,
} from "../validation/maintenance.js";

type MaintenanceStatus = "requested" | "acknowledged" | "in_progress" | "completed" | "cancelled";

interface DepartmentRow extends RowDataPacket {
  department_id: number;
  name?: string;
}

interface MaintenanceRequestRow extends RowDataPacket {
  maintenance_request_id: number;
  request_uuid: string;
  facility_id: number;
  biomedical_department_id: number;
  reporting_department_id: number;
  reporting_department: string;
  idempotency_key: string;
  asset_tag: string;
  location_ciphertext: Buffer;
  issue_ciphertext: Buffer;
  status: MaintenanceStatus;
  requested_by: number;
  requester_name: string;
  requested_at: Date;
  handled_by: number | null;
  handler_name: string | null;
  handled_at: Date | null;
}

interface MaintenanceEventRow extends RowDataPacket {
  request_uuid: string;
  event_type: string;
  previous_status: MaintenanceStatus | null;
  new_status: MaintenanceStatus;
  note_ciphertext: Buffer | null;
  actor_name: string;
  occurred_at: Date;
}

const requestSelect = `SELECT m.maintenance_request_id, m.request_uuid, m.facility_id,
  m.biomedical_department_id, m.reporting_department_id, d.name AS reporting_department,
  m.idempotency_key, m.asset_tag, m.location_ciphertext, m.issue_ciphertext, m.status,
  m.requested_by, requester.display_name AS requester_name, m.requested_at,
  m.handled_by, handler.display_name AS handler_name, m.handled_at
  FROM maintenance_requests m
  JOIN departments d ON d.facility_id = m.facility_id
    AND d.department_id = m.reporting_department_id
  JOIN users requester ON requester.user_id = m.requested_by
  LEFT JOIN users handler ON handler.user_id = m.handled_by`;

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function serializeRequest(row: MaintenanceRequestRow) {
  return {
    requestId: row.request_uuid,
    reportingDepartmentId: Number(row.reporting_department_id),
    reportingDepartment: row.reporting_department,
    assetTag: row.asset_tag,
    location: decryptData(row.location_ciphertext),
    issue: decryptData(row.issue_ciphertext),
    status: row.status,
    requestedBy: row.requester_name,
    requestedAt: new Date(row.requested_at).toISOString(),
    handledBy: row.handler_name,
    handledAt: row.handled_at ? new Date(row.handled_at).toISOString() : null,
  };
}

async function getBiomedicalDepartment(facilityId: number): Promise<DepartmentRow | undefined> {
  const [departments] = await pool.execute<DepartmentRow[]>(
    `SELECT department_id, name FROM departments
     WHERE facility_id = ? AND department_code = 'BIOMEDICAL'
       AND department_group = 'system_tools' AND status = 'active' LIMIT 1`,
    [facilityId],
  );
  return departments[0];
}

export const maintenanceRouter = Router();
maintenanceRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
maintenanceRouter.use(requireSession);

maintenanceRouter.get(
  "/facilities/:facilityId/departments",
  requirePermission("maintenance.request.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const facilityId = maintenanceFacilityIdSchema.safeParse(req.params.facilityId);
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
      const [departments] = await pool.execute<DepartmentRow[]>(
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

maintenanceRouter.get(
  "/facilities/:facilityId/requests",
  requirePermission("maintenance.request.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const facilityId = maintenanceFacilityIdSchema.safeParse(req.params.facilityId);
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
      respondError(res, 503, "MAINTENANCE_DATA_KEY_REQUIRED", "Maintenance request encryption is not configured.");
      return;
    }
    try {
      const biomedical = await getBiomedicalDepartment(facilityId.data);
      const biomedicalAccess = Boolean(
        biomedical && canAccessDepartment(principal, facilityId.data, biomedical.department_id),
      );
      const [rows] = await pool.execute<MaintenanceRequestRow[]>(
        `${requestSelect}
         WHERE m.facility_id = ?
           AND (? = 1 OR EXISTS (
             SELECT 1 FROM user_departments ud
             WHERE ud.user_id = ? AND ud.facility_id = m.facility_id
               AND ud.department_id = m.reporting_department_id
           ))
         ORDER BY (m.status = 'requested') DESC, m.requested_at DESC,
           m.maintenance_request_id DESC LIMIT 101`,
        [facilityId.data, biomedicalAccess ? 1 : 0, principal.userId],
      );
      const requests = rows.slice(0, 100);
      let events: MaintenanceEventRow[] = [];
      if (requests.length > 0) {
        const placeholders = requests.map(() => "?").join(", ");
        const [eventRows] = await pool.execute<MaintenanceEventRow[]>(
          `SELECT m.request_uuid, e.event_type, e.previous_status, e.new_status,
                  e.note_ciphertext, u.display_name AS actor_name, e.occurred_at
           FROM maintenance_request_events e
           JOIN maintenance_requests m ON m.facility_id = e.facility_id
             AND m.maintenance_request_id = e.maintenance_request_id
           JOIN users u ON u.user_id = e.actor_user_id
           WHERE e.facility_id = ? AND m.request_uuid IN (${placeholders})
           ORDER BY e.occurred_at, e.maintenance_event_id`,
          [facilityId.data, ...requests.map((row) => row.request_uuid)],
        );
        events = eventRows;
      }
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "maintenance.request.list",
        resourceType: "facility",
        resourceId: String(facilityId.data),
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({
        requests: requests.map((row) => ({
          ...serializeRequest(row),
          canCancel: row.status === "requested" && Number(row.requested_by) === principal.userId,
          events: events.filter((event) => event.request_uuid === row.request_uuid).map((event) => ({
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

maintenanceRouter.post(
  "/facilities/:facilityId/requests",
  requirePermission("maintenance.request.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const facilityId = maintenanceFacilityIdSchema.safeParse(req.params.facilityId);
    const input = maintenanceRequestSchema.safeParse(req.body);
    const idempotencyKey = maintenanceIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!facilityId.success || !input.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide an active reporting department, equipment tag, location, issue description, and Idempotency-Key UUID.");
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
    if (!canAccessDepartment(principal, facilityId.data, input.data.reportingDepartmentId)) {
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "maintenance.request.create",
        resourceType: "department",
        resourceId: String(input.data.reportingDepartmentId),
        outcome: "denied",
        ipAddress: req.ip,
      });
      respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "You are not assigned to the reporting department.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "MAINTENANCE_DATA_KEY_REQUIRED", "Maintenance request encryption is not configured.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [biomedicalDepartments] = await connection.execute<DepartmentRow[]>(
        `SELECT department_id, name FROM departments
         WHERE facility_id = ? AND department_code = 'BIOMEDICAL'
           AND department_group = 'system_tools' AND status = 'active'
         LIMIT 1 FOR UPDATE`,
        [facilityId.data],
      );
      const biomedical = biomedicalDepartments[0];
      if (!biomedical) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "BIOMEDICAL_DEPARTMENT_UNAVAILABLE", "An active Biomedical Engineering department is not configured for this facility.");
        return;
      }
      const [departments] = await connection.execute<DepartmentRow[]>(
        `SELECT department_id FROM departments
         WHERE facility_id = ? AND department_id = ? AND status = 'active' LIMIT 1 FOR UPDATE`,
        [facilityId.data, input.data.reportingDepartmentId],
      );
      if (!departments[0]) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "DEPARTMENT_NOT_FOUND", "The reporting department is not active at this facility.");
        return;
      }
      const [existingRows] = await connection.execute<MaintenanceRequestRow[]>(
        `${requestSelect}
         WHERE m.facility_id = ? AND m.idempotency_key = ? LIMIT 1 FOR UPDATE`,
        [facilityId.data, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        const matches = Number(existing.reporting_department_id) === input.data.reportingDepartmentId &&
          Number(existing.requested_by) === principal.userId &&
          existing.asset_tag === input.data.assetTag &&
          decryptData(existing.location_ciphertext) === input.data.location &&
          decryptData(existing.issue_ciphertext) === input.data.issue;
        await connection.rollback();
        transactionStarted = false;
        if (!matches) {
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for different maintenance details.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "maintenance.request.idempotent_replay",
          resourceType: "maintenance_request",
          resourceId: existing.request_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        });
        res.json({ request: serializeRequest(existing), idempotentReplay: true });
        return;
      }
      const requestUuid = randomUUID();
      const [inserted] = await connection.execute<ResultSetHeader>(
        `INSERT INTO maintenance_requests
          (request_uuid, facility_id, biomedical_department_id, reporting_department_id,
           idempotency_key, asset_tag, location_ciphertext, issue_ciphertext, status,
           requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, UTC_TIMESTAMP(6))`,
        [
          requestUuid, facilityId.data, biomedical.department_id, input.data.reportingDepartmentId,
          idempotencyKey.data, input.data.assetTag, encryptData(input.data.location),
          encryptData(input.data.issue), principal.userId,
        ],
      );
      await connection.execute(
        `INSERT INTO maintenance_request_events
          (facility_id, maintenance_request_id, event_type, previous_status, new_status,
           actor_user_id, occurred_at)
         VALUES (?, ?, 'requested', NULL, 'requested', ?, UTC_TIMESTAMP(6))`,
        [facilityId.data, inserted.insertId, principal.userId],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "maintenance.request.create",
        resourceType: "maintenance_request",
        resourceId: requestUuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const [createdRows] = await connection.execute<MaintenanceRequestRow[]>(
        `${requestSelect} WHERE m.request_uuid = ? LIMIT 1`,
        [requestUuid],
      );
      if (!createdRows[0]) throw new Error("The maintenance request could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ request: serializeRequest(createdRows[0]), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
        respondError(res, 409, "MAINTENANCE_REQUEST_CONFLICT", "This request already exists; reload and retry.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);

maintenanceRouter.post(
  "/requests/:requestId/respond",
  requirePermission("maintenance.request.manage"),
  async (req, res, next) => {
    const principal = req.principal;
    const requestId = maintenanceRequestIdSchema.safeParse(req.params.requestId);
    const input = maintenanceTransitionSchema.safeParse(req.body);
    if (!requestId.success || !input.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid request identifier, action, and optional note.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "MAINTENANCE_DATA_KEY_REQUIRED", "Maintenance request encryption is not configured.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [rows] = await connection.execute<MaintenanceRequestRow[]>(
        `${requestSelect} WHERE m.request_uuid = ? LIMIT 1 FOR UPDATE`,
        [requestId.data],
      );
      const request = rows[0];
      if (!request) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "MAINTENANCE_REQUEST_NOT_FOUND", "The maintenance request was not found.");
        return;
      }
      if (!canAccessFacility(principal, Number(request.facility_id))) {
        await connection.rollback();
        transactionStarted = false;
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "maintenance.request.respond",
          resourceType: "maintenance_request",
          resourceId: request.request_uuid,
          outcome: "denied",
          ipAddress: req.ip,
        });
        respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
        return;
      }
      const biomedicalAccess = canAccessDepartment(
        principal, Number(request.facility_id), Number(request.biomedical_department_id),
      );
      const reporterCancel = input.data.action === "cancel" &&
        Number(request.requested_by) === principal.userId &&
        request.status === "requested";
      if (!biomedicalAccess && !reporterCancel) {
        await connection.rollback();
        transactionStarted = false;
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "maintenance.request.respond",
          resourceType: "maintenance_request",
          resourceId: request.request_uuid,
          outcome: "denied",
          ipAddress: req.ip,
        });
        respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "Only Biomedical Engineering can manage this request; the requester may cancel an unacknowledged request.");
        return;
      }
      const transitions: Record<typeof input.data.action, { from: MaintenanceStatus[]; to: MaintenanceStatus; event: string }> = {
        acknowledge: { from: ["requested"], to: "acknowledged", event: "acknowledged" },
        start: { from: ["acknowledged"], to: "in_progress", event: "started" },
        complete: { from: ["in_progress"], to: "completed", event: "completed" },
        cancel: { from: ["requested", "acknowledged", "in_progress"], to: "cancelled", event: "cancelled" },
      };
      const transition = transitions[input.data.action];
      if (!transition.from.includes(request.status) || (input.data.action === "cancel" && !biomedicalAccess && !reporterCancel)) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "INVALID_MAINTENANCE_TRANSITION", "The request cannot be moved from its current status using that action.");
        return;
      }
      await connection.execute(
        `UPDATE maintenance_requests
         SET status = ?, handled_by = ?, handled_at = UTC_TIMESTAMP(6)
         WHERE facility_id = ? AND maintenance_request_id = ?`,
        [transition.to, principal.userId, request.facility_id, request.maintenance_request_id],
      );
      await connection.execute(
        `INSERT INTO maintenance_request_events
          (facility_id, maintenance_request_id, event_type, previous_status, new_status,
           note_ciphertext, actor_user_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [
          request.facility_id, request.maintenance_request_id, transition.event, request.status,
          transition.to, input.data.note ? encryptData(input.data.note) : null, principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: `maintenance.request.${transition.event}`,
        resourceType: "maintenance_request",
        resourceId: request.request_uuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;
      res.json({ requestId: request.request_uuid, status: transition.to });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      next(error);
    } finally {
      connection?.release();
    }
  },
);
