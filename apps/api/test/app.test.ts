import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("API foundation", () => {
  it("reports liveness without requiring a database connection", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("requires an authenticated session for current-user access", async () => {
    const response = await request(app).get("/api/v1/auth/me");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("protects department and role administration behind an authenticated session", async () => {
    const departments = await request(app)
      .get("/api/v1/admin/config/departments?facilityId=1");
    const roles = await request(app)
      .get("/api/v1/admin/config/roles");
    const permissions = await request(app)
      .put("/api/v1/admin/config/roles/1/permissions")
      .send({ permissionCodes: ["patient.mpi.search"] });
    const activation = await request(app)
      .put("/api/v1/admin/config/roles/1/activate")
      .send({
        name: "Example role",
        description: "",
        permissionCodes: ["patient.mpi.search"],
      });

    expect(departments.status).toBe(401);
    expect(roles.status).toBe(401);
    expect(permissions.status).toBe(401);
    expect(activation.status).toBe(401);
  });

  it("requires authentication for appointment request endpoints", async () => {
    const departments = await request(app)
      .get("/api/v1/appointments/facilities/1/departments");
    const list = await request(app)
      .get("/api/v1/appointments/facilities/1/requests");
    const create = await request(app)
      .post("/api/v1/appointments/facilities/1/requests")
      .set("Idempotency-Key", "d9428888-122b-4e09-a6f7-6c8f8a4a9d01")
      .send({
        patientId: 1,
        departmentId: 1,
        requestedAt: "2035-05-17T10:30",
        reason: "Synthetic appointment request for route protection.",
      });

    expect(departments.status).toBe(401);
    expect(list.status).toBe(401);
    expect(create.status).toBe(401);
  });

  it("requires authentication for inventory endpoints", async () => {
    const departments = await request(app)
      .get("/api/v1/inventory/facilities/1/departments");
    const stock = await request(app)
      .get("/api/v1/inventory/facilities/1/departments/1");
    const receipt = await request(app)
      .post("/api/v1/inventory/facilities/1/departments/1/movements")
      .set("Idempotency-Key", "d9428888-122b-4e09-a6f7-6c8f8a4a9d01")
      .send({
        movementType: "receipt",
        inventoryItemId: 1,
        batchCode: "SYNTHETIC-1",
        quantity: 1,
        reference: "Synthetic receipt",
      });

    expect(departments.status).toBe(401);
    expect(stock.status).toBe(401);
    expect(receipt.status).toBe(401);
  });

  it("rejects malformed credentials before querying the database", async () => {
    const response = await request(app)
      .post("/api/v1/auth/login")
      .set("Origin", "http://127.0.0.1:5173")
      .send({ username: "", password: "" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects sign-in attempts from an untrusted origin", async () => {
    const response = await request(app)
      .post("/api/v1/auth/login")
      .set("Origin", "https://untrusted.example")
      .send({ username: "synthetic-user", password: "synthetic-test-password" });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });
});
