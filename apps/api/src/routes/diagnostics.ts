import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessFacility } from "../security/access-control.js";
import { writeAuditEvent } from "../security/audit.js";
import {
  diagnosticEncounterUuidSchema,
  diagnosticFacilityIdSchema,
  diagnosticIdempotencyKeySchema,
  diagnosticOrderSchema,
  diagnosticOrderUuidSchema,
} from "../validation/diagnostics.js";

interface EncounterRow extends RowDataPacket {
  encounter_id: number;
  encounter_uuid: string;
  facility_id: number;
  status: "open" | "closed" | "cancelled";
  record_number: string;
}

interface ServiceRow extends RowDataPacket {
  service_id: number;
  service_uuid: string;
  service_code: string;
  display_name: string;
  category_code: string;
}

interface OrderRow extends RowDataPacket {
  diagnostic_order_id: number;
  order_uuid: string;
  facility_id: number;
  encounter_id: number;
  encounter_uuid: string;
  record_number: string;
  service_id: number;
  service_uuid: string;
  service_code: string;
  display_name: string;
  category_code: string;
  status: "ordered" | "cancelled";
  requested_by: number;
  requester_name: string;
  requested_at: Date;
  cancelled_by: number | null;
  canceller_name: string | null;
  cancelled_at: Date | null;
}

interface FacilityRow extends RowDataPacket {
  facility_id: number;
}

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
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
      action: "diagnostics.facility_access",
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

async function diagnosticsEnabled(
  req: Request,
  facilityId: number,
  res: Response,
  executor: PoolConnection | typeof pool = pool,
  lock = false,
): Promise<boolean> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT enabled, workflow_approval_reference, approved_by, approved_at
     FROM diagnostic_module_settings
     WHERE facility_id = ?
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [facilityId],
  );
  const settings = rows[0];
  if (!settings || Number(settings.enabled) !== 1 || !settings.workflow_approval_reference ||
      !settings.approved_by || !settings.approved_at) {
    await writeAuditEvent({
      actorUserId: req.principal?.userId ?? null,
      action: "diagnostics.module.disabled",
      resourceType: "facility",
      resourceId: String(facilityId),
      outcome: "denied",
      ipAddress: req.ip,
    });
    respondError(res, 503, "DIAGNOSTICS_DISABLED", "Diagnostics are disabled until facility workflow approval and activation are recorded.");
    return false;
  }
  return true;
}

