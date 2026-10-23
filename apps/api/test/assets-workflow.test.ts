import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";

const mysqlWorkflowEnabled = process.env.MYSQL_E2E === "1";
const testUserIds: number[] = [];
const assetIds: string[] = [];

interface FacilityRow extends RowDataPacket {
  facility_id: number;
}

interface DepartmentRow extends RowDataPacket {
  department_id: number;
}

async function createAssetStaffSession(
  facilityId: number,
  departmentIds: number[],
): Promise<string> {
  const [roles] = await pool.execute<RowDataPacket[]>(
    "SELECT role_id FROM roles WHERE role_code = 'department_staff' AND status = 'active' LIMIT 1",
  );
  if (!roles[0]) throw new Error("The department staff integration-test role is missing.");
  const [users] = await pool.execute<ResultSetHeader>(
    `INSERT INTO users (username, display_name, password_hash, status, created_at)
     VALUES (?, ?, 'test-only-password-hash', 'active', UTC_TIMESTAMP(6))`,
    [`asset-e2e-${randomUUID()}`, "Synthetic asset test user"],
  );
  const userId = users.insertId;
  testUserIds.push(userId);
  await pool.execute("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, roles[0].role_id]);
  await pool.execute("INSERT INTO user_facilities (user_id, facility_id) VALUES (?, ?)", [userId, facilityId]);
  for (const departmentId of departmentIds) {
    await pool.execute(
      `INSERT INTO user_departments (user_id, facility_id, department_id, assigned_at, assigned_by)
       VALUES (?, ?, ?, UTC_TIMESTAMP(6), ?)`,
      [userId, facilityId, departmentId, userId],
    );
  }
  const token = randomBytes(32).toString("base64url");
  await pool.execute(
    `INSERT INTO sessions
      (user_id, token_hash, created_at, last_seen_at, idle_expires_at,
       absolute_expires_at, revoked_at, mfa_verified_at)
     VALUES (?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6),
       DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 15 MINUTE),
       DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 1 HOUR), NULL, UTC_TIMESTAMP(6))`,
    [userId, createHash("sha256").update(token).digest("hex")],
  );
  return `imis_session=${token}`;
}

describe.skipIf(!mysqlWorkflowEnabled)("MySQL-backed synthetic equipment register", () => {
  let facilityId: number;
  let firstDepartmentId: number;
  let secondDepartmentId: number;
  let managerCookie: string;
  let firstDepartmentCookie: string;

  beforeAll(async () => {
    const [facilities] = await pool.execute<FacilityRow[]>(
      "SELECT facility_id FROM facilities WHERE facility_code = 'DEMO-L5' AND status = 'active' LIMIT 1",
    );
    if (!facilities[0]) throw new Error("The active DEMO-L5 integration-test facility is missing.");
    facilityId = Number(facilities[0].facility_id);
    const [departments] = await pool.execute<DepartmentRow[]>(
      `SELECT department_id FROM departments
       WHERE facility_id = ? AND status = 'active'
       ORDER BY department_id LIMIT 2`,
      [facilityId],
    );
    if (departments.length < 2) throw new Error("Two active departments are required for asset register tests.");
    firstDepartmentId = Number(departments[0].department_id);
    secondDepartmentId = Number(departments[1].department_id);
    managerCookie = await createAssetStaffSession(facilityId, [firstDepartmentId, secondDepartmentId]);
    firstDepartmentCookie = await createAssetStaffSession(facilityId, [firstDepartmentId]);
  });

  afterAll(async () => {
    if (assetIds.length > 0) {
      const placeholders = assetIds.map(() => "?").join(", ");
      await pool.execute(
        `DELETE FROM facility_asset_events
         WHERE facility_asset_id IN (
           SELECT facility_asset_id FROM facility_assets WHERE asset_uuid IN (${placeholders})
         )`,
        assetIds,
      );
      await pool.execute(
        `DELETE FROM audit_events WHERE resource_type = 'facility_asset'
         AND resource_id IN (${placeholders})`,
        assetIds,
      );
      await pool.execute(`DELETE FROM facility_assets WHERE asset_uuid IN (${placeholders})`, assetIds);
    }
    if (testUserIds.length > 0) {
      const placeholders = testUserIds.map(() => "?").join(", ");
      await pool.execute(`DELETE FROM audit_events WHERE actor_user_id IN (${placeholders})`, testUserIds);
      await pool.execute(`DELETE FROM sessions WHERE user_id IN (${placeholders})`, testUserIds);
      await pool.execute(`DELETE FROM user_departments WHERE user_id IN (${placeholders})`, testUserIds);
      await pool.execute(`DELETE FROM user_facilities WHERE user_id IN (${placeholders})`, testUserIds);
      await pool.execute(`DELETE FROM user_roles WHERE user_id IN (${placeholders})`, testUserIds);
      await pool.execute(`DELETE FROM users WHERE user_id IN (${placeholders})`, testUserIds);
    }
    await pool.end();
  });

  it("records encrypted department-scoped equipment and append-only reassignment history", async () => {
    const asset = {
      departmentId: firstDepartmentId,
      assetTag: `ASSET-${randomUUID().slice(0, 8)}`,
      name: "Synthetic examination lamp",
      category: "Clinical equipment",
      manufacturer: "Test manufacturer",
      model: "Synthetic model",
      serialNumber: `SERIAL-${randomUUID()}`,
      location: `Test room ${randomUUID().slice(0, 6)}`,
    };
    const created = await request(app)
      .post(`/api/v1/assets/facilities/${facilityId}/assets`)
      .set("Cookie", managerCookie)
      .send(asset);
    expect(created.status).toBe(201);
    const assetId = created.body.asset.assetId as string;
    assetIds.push(assetId);

    const [stored] = await pool.execute<RowDataPacket[]>(
      `SELECT serial_ciphertext, location_ciphertext
       FROM facility_assets WHERE asset_uuid = ?`,
      [assetId],
    );
    expect(Buffer.from(stored[0].serial_ciphertext).toString("utf8")).not.toContain(asset.serialNumber);
    expect(Buffer.from(stored[0].location_ciphertext).toString("utf8")).not.toContain(asset.location);

    const beforeReassignment = await request(app)
      .get(`/api/v1/assets/facilities/${facilityId}/assets`)
      .set("Cookie", firstDepartmentCookie);
    expect(beforeReassignment.status).toBe(200);
    expect(beforeReassignment.body.assets).toContainEqual(expect.objectContaining({ assetId }));

    const update = await request(app)
      .put(`/api/v1/assets/assets/${assetId}`)
      .set("Cookie", managerCookie)
      .send({
        ...asset,
        departmentId: secondDepartmentId,
        location: "Synthetic new equipment room",
      });
    expect(update.status).toBe(200);
    expect(update.body.asset.departmentId).toBe(secondDepartmentId);

    const afterReassignment = await request(app)
      .get(`/api/v1/assets/facilities/${facilityId}/assets`)
      .set("Cookie", firstDepartmentCookie);
    expect(afterReassignment.status).toBe(200);
    expect(afterReassignment.body.assets).not.toContainEqual(expect.objectContaining({ assetId }));

    const managerRegister = await request(app)
      .get(`/api/v1/assets/facilities/${facilityId}/assets`)
      .set("Cookie", managerCookie);
    expect(managerRegister.body.assets).toContainEqual(expect.objectContaining({
      assetId,
      departmentId: secondDepartmentId,
      serialNumber: asset.serialNumber,
      events: expect.arrayContaining([
        expect.objectContaining({ type: "registered" }),
        expect.objectContaining({ type: "reassigned" }),
      ]),
    }));
  });
});
