import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessDepartment, canAccessFacility, canUsePermission } from "../security/access-control.js";
import { writeAuditEvent } from "../security/audit.js";
import {
  inventoryDepartmentIdSchema,
  inventoryFacilityIdSchema,
  inventoryIdempotencyKeySchema,
  inventoryItemSchema,
  inventoryMovementSchema,
} from "../validation/inventory.js";

interface InventoryDepartmentRow extends RowDataPacket {
  department_id: number;
  name: string;
}

interface InventoryItemRow extends RowDataPacket {
  inventory_item_id: number;
  item_code: string;
  name: string;
  unit_of_measure: string;
  stock_lot_id: number | null;
  batch_code: string | null;
  expires_on: string | Date | null;
  quantity_on_hand: string | number | null;
}

interface InventoryLotRow extends RowDataPacket {
  stock_lot_id: number;
  batch_code: string;
  expires_on: string | Date | null;
  quantity_on_hand: string | number;
}

interface IdempotentMovementRow extends RowDataPacket {
  movement_uuid: string;
  movement_type: "receipt" | "issue";
  department_id: number;
  inventory_item_id: number;
  batch_code: string;
  stock_lot_id: number;
  quantity: string | number;
  reference: string;
  issue_to_department_id: number | null;
}

interface LocalDateRow extends RowDataPacket {
  today_eat: string | Date;
}

interface MovementRow extends RowDataPacket {
  movement_uuid: string;
  movement_type: "receipt" | "issue";
  quantity: string | number;
  reference: string;
  batch_code: string;
  item_code: string;
  item_name: string;
  unit_of_measure: string;
  destination_department: string | null;
  actor_name: string;
  occurred_at: Date;
}

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function departmentAccessAllowed(
  req: Request,
  facilityId: number,
  departmentId: number,
): boolean {
  const principal = req.principal;
  return Boolean(principal && (
    canUsePermission(principal, "security.role.manage") ||
    canAccessDepartment(principal, facilityId, departmentId)
  ));
}

async function requireInventoryDepartment(
  facilityId: number,
  departmentId: number,
): Promise<InventoryDepartmentRow | null> {
  const [rows] = await pool.execute<InventoryDepartmentRow[]>(
    `SELECT department_id, name FROM departments
     WHERE facility_id = ? AND department_id = ?
       AND department_group = 'inventory' AND status = 'active'
     LIMIT 1`,
    [facilityId, departmentId],
  );
  return rows[0] ?? null;
}

async function allowDepartment(
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
  if (!canAccessFacility(principal, facilityId)) {
    respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
    return false;
  }
  if (!departmentAccessAllowed(req, facilityId, departmentId)) {
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "inventory.department_access",
      resourceType: "department",
      resourceId: String(departmentId),
      outcome: "denied",
      ipAddress: req.ip,
    });
    respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "You are not assigned to this inventory department.");
    return false;
  }
  const department = await requireInventoryDepartment(facilityId, departmentId);
  if (!department) {
    respondError(res, 404, "INVENTORY_DEPARTMENT_NOT_FOUND", "An active inventory department was not found.");
    return false;
  }
  return true;
}

function serializeMovement(row: MovementRow) {
  return {
    movementId: row.movement_uuid,
    type: row.movement_type,
    quantity: Number(row.quantity),
    reference: row.reference,
    itemCode: row.item_code,
    itemName: row.item_name,
    unitOfMeasure: row.unit_of_measure,
    batchCode: row.batch_code,
    destinationDepartment: row.destination_department,
    actor: row.actor_name,
    occurredAt: new Date(row.occurred_at).toISOString(),
  };
}

export const inventoryRouter = Router();
inventoryRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
inventoryRouter.use(requireSession);

