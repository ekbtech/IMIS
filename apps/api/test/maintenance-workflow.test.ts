import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";

const mysqlWorkflowEnabled = process.env.MYSQL_E2E === "1";
const facilityCode = "DEMO-L5";
const idempotencyKey = randomUUID();
const createdRequestIds: string[] = [];
const testUserIds: number[] = [];

interface FacilityRow extends RowDataPacket {
  facility_id: number;
}

interface DepartmentRow extends RowDataPacket {
  department_id: number;
}

async function createDepartmentStaffSession(
  facilityId: number,
  departmentCode?: string,
): Promise<string> {
  const [roles] = await pool.execute<RowDataPacket[]>(
    "SELECT role_id FROM roles WHERE role_code = 'department_staff' AND status = 'active' LIMIT 1",
  );
  if (!roles[0]) throw new Error("The department staff integration-test role is missing.");
  const [users] = await pool.execute<ResultSetHeader>(
    `INSERT INTO users (username, display_name, password_hash, status, created_at)
     VALUES (?, ?, 'test-only-password-hash', 'active', UTC_TIMESTAMP(6))`,
    [`maintenance-e2e-${randomUUID()}`, "Synthetic maintenance test user"],
  );
  const userId = users.insertId;
  testUserIds.push(userId);
  await pool.execute("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, roles[0].role_id]);
  await pool.execute("INSERT INTO user_facilities (user_id, facility_id) VALUES (?, ?)", [userId, facilityId]);
  if (departmentCode) {
    const [departments] = await pool.execute<DepartmentRow[]>(
      `SELECT department_id FROM departments
       WHERE facility_id = ? AND department_code = ? AND status = 'active' LIMIT 1`,
      [facilityId, departmentCode],
    );
    if (!departments[0]) throw new Error(`The active ${departmentCode} test department is missing.`);
    await pool.execute(
      `INSERT INTO user_departments (user_id, facility_id, department_id, assigned_at, assigned_by)
       VALUES (?, ?, ?, UTC_TIMESTAMP(6), ?)`,
      [userId, facilityId, departments[0].department_id, userId],
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

describe.skipIf(!mysqlWorkflowEnabled)("MySQL-backed synthetic maintenance workflow", () => {
  let facilityId: number;
  let reporterCookie: string;
  let biomedicalCookie: string;
  let unassignedCookie: string;
  let reportingDepartmentId: number;

  beforeAll(async () => {
    const [facilities] = await pool.execute<FacilityRow[]>(
      "SELECT facility_id FROM facilities WHERE facility_code = ? AND status = 'active' LIMIT 1",
      [facilityCode],
    );
    if (!facilities[0]) throw new Error(`Required test facility is missing: ${facilityCode}`);
    facilityId = Number(facilities[0].facility_id);
    const [departments] = await pool.execute<DepartmentRow[]>(
      `SELECT department_id FROM departments
       WHERE facility_id = ? AND department_code = 'OPD' AND status = 'active' LIMIT 1`,
      [facilityId],
    );
    if (!departments[0]) throw new Error("The active OPD test department is missing.");
    reportingDepartmentId = Number(departments[0].department_id);
    reporterCookie = await createDepartmentStaffSession(facilityId, "OPD");
    biomedicalCookie = await createDepartmentStaffSession(facilityId, "BIOMEDICAL");
    unassignedCookie = await createDepartmentStaffSession(facilityId);
  });

  afterAll(async () => {
    if (createdRequestIds.length > 0) {
      const placeholders = createdRequestIds.map(() => "?").join(", ");
      await pool.execute(
        `DELETE e FROM maintenance_request_events e
         JOIN maintenance_requests m ON m.facility_id = e.facility_id
           AND m.maintenance_request_id = e.maintenance_request_id
         WHERE m.request_uuid IN (${placeholders})`,
        createdRequestIds,
      );
      await pool.execute(
        `DELETE FROM maintenance_requests WHERE request_uuid IN (${placeholders})`,
        createdRequestIds,
      );
      await pool.execute(
        `DELETE FROM audit_events WHERE resource_type = 'maintenance_request'
         AND resource_id IN (${placeholders})`,
        createdRequestIds,
      );
    }
    if (testUserIds.length > 0) {
      const placeholders = testUserIds.map(() => "?").join(", ");
      await pool.execute(
        `DELETE FROM audit_events WHERE actor_user_id IN (${placeholders})`,
        testUserIds,
      );
      await pool.execute(`DELETE FROM sessions WHERE user_id IN (${placeholders})`, testUserIds);
      await pool.execute(`DELETE FROM user_departments WHERE user_id IN (${placeholders})`, testUserIds);
      await pool.execute(`DELETE FROM user_facilities WHERE user_id IN (${placeholders})`, testUserIds);
      await pool.execute(`DELETE FROM user_roles WHERE user_id IN (${placeholders})`, testUserIds);
      await pool.execute(`DELETE FROM users WHERE user_id IN (${placeholders})`, testUserIds);
    }
    await pool.end();
  });

  it("routes encrypted, idempotent fault reports and enforces Biomedical assignment for status changes", async () => {
    const report = {
      reportingDepartmentId,
      assetTag: `EQ-${randomUUID().slice(0, 8)}`,
      location: "Synthetic outpatient room",
      issue: `Synthetic equipment fault for test ${randomUUID()}`,
    };
    const created = await request(app)
      .post(`/api/v1/maintenance/facilities/${facilityId}/requests`)
      .set("Cookie", reporterCookie)
      .set("Idempotency-Key", idempotencyKey)
      .send(report);
    expect(created.status).toBe(201);
    expect(created.body.request.status).toBe("requested");
    const requestId = created.body.request.requestId as string;
    createdRequestIds.push(requestId);

    const replay = await request(app)
      .post(`/api/v1/maintenance/facilities/${facilityId}/requests`)
      .set("Cookie", reporterCookie)
      .set("Idempotency-Key", idempotencyKey)
      .send(report);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.request.requestId).toBe(requestId);

    const unassignedReport = await request(app)
      .post(`/api/v1/maintenance/facilities/${facilityId}/requests`)
      .set("Cookie", unassignedCookie)
      .set("Idempotency-Key", randomUUID())
      .send(report);
    expect(unassignedReport.status).toBe(403);

    const unauthorizedUpdate = await request(app)
      .post(`/api/v1/maintenance/requests/${requestId}/respond`)
      .set("Cookie", reporterCookie)
      .send({ action: "acknowledge" });
    expect(unauthorizedUpdate.status).toBe(403);

    const biomedicalQueue = await request(app)
      .get(`/api/v1/maintenance/facilities/${facilityId}/requests`)
      .set("Cookie", biomedicalCookie);
    expect(biomedicalQueue.status).toBe(200);
    expect(biomedicalQueue.body.requests).toContainEqual(expect.objectContaining({
      requestId,
      issue: report.issue,
      status: "requested",
    }));

    for (const [action, status] of [
      ["acknowledge", "acknowledged"],
      ["start", "in_progress"],
      ["complete", "completed"],
    ] as const) {
      const response = await request(app)
        .post(`/api/v1/maintenance/requests/${requestId}/respond`)
        .set("Cookie", biomedicalCookie)
        .send({ action, note: `Synthetic ${action} note` });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe(status);
    }

    const [cipherRows] = await pool.execute<RowDataPacket[]>(
      "SELECT issue_ciphertext, location_ciphertext FROM maintenance_requests WHERE request_uuid = ?",
      [requestId],
    );
    expect(Buffer.from(cipherRows[0].issue_ciphertext).toString("utf8")).not.toContain(report.issue);
    expect(Buffer.from(cipherRows[0].location_ciphertext).toString("utf8")).not.toContain(report.location);

    const finalQueue = await request(app)
      .get(`/api/v1/maintenance/facilities/${facilityId}/requests`)
      .set("Cookie", biomedicalCookie);
    expect(finalQueue.body.requests).toContainEqual(expect.objectContaining({
      requestId,
      status: "completed",
      events: expect.arrayContaining([
        expect.objectContaining({ status: "acknowledged" }),
        expect.objectContaining({ status: "in_progress" }),
        expect.objectContaining({ status: "completed" }),
      ]),
    }));
  });
});