function serializeOrder(row: OrderRow) {
  return {
    orderId: row.order_uuid,
    encounterId: row.encounter_uuid,
    recordNumber: row.record_number,
    serviceId: row.service_uuid,
    serviceCode: row.service_code,
    serviceName: row.display_name,
    categoryCode: row.category_code,
    status: row.status,
    requestedByUserId: Number(row.requested_by),
    requestedBy: row.requester_name,
    requestedAt: new Date(row.requested_at).toISOString(),
    cancelledByUserId: row.cancelled_by === null ? null : Number(row.cancelled_by),
    cancelledBy: row.canceller_name,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
  };
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
      action: "diagnostics.facility_access",
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

export const diagnosticsRouter = Router();
diagnosticsRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
diagnosticsRouter.use(requireSession);

diagnosticsRouter.get(
  "/facilities/:facilityId/services",
  requirePermission("diagnostics.catalog.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedFacility = diagnosticFacilityIdSchema.safeParse(req.params.facilityId);
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
      if (!await diagnosticsEnabled(req, parsedFacility.data, res)) return;
      const [rows] = await pool.execute<ServiceRow[]>(
        `SELECT service_id, service_uuid, service_code, display_name, category_code
         FROM diagnostic_services
         WHERE facility_id = ? AND status = 'active'
         ORDER BY category_code, display_name, service_code
         LIMIT 500`,
        [parsedFacility.data],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "diagnostics.catalog.read",
        resourceType: "facility",
        resourceId: String(parsedFacility.data),
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({
        services: rows.map((row) => ({
          serviceId: row.service_uuid,
          serviceCode: row.service_code,
          displayName: row.display_name,
          categoryCode: row.category_code,
        })),
        truncated: rows.length === 500,
      });
    } catch (error) {
      next(error);
    }
  },
);

diagnosticsRouter.get(
  "/encounters/:encounterId/orders",
  requirePermission("diagnostics.order.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedEncounter = diagnosticEncounterUuidSchema.safeParse(req.params.encounterId);
    if (!parsedEncounter.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    try {
      const encounter = await loadEncounter(req, res, parsedEncounter.data);
      if (!encounter || !await diagnosticsEnabled(req, Number(encounter.facility_id), res)) return;
      const [rows] = await pool.execute<OrderRow[]>(
        `SELECT o.diagnostic_order_id, o.order_uuid, o.facility_id, o.encounter_id,
                e.encounter_uuid, p.record_number, o.service_id, s.service_uuid,
                s.service_code, s.display_name, s.category_code, o.status,
                o.requested_by, requester.display_name AS requester_name, o.requested_at,
                o.cancelled_by, canceller.display_name AS canceller_name, o.cancelled_at
         FROM diagnostic_orders o
         JOIN encounters e ON e.encounter_id = o.encounter_id AND e.facility_id = o.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN diagnostic_services s ON s.service_id = o.service_id AND s.facility_id = o.facility_id
         JOIN users requester ON requester.user_id = o.requested_by
         LEFT JOIN users canceller ON canceller.user_id = o.cancelled_by
         WHERE o.facility_id = ? AND o.encounter_id = ?
         ORDER BY o.requested_at DESC, o.diagnostic_order_id DESC
         LIMIT 100`,
        [encounter.facility_id, encounter.encounter_id],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "diagnostics.order.read",
        resourceType: "encounter",
        resourceId: parsedEncounter.data,
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({ orders: rows.map(serializeOrder), truncated: rows.length === 100 });
    } catch (error) {
      next(error);
    }
  },
);

diagnosticsRouter.post(
  "/encounters/:encounterId/orders",
  requirePermission("diagnostics.order.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedEncounter = diagnosticEncounterUuidSchema.safeParse(req.params.encounterId);
    const parsedOrder = diagnosticOrderSchema.safeParse(req.body);
    const idempotencyKey = diagnosticIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!parsedEncounter.success || !parsedOrder.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter, approved service, and Idempotency-Key UUID.");
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
      const encounter = await loadEncounter(req, res, parsedEncounter.data, connection, true);
      if (!encounter) {
        await connection.rollback();
        transactionStarted = false;
        return;
      }
      if (!await diagnosticsEnabled(req, Number(encounter.facility_id), res, connection, true)) {
        await connection.rollback();
        transactionStarted = false;
        return;
      }
      const [existingRows] = await connection.execute<OrderRow[]>(
        `SELECT o.diagnostic_order_id, o.order_uuid, o.facility_id, o.encounter_id,
                e.encounter_uuid, p.record_number, o.service_id, s.service_uuid,
                s.service_code, s.display_name, s.category_code, o.status,
                o.requested_by, requester.display_name AS requester_name, o.requested_at,
                o.cancelled_by, canceller.display_name AS canceller_name, o.cancelled_at
         FROM diagnostic_orders o
         JOIN encounters e ON e.encounter_id = o.encounter_id AND e.facility_id = o.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN diagnostic_services s ON s.service_id = o.service_id AND s.facility_id = o.facility_id
         JOIN users requester ON requester.user_id = o.requested_by
         LEFT JOIN users canceller ON canceller.user_id = o.cancelled_by
         WHERE o.facility_id = ? AND o.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [encounter.facility_id, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        const matches = Number(existing.encounter_id) === Number(encounter.encounter_id) &&
          existing.service_uuid === parsedOrder.data.serviceId &&
          Number(existing.requested_by) === principal.userId;
        await connection.rollback();
        transactionStarted = false;
        if (!matches) {
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different order.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "diagnostics.order.idempotent_replay",
          resourceType: "diagnostic_order",
          resourceId: existing.order_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        });
        res.json({ order: serializeOrder(existing), idempotentReplay: true });
        return;
      }
      if (encounter.status !== "open") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "ENCOUNTER_NOT_OPEN", "Diagnostic orders can only be created for an open encounter.");
        return;
      }
      const [serviceRows] = await connection.execute<ServiceRow[]>(
        `SELECT service_id, service_uuid, service_code, display_name, category_code
         FROM diagnostic_services
         WHERE facility_id = ? AND service_uuid = ? AND status = 'active'
         LIMIT 1 FOR UPDATE`,
        [encounter.facility_id, parsedOrder.data.serviceId],
      );
      const service = serviceRows[0];
      if (!service) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "DIAGNOSTIC_SERVICE_NOT_FOUND", "The approved diagnostic service was not found.");
        return;
      }
      const orderUuid = randomUUID();
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO diagnostic_orders
          (order_uuid, facility_id, encounter_id, service_id, idempotency_key,
           status, requested_by, requested_at, cancelled_by, cancelled_at)
         VALUES (?, ?, ?, ?, ?, 'ordered', ?, UTC_TIMESTAMP(6), NULL, NULL)`,
        [
          orderUuid, encounter.facility_id, encounter.encounter_id, service.service_id,
          idempotencyKey.data, principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "diagnostics.order.create",
        resourceType: "diagnostic_order",
        resourceId: String(result.insertId),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const [createdRows] = await connection.execute<OrderRow[]>(
        `SELECT o.diagnostic_order_id, o.order_uuid, o.facility_id, o.encounter_id,
                e.encounter_uuid, p.record_number, o.service_id, s.service_uuid,
                s.service_code, s.display_name, s.category_code, o.status,
                o.requested_by, requester.display_name AS requester_name, o.requested_at,
                o.cancelled_by, canceller.display_name AS canceller_name, o.cancelled_at
         FROM diagnostic_orders o
         JOIN encounters e ON e.encounter_id = o.encounter_id AND e.facility_id = o.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN diagnostic_services s ON s.service_id = o.service_id AND s.facility_id = o.facility_id
         JOIN users requester ON requester.user_id = o.requested_by
         LEFT JOIN users canceller ON canceller.user_id = o.cancelled_by
         WHERE o.order_uuid = ? AND o.facility_id = ?
         LIMIT 1`,
        [orderUuid, encounter.facility_id],
      );
      if (!createdRows[0]) throw new Error("The newly created diagnostic order could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ order: serializeOrder(createdRows[0]), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      next(error);
    } finally {
      connection?.release();
    }
  },
);

diagnosticsRouter.post(
  "/orders/:orderId/cancel",
  requirePermission("diagnostics.order.cancel"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedOrder = diagnosticOrderUuidSchema.safeParse(req.params.orderId);
    if (!parsedOrder.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid order identifier.");
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
      const [rows] = await connection.execute<OrderRow[]>(
        `SELECT o.diagnostic_order_id, o.order_uuid, o.facility_id, o.encounter_id,
                e.encounter_uuid, p.record_number, o.service_id, s.service_uuid,
                s.service_code, s.display_name, s.category_code, o.status,
                o.requested_by, requester.display_name AS requester_name, o.requested_at,
                o.cancelled_by, canceller.display_name AS canceller_name, o.cancelled_at
         FROM diagnostic_orders o
         JOIN encounters e ON e.encounter_id = o.encounter_id AND e.facility_id = o.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN diagnostic_services s ON s.service_id = o.service_id AND s.facility_id = o.facility_id
         JOIN users requester ON requester.user_id = o.requested_by
         LEFT JOIN users canceller ON canceller.user_id = o.cancelled_by
         WHERE o.order_uuid = ?
         LIMIT 1 FOR UPDATE`,
        [parsedOrder.data],
      );
      const order = rows[0];
      if (!order) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "DIAGNOSTIC_ORDER_NOT_FOUND", "The diagnostic order was not found.");
        return;
      }
      if (!canAccessFacility(principal, Number(order.facility_id))) {
        await connection.rollback();
        transactionStarted = false;
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "diagnostics.facility_access",
          resourceType: "diagnostic_order",
          resourceId: order.order_uuid,
          outcome: "denied",
          ipAddress: req.ip,
        });
        respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
        return;
      }
      const [facilityRows] = await connection.execute<FacilityRow[]>(
        "SELECT facility_id FROM facilities WHERE facility_id = ? AND status = 'active' LIMIT 1",
        [order.facility_id],
      );
      if (!facilityRows[0]) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "FACILITY_NOT_FOUND", "The requested facility is unavailable.");
        return;
      }
      if (!await diagnosticsEnabled(req, Number(order.facility_id), res, connection, true)) {
        await connection.rollback();
        transactionStarted = false;
        return;
      }
      if (order.status === "cancelled") {
        await connection.rollback();
        transactionStarted = false;
        res.json({ order: serializeOrder(order), idempotentReplay: true });
        return;
      }
      await connection.execute(
        `UPDATE diagnostic_orders
         SET status = 'cancelled', cancelled_by = ?, cancelled_at = UTC_TIMESTAMP(6)
         WHERE diagnostic_order_id = ? AND status = 'ordered'`,
        [principal.userId, order.diagnostic_order_id],
      );
      const [updatedRows] = await connection.execute<OrderRow[]>(
        `SELECT o.diagnostic_order_id, o.order_uuid, o.facility_id, o.encounter_id,
                e.encounter_uuid, p.record_number, o.service_id, s.service_uuid,
                s.service_code, s.display_name, s.category_code, o.status,
                o.requested_by, requester.display_name AS requester_name, o.requested_at,
                o.cancelled_by, canceller.display_name AS canceller_name, o.cancelled_at
         FROM diagnostic_orders o
         JOIN encounters e ON e.encounter_id = o.encounter_id AND e.facility_id = o.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN diagnostic_services s ON s.service_id = o.service_id AND s.facility_id = o.facility_id
         JOIN users requester ON requester.user_id = o.requested_by
         LEFT JOIN users canceller ON canceller.user_id = o.cancelled_by
         WHERE o.diagnostic_order_id = ? AND o.facility_id = ?
         LIMIT 1`,
        [order.diagnostic_order_id, order.facility_id],
      );
      const updatedOrder = updatedRows[0];
      if (!updatedOrder) throw new Error("The cancelled diagnostic order could not be read back.");
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "diagnostics.order.cancel",
        resourceType: "diagnostic_order",
        resourceId: order.order_uuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;
      res.json({ order: serializeOrder(updatedOrder), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      next(error);
    } finally {
      connection?.release();
    }
  },
);
