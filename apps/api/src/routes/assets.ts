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
  assetEntrySchema,
  assetFacilityIdSchema,
  assetUpdateSchema,
  assetUuidSchema,
} from "../validation/assets.js";

interface AssetRow extends RowDataPacket {
  facility_asset_id: number;
  asset_uuid: string;
  facility_id: number;
  department_id: number;
  department_name: string;
  asset_tag: string;
  name: string;
  category: string;
  manufacturer: string;
  model: string;
  serial_ciphertext: Buffer | null;
  location_ciphertext: Buffer;
  registered_by: number;
  registrar_name: string;
  registered_at: Date;
  updated_by: number;
  updater_name: string;
  updated_at: Date;
}

interface AssetEventRow extends RowDataPacket {
  asset_uuid: string;
  event_type: "registered" | "updated" | "reassigned";
  previous_department: string | null;
  new_department: string;
  details_ciphertext: Buffer;
  actor_name: string;
  occurred_at: Date;
}

interface DepartmentRow extends RowDataPacket {
  department_id: number;
}

const assetSelect = `SELECT a.facility_asset_id, a.asset_uuid, a.facility_id, a.department_id,
  d.name AS department_name, a.asset_tag, a.name, a.category, a.manufacturer, a.model,
  a.serial_ciphertext, a.location_ciphertext, a.registered_by,
  registrar.display_name AS registrar_name, a.registered_at, a.updated_by,
  updater.display_name AS updater_name, a.updated_at
  FROM facility_assets a
  JOIN departments d ON d.facility_id = a.facility_id AND d.department_id = a.department_id
  JOIN users registrar ON registrar.user_id = a.registered_by
  JOIN users updater ON updater.user_id = a.updated_by`;

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function serializeAsset(row: AssetRow) {
  return {
    assetId: row.asset_uuid,
    departmentId: Number(row.department_id),
    department: row.department_name,
    assetTag: row.asset_tag,
    name: row.name,
    category: row.category,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNumber: row.serial_ciphertext ? decryptData(row.serial_ciphertext) : "",
    location: decryptData(row.location_ciphertext),
    registeredBy: row.registrar_name,
    registeredAt: new Date(row.registered_at).toISOString(),
    updatedBy: row.updater_name,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export const assetsRouter = Router();
assetsRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
assetsRouter.use(requireSession);

assetsRouter.get(
  "/facilities/:facilityId/assets",
  requirePermission("asset.register.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const facilityId = assetFacilityIdSchema.safeParse(req.params.facilityId);
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
      respondError(res, 503, "ASSET_DATA_KEY_REQUIRED", "Equipment register encryption is not configured.");
      return;
    }
    try {
      const [rows] = await pool.execute<AssetRow[]>(
        `${assetSelect}
         JOIN user_departments ud ON ud.facility_id = a.facility_id
           AND ud.department_id = a.department_id AND ud.user_id = ?
         WHERE a.facility_id = ?
         ORDER BY d.name, a.name, a.asset_tag LIMIT 101`,
        [principal.userId, facilityId.data],
      );
      const [departments] = await pool.execute<DepartmentRow[]>(
        `SELECT d.department_id, d.name
         FROM departments d
         JOIN user_departments ud ON ud.facility_id = d.facility_id
           AND ud.department_id = d.department_id
         WHERE ud.user_id = ? AND d.facility_id = ? AND d.status = 'active'
         ORDER BY d.name LIMIT 100`,
        [principal.userId, facilityId.data],
      );
      const assets = rows.slice(0, 100);
      let events: AssetEventRow[] = [];
      if (assets.length > 0) {
        const placeholders = assets.map(() => "?").join(", ");
        const [eventRows] = await pool.execute<AssetEventRow[]>(
          `SELECT a.asset_uuid, e.event_type, previous.name AS previous_department,
                  target_department.name AS new_department, e.details_ciphertext,
                  u.display_name AS actor_name, e.occurred_at
           FROM facility_asset_events e
           JOIN facility_assets a ON a.facility_id = e.facility_id
             AND a.facility_asset_id = e.facility_asset_id
           LEFT JOIN departments previous ON previous.facility_id = e.facility_id
             AND previous.department_id = e.previous_department_id
           JOIN departments target_department ON target_department.facility_id = e.facility_id
             AND target_department.department_id = e.new_department_id
           JOIN users u ON u.user_id = e.actor_user_id
           JOIN user_departments ud ON ud.facility_id = a.facility_id
             AND ud.department_id = a.department_id AND ud.user_id = ?
           WHERE e.facility_id = ? AND a.asset_uuid IN (${placeholders})
           ORDER BY e.occurred_at, e.facility_asset_event_id`,
          [principal.userId, facilityId.data, ...assets.map((asset) => asset.asset_uuid)],
        );
        events = eventRows;
      }
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "asset.register.list",
        resourceType: "facility",
        resourceId: String(facilityId.data),
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({
        departments,
        assets: assets.map((asset) => ({
          ...serializeAsset(asset),
          events: events
            .filter((event) => event.asset_uuid === asset.asset_uuid)
            .map((event) => ({
              type: event.event_type,
              previousDepartment: event.previous_department,
              department: event.new_department,
              changes: JSON.parse(decryptData(event.details_ciphertext)) as Record<string, string>,
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

assetsRouter.post(
  "/facilities/:facilityId/assets",
  requirePermission("asset.register.manage"),
  async (req, res, next) => {
    const principal = req.principal;
    const facilityId = assetFacilityIdSchema.safeParse(req.params.facilityId);
    const input = assetEntrySchema.safeParse(req.body);
    if (!facilityId.success || !input.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid facility, assigned department, asset tag, name, category, and location.");
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
    if (!canAccessDepartment(principal, facilityId.data, input.data.departmentId)) {
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "asset.register.create",
        resourceType: "department",
        resourceId: String(input.data.departmentId),
        outcome: "denied",
        ipAddress: req.ip,
      });
      respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "You are not assigned to the equipment department.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "ASSET_DATA_KEY_REQUIRED", "Equipment register encryption is not configured.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [departments] = await connection.execute<DepartmentRow[]>(
        `SELECT department_id FROM departments
         WHERE facility_id = ? AND department_id = ? AND status = 'active'
         LIMIT 1 FOR UPDATE`,
        [facilityId.data, input.data.departmentId],
      );
      if (!departments[0]) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "DEPARTMENT_NOT_FOUND", "The equipment department is not active at this facility.");
        return;
      }
      const assetUuid = randomUUID();
      const [inserted] = await connection.execute<ResultSetHeader>(
        `INSERT INTO facility_assets
          (asset_uuid, facility_id, department_id, asset_tag, name, category,
           manufacturer, model, serial_ciphertext, location_ciphertext,
           registered_by, registered_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?, UTC_TIMESTAMP(6))`,
        [
          assetUuid, facilityId.data, input.data.departmentId, input.data.assetTag,
          input.data.name, input.data.category, input.data.manufacturer, input.data.model,
          input.data.serialNumber ? encryptData(input.data.serialNumber) : null,
          encryptData(input.data.location), principal.userId, principal.userId,
        ],
      );
      await connection.execute(
        `INSERT INTO facility_asset_events
          (facility_id, facility_asset_id, event_type, previous_department_id,
           new_department_id, details_ciphertext, actor_user_id, occurred_at)
         VALUES (?, ?, 'registered', NULL, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [
          facilityId.data, inserted.insertId, input.data.departmentId,
          encryptData(JSON.stringify({ registered: ["assetTag", "name", "category", "manufacturer", "model", "serialNumber", "location"] })),
          principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "asset.register.create",
        resourceType: "facility_asset",
        resourceId: assetUuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const [createdRows] = await connection.execute<AssetRow[]>(
        `${assetSelect} WHERE a.asset_uuid = ? LIMIT 1`,
        [assetUuid],
      );
      if (!createdRows[0]) throw new Error("The equipment register entry could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ asset: serializeAsset(createdRows[0]) });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
        respondError(res, 409, "ASSET_TAG_CONFLICT", "That asset tag is already registered at this facility.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);

assetsRouter.put(
  "/assets/:assetId",
  requirePermission("asset.register.manage"),
  async (req, res, next) => {
    const principal = req.principal;
    const assetId = assetUuidSchema.safeParse(req.params.assetId);
    const input = assetUpdateSchema.safeParse(req.body);
    if (!assetId.success || !input.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid asset identifier, assigned department, name, category, and location.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "ASSET_DATA_KEY_REQUIRED", "Equipment register encryption is not configured.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [rows] = await connection.execute<AssetRow[]>(
        `${assetSelect} WHERE a.asset_uuid = ? LIMIT 1 FOR UPDATE`,
        [assetId.data],
      );
      const asset = rows[0];
      if (!asset) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "ASSET_NOT_FOUND", "The equipment register entry was not found.");
        return;
      }
      if (!canAccessFacility(principal, Number(asset.facility_id))) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
        return;
      }
      if (!canAccessDepartment(principal, Number(asset.facility_id), Number(asset.department_id)) ||
          !canAccessDepartment(principal, Number(asset.facility_id), input.data.departmentId)) {
        await connection.rollback();
        transactionStarted = false;
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "asset.register.update",
          resourceType: "facility_asset",
          resourceId: asset.asset_uuid,
          outcome: "denied",
          ipAddress: req.ip,
        });
        respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "You must be assigned to both the current and target equipment departments.");
        return;
      }
      const [targetDepartments] = await connection.execute<DepartmentRow[]>(
        `SELECT department_id FROM departments
         WHERE facility_id = ? AND department_id = ? AND status = 'active'
         LIMIT 1 FOR UPDATE`,
        [asset.facility_id, input.data.departmentId],
      );
      if (!targetDepartments[0]) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "DEPARTMENT_NOT_FOUND", "The target equipment department is not active at this facility.");
        return;
      }
      const previousValues = {
        departmentId: Number(asset.department_id),
        name: asset.name,
        category: asset.category,
        manufacturer: asset.manufacturer,
        model: asset.model,
        serialNumber: asset.serial_ciphertext ? decryptData(asset.serial_ciphertext) : "",
        location: decryptData(asset.location_ciphertext),
      };
      const nextValues = {
        departmentId: input.data.departmentId,
        name: input.data.name,
        category: input.data.category,
        manufacturer: input.data.manufacturer,
        model: input.data.model,
        serialNumber: input.data.serialNumber,
        location: input.data.location,
      };
      const changedFields = Object.fromEntries(
        Object.keys(nextValues)
          .filter((key) => previousValues[key as keyof typeof previousValues] !== nextValues[key as keyof typeof nextValues])
          .map((key) => [key, `${String(previousValues[key as keyof typeof previousValues])} -> ${String(nextValues[key as keyof typeof nextValues])}`]),
      );
      if (Object.keys(changedFields).length === 0) {
        await connection.rollback();
        transactionStarted = false;
        res.json({ asset: serializeAsset(asset), changed: false });
        return;
      }
      await connection.execute(
        `UPDATE facility_assets SET department_id = ?, name = ?, category = ?,
         manufacturer = ?, model = ?, serial_ciphertext = ?, location_ciphertext = ?,
         updated_by = ?, updated_at = UTC_TIMESTAMP(6)
         WHERE facility_id = ? AND facility_asset_id = ?`,
        [
          input.data.departmentId, input.data.name, input.data.category, input.data.manufacturer,
          input.data.model, input.data.serialNumber ? encryptData(input.data.serialNumber) : null,
          encryptData(input.data.location), principal.userId, asset.facility_id, asset.facility_asset_id,
        ],
      );
      const reassigned = Number(asset.department_id) !== input.data.departmentId;
      await connection.execute(
        `INSERT INTO facility_asset_events
          (facility_id, facility_asset_id, event_type, previous_department_id,
           new_department_id, details_ciphertext, actor_user_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [
          asset.facility_id, asset.facility_asset_id, reassigned ? "reassigned" : "updated",
          asset.department_id, input.data.departmentId, encryptData(JSON.stringify(changedFields)), principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: reassigned ? "asset.register.reassign" : "asset.register.update",
        resourceType: "facility_asset",
        resourceId: asset.asset_uuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const [updatedRows] = await connection.execute<AssetRow[]>(
        `${assetSelect} WHERE a.asset_uuid = ? LIMIT 1`,
        [asset.asset_uuid],
      );
      if (!updatedRows[0]) throw new Error("The equipment register entry could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.json({ asset: serializeAsset(updatedRows[0]), changed: true });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      next(error);
    } finally {
      connection?.release();
    }
  },
);