inventoryRouter.get(
  "/facilities/:facilityId/departments",
  requirePermission("inventory.stock.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const facilityId = inventoryFacilityIdSchema.safeParse(req.params.facilityId);
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
      const [departments] = await pool.execute<InventoryDepartmentRow[]>(
        `SELECT d.department_id, d.name
         FROM departments d
         LEFT JOIN user_departments ud ON ud.facility_id = d.facility_id
           AND ud.department_id = d.department_id AND ud.user_id = ?
         WHERE d.facility_id = ? AND d.department_group = 'inventory' AND d.status = 'active'
           AND (? = 1 OR ud.user_id IS NOT NULL)
         ORDER BY d.name LIMIT 100`,
        [principal.userId, facilityId.data, Number(canUsePermission(principal, "security.role.manage"))],
      );
      res.json({ departments });
    } catch (error) {
      next(error);
    }
  },
);

inventoryRouter.get(
  "/facilities/:facilityId/departments/:departmentId",
  requirePermission("inventory.stock.read"),
  async (req, res, next) => {
    const facilityId = inventoryFacilityIdSchema.safeParse(req.params.facilityId);
    const departmentId = inventoryDepartmentIdSchema.safeParse(req.params.departmentId);
    if (!facilityId.success || !departmentId.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide valid facility and inventory department identifiers.");
      return;
    }
    if (!await allowDepartment(req, res, facilityId.data, departmentId.data)) return;
    try {
      const [items] = await pool.execute<InventoryItemRow[]>(
        `SELECT i.inventory_item_id, i.item_code, i.name, i.unit_of_measure,
                l.stock_lot_id, l.batch_code, l.expires_on, l.quantity_on_hand
         FROM inventory_items i
         LEFT JOIN inventory_stock_lots l ON l.facility_id = i.facility_id
           AND l.inventory_item_id = i.inventory_item_id AND l.department_id = ?
         WHERE i.facility_id = ? AND i.status = 'active'
         ORDER BY i.name, l.expires_on, l.batch_code
         LIMIT 500`,
        [departmentId.data, facilityId.data],
      );
      const [movements] = await pool.execute<MovementRow[]>(
        `SELECT m.movement_uuid, m.movement_type, m.quantity, m.reference,
                l.batch_code, i.item_code, i.name AS item_name, i.unit_of_measure,
                destination.name AS destination_department, u.display_name AS actor_name, m.occurred_at
         FROM inventory_stock_movements m
         JOIN inventory_stock_lots l ON l.facility_id = m.facility_id
           AND l.department_id = m.department_id AND l.stock_lot_id = m.stock_lot_id
         JOIN inventory_items i ON i.facility_id = m.facility_id
           AND i.inventory_item_id = l.inventory_item_id
         LEFT JOIN departments destination ON destination.facility_id = m.facility_id
           AND destination.department_id = m.issue_to_department_id
         JOIN users u ON u.user_id = m.actor_user_id
         WHERE m.facility_id = ? AND m.department_id = ?
         ORDER BY m.occurred_at DESC, m.stock_movement_id DESC LIMIT 100`,
        [facilityId.data, departmentId.data],
      );
      await writeAuditEvent({
        actorUserId: req.principal!.userId,
        action: "inventory.stock.read",
        resourceType: "department",
        resourceId: String(departmentId.data),
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({
        items: items.map((item) => ({
          inventoryItemId: Number(item.inventory_item_id),
          itemCode: item.item_code,
          name: item.name,
          unitOfMeasure: item.unit_of_measure,
          lot: item.stock_lot_id === null ? null : {
            stockLotId: Number(item.stock_lot_id),
            batchCode: item.batch_code,
            expiresOn: item.expires_on === null ? null : new Date(item.expires_on).toISOString().slice(0, 10),
            quantityOnHand: Number(item.quantity_on_hand),
          },
        })),
        movements: movements.map(serializeMovement),
        truncated: movements.length === 100,
      });
    } catch (error) {
      next(error);
    }
  },
);

inventoryRouter.get(
  "/facilities/:facilityId/departments/:departmentId/issue-targets",
  requirePermission("inventory.stock.issue"),
  async (req, res, next) => {
    const facilityId = inventoryFacilityIdSchema.safeParse(req.params.facilityId);
    const departmentId = inventoryDepartmentIdSchema.safeParse(req.params.departmentId);
    if (!facilityId.success || !departmentId.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide valid facility and inventory department identifiers.");
      return;
    }
    if (!await allowDepartment(req, res, facilityId.data, departmentId.data)) return;
    try {
      const [departments] = await pool.execute<RowDataPacket[]>(
        `SELECT department_id, name FROM departments
         WHERE facility_id = ? AND status = 'active' AND department_id <> ?
         ORDER BY name LIMIT 200`,
        [facilityId.data, departmentId.data],
      );
      res.json({ departments });
    } catch (error) {
      next(error);
    }
  },
);

inventoryRouter.post(
  "/facilities/:facilityId/departments/:departmentId/items",
  requirePermission("inventory.catalog.manage"),
  async (req, res, next) => {
    const facilityId = inventoryFacilityIdSchema.safeParse(req.params.facilityId);
    const departmentId = inventoryDepartmentIdSchema.safeParse(req.params.departmentId);
    const input = inventoryItemSchema.safeParse(req.body);
    if (!facilityId.success || !departmentId.success || !input.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide valid item details and inventory department identifiers.");
      return;
    }
    if (!await allowDepartment(req, res, facilityId.data, departmentId.data)) return;
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO inventory_items
          (facility_id, item_code, name, unit_of_measure, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [facilityId.data, input.data.itemCode, input.data.name, input.data.unitOfMeasure, req.principal!.userId],
      );
      await writeAuditEvent({
        actorUserId: req.principal!.userId,
        action: "inventory.catalog.create",
        resourceType: "inventory_item",
        resourceId: String(result.insertId),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({
        item: {
          inventoryItemId: result.insertId,
          itemCode: input.data.itemCode,
          name: input.data.name,
          unitOfMeasure: input.data.unitOfMeasure,
        },
      });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
        respondError(res, 409, "INVENTORY_ITEM_CODE_EXISTS", "That item code already exists at this facility.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);

inventoryRouter.post(
  "/facilities/:facilityId/departments/:departmentId/movements",
  async (req, res, next) => {
    const facilityId = inventoryFacilityIdSchema.safeParse(req.params.facilityId);
    const departmentId = inventoryDepartmentIdSchema.safeParse(req.params.departmentId);
    const input = inventoryMovementSchema.safeParse(req.body);
    const idempotencyKey = inventoryIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!facilityId.success || !departmentId.success || !input.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide valid movement details and an Idempotency-Key UUID.");
      return;
    }
    const permission = input.data.movementType === "receipt"
      ? "inventory.stock.receive"
      : "inventory.stock.issue";
    if (!req.principal || !canUsePermission(req.principal, permission)) {
      if (req.principal) {
        await writeAuditEvent({
          actorUserId: req.principal.userId,
          action: "authorization.permission",
          resourceType: "permission",
          resourceId: permission,
          outcome: "denied",
          ipAddress: req.ip,
        });
      }
      respondError(res, 403, "FORBIDDEN", "You are not authorized to record this stock movement.");
      return;
    }
    if (!await allowDepartment(req, res, facilityId.data, departmentId.data)) return;

    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [storageDepartments] = await connection.execute<RowDataPacket[]>(
        `SELECT department_id FROM departments
         WHERE facility_id = ? AND department_id = ?
           AND department_group = 'inventory' AND status = 'active'
         LIMIT 1 FOR UPDATE`,
        [facilityId.data, departmentId.data],
      );
      if (!storageDepartments[0]) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "INVENTORY_DEPARTMENT_NOT_FOUND", "An active inventory department was not found.");
        return;
      }
      if (!canUsePermission(req.principal!, "security.role.manage")) {
        const [assignments] = await connection.execute<RowDataPacket[]>(
          `SELECT department_id FROM user_departments
           WHERE user_id = ? AND facility_id = ? AND department_id = ?
           LIMIT 1 FOR UPDATE`,
          [req.principal!.userId, facilityId.data, departmentId.data],
        );
        if (!assignments[0]) {
          await connection.rollback();
          transactionStarted = false;
          await writeAuditEvent({
            actorUserId: req.principal!.userId,
            action: "inventory.department_access",
            resourceType: "department",
            resourceId: String(departmentId.data),
            outcome: "denied",
            ipAddress: req.ip,
          });
          respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "You are not assigned to this inventory department.");
          return;
        }
      }
      const [items] = await connection.execute<RowDataPacket[]>(
        `SELECT inventory_item_id FROM inventory_items
         WHERE facility_id = ? AND inventory_item_id = ? AND status = 'active'
         LIMIT 1 FOR UPDATE`,
        [facilityId.data, input.data.inventoryItemId],
      );
      if (!items[0]) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "INVENTORY_ITEM_NOT_FOUND", "The active inventory item was not found.");
        return;
      }
      let targetDepartmentId: number | null = null;
      if (input.data.movementType === "issue") {
        targetDepartmentId = input.data.issueToDepartmentId!;
        const [destinations] = await connection.execute<RowDataPacket[]>(
          `SELECT department_id FROM departments
           WHERE facility_id = ? AND department_id = ? AND status = 'active'
           LIMIT 1 FOR UPDATE`,
          [facilityId.data, targetDepartmentId],
        );
        if (!destinations[0]) {
          await connection.rollback();
          transactionStarted = false;
          respondError(res, 404, "DESTINATION_DEPARTMENT_NOT_FOUND", "The issue destination is not active at this facility.");
          return;
        }
      }
      const existingMovement = await findIdempotentMovement(
        connection, facilityId.data, idempotencyKey.data,
      );
      if (existingMovement) {
        const matches = existingMovement.movement_type === input.data.movementType &&
          Number(existingMovement.department_id) === departmentId.data &&
          Number(existingMovement.inventory_item_id) === input.data.inventoryItemId &&
          existingMovement.batch_code === input.data.batchCode &&
          Number(existingMovement.quantity) === input.data.quantity &&
          existingMovement.reference === input.data.reference &&
          (existingMovement.issue_to_department_id === null
            ? null
            : Number(existingMovement.issue_to_department_id)) === targetDepartmentId;
        await connection.rollback();
        transactionStarted = false;
        if (!matches) {
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different stock movement.");
          return;
        }
        await writeAuditEvent({
          actorUserId: req.principal!.userId,
          action: "inventory.stock.idempotent_replay",
          resourceType: "stock_movement",
          resourceId: existingMovement.movement_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        });
        res.json({ movementId: existingMovement.movement_uuid, idempotentReplay: true });
        return;
      }
      let [lots] = await connection.execute<InventoryLotRow[]>(
        `SELECT stock_lot_id, batch_code, expires_on, quantity_on_hand
         FROM inventory_stock_lots
         WHERE facility_id = ? AND department_id = ? AND inventory_item_id = ? AND batch_code = ?
         LIMIT 1 FOR UPDATE`,
        [facilityId.data, departmentId.data, input.data.inventoryItemId, input.data.batchCode],
      );
      let lot: InventoryLotRow | undefined = lots[0];
      if (!lot && input.data.movementType === "issue") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "STOCK_LOT_NOT_FOUND", "The selected batch is not recorded in this inventory department.");
        return;
      }
      if (!lot) {
        const [insertedLot] = await connection.execute<ResultSetHeader>(
          `INSERT INTO inventory_stock_lots
            (facility_id, department_id, inventory_item_id, batch_code, expires_on,
             quantity_on_hand, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [
            facilityId.data, departmentId.data, input.data.inventoryItemId,
            input.data.batchCode, input.data.expiresOn ?? null,
          ],
        );
        [lots] = await connection.execute<InventoryLotRow[]>(
          `SELECT stock_lot_id, batch_code, expires_on, quantity_on_hand
           FROM inventory_stock_lots WHERE stock_lot_id = ? LIMIT 1 FOR UPDATE`,
          [insertedLot.insertId],
        );
        lot = lots[0];
      } else if (input.data.movementType === "receipt" &&
                 (lot.expires_on === null ? null : new Date(lot.expires_on).toISOString().slice(0, 10)) !==
                   (input.data.expiresOn ?? null)) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "STOCK_BATCH_EXPIRY_MISMATCH", "A batch code must keep the same expiry date.");
        return;
      }
      if (!lot) throw new Error("The inventory stock lot could not be read after creation.");
      if (input.data.movementType === "issue") {
        const [todayRows] = await connection.query<LocalDateRow[]>(
          "SELECT DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+03:00')) AS today_eat",
        );
        const localDate = todayRows[0]?.today_eat;
        if (!localDate) throw new Error("The local date for inventory expiry validation could not be loaded.");
        const todayEAT = new Date(localDate).toISOString().slice(0, 10);
        if (lot.expires_on !== null && new Date(lot.expires_on).toISOString().slice(0, 10) <= todayEAT) {
          await connection.rollback();
          transactionStarted = false;
          respondError(res, 409, "STOCK_BATCH_EXPIRED", "Expired stock cannot be issued.");
          return;
        }
        if (Number(lot.quantity_on_hand) < input.data.quantity) {
          await connection.rollback();
          transactionStarted = false;
          respondError(res, 409, "INSUFFICIENT_STOCK", "The batch does not have enough stock for this issue.");
          return;
        }
      } else if (input.data.expiresOn) {
        const todayEAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date());
        if (input.data.expiresOn <= todayEAT) {
          await connection.rollback();
          transactionStarted = false;
          respondError(res, 400, "STOCK_BATCH_EXPIRED", "Expired stock cannot be received into available inventory.");
          return;
        }
      }
      const movementUuid = randomUUID();
      await connection.execute(
        `UPDATE inventory_stock_lots
         SET quantity_on_hand = quantity_on_hand ${input.data.movementType === "receipt" ? "+" : "-"} ?,
             updated_at = UTC_TIMESTAMP(6)
         WHERE stock_lot_id = ? AND facility_id = ? AND department_id = ?`,
        [input.data.quantity, lot.stock_lot_id, facilityId.data, departmentId.data],
      );
      await connection.execute(
        `INSERT INTO inventory_stock_movements
          (movement_uuid, facility_id, department_id, stock_lot_id, movement_type,
           quantity, reference, issue_to_department_id, idempotency_key, actor_user_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [
          movementUuid, facilityId.data, departmentId.data, lot.stock_lot_id,
          input.data.movementType, input.data.quantity, input.data.reference,
          targetDepartmentId, idempotencyKey.data, req.principal!.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: req.principal!.userId,
        action: `inventory.stock.${input.data.movementType}`,
        resourceType: "stock_movement",
        resourceId: movementUuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ movementId: movementUuid, idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
        respondError(res, 409, "INVENTORY_MOVEMENT_CONFLICT", "This stock movement already exists; reload and retry.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);

async function findIdempotentMovement(
  connection: PoolConnection,
  facilityId: number,
  idempotencyKey: string,
): Promise<IdempotentMovementRow | null> {
  const [rows] = await connection.execute<IdempotentMovementRow[]>(
    `SELECT m.movement_uuid, m.movement_type, m.department_id, l.inventory_item_id,
            l.batch_code, m.stock_lot_id, m.quantity, m.reference, m.issue_to_department_id
     FROM inventory_stock_movements m
     JOIN inventory_stock_lots l ON l.facility_id = m.facility_id
       AND l.department_id = m.department_id AND l.stock_lot_id = m.stock_lot_id
     WHERE m.facility_id = ? AND m.idempotency_key = ? LIMIT 1 FOR UPDATE`,
    [facilityId, idempotencyKey],
  );
  return rows[0] ?? null;
}
