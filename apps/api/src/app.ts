import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { pool } from "./db.js";
import { authRouter } from "./routes/auth.js";
import { mfaRouter } from "./routes/mfa.js";
import { patientsRouter } from "./routes/patients.js";
import { adminFacilitiesRouter, adminUsersRouter } from "./routes/admin-users.js";
import { organizationAdminRouter } from "./routes/admin-organization.js";
import { departmentWorkspacesRouter } from "./routes/department-workspaces.js";
import { facilitiesRouter } from "./routes/facilities.js";
import { encountersRouter } from "./routes/encounters.js";
import { observationsRouter } from "./routes/observations.js";
import { notesRouter } from "./routes/notes.js";
import { diagnosticsRouter } from "./routes/diagnostics.js";
import { inpatientRouter } from "./routes/inpatient.js";
import { financeRouter } from "./routes/finance.js";
import { triageRouter } from "./routes/triage.js";
import { careContextRouter } from "./routes/care-context.js";
import { workflowRouter } from "./routes/workflow.js";
import { appointmentsRouter } from "./routes/appointments.js";
import { inventoryRouter } from "./routes/inventory.js";
import { maintenanceRouter } from "./routes/maintenance.js";
import { assetsRouter } from "./routes/assets.js";

export const app = express();

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
    },
  },
  referrerPolicy: { policy: "no-referrer" },
}));
app.use(cors({ origin: config.WEB_ORIGIN, credentials: true, methods: ["GET", "POST", "PUT"], allowedHeaders: ["Content-Type", "Idempotency-Key"] }));
app.use(express.json({ limit: "32kb", type: "application/json" }));
app.use(cookieParser());
app.use((req, res, next) => {
  const correlationId = randomUUID();
  res.setHeader("X-Correlation-ID", correlationId);
  next();
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/ready", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready" });
  } catch (error) {
    next(error);
  }
});
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/auth/mfa", mfaRouter);
app.use("/api/v1/admin", adminFacilitiesRouter);
app.use("/api/v1/admin/config", organizationAdminRouter);
app.use("/api/v1/admin/users", adminUsersRouter);
app.use("/api/v1/departments", departmentWorkspacesRouter);
app.use("/api/v1/facilities", facilitiesRouter);
app.use("/api/v1/patients", patientsRouter);
app.use("/api/v1/encounters", notesRouter);
app.use("/api/v1/encounters", careContextRouter);
app.use("/api/v1/workflow", workflowRouter);
app.use("/api/v1/appointments", appointmentsRouter);
app.use("/api/v1/inventory", inventoryRouter);
app.use("/api/v1/maintenance", maintenanceRouter);
app.use("/api/v1/assets", assetsRouter);
app.use("/api/v1/diagnostics", diagnosticsRouter);
app.use("/api/v1/inpatient", inpatientRouter);
app.use("/api/v1/finance", financeRouter);
app.use("/api/v1/triage", triageRouter);
app.use("/api/v1/encounters", observationsRouter);
app.use("/api/v1/encounters", encountersRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "The requested resource was not found." } });
});

const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const correlationId = res.getHeader("X-Correlation-ID");
  const details = error instanceof Error
    ? { name: error.name, ...(config.NODE_ENV === "production" ? {} : { message: error.message, stack: error.stack }) }
    : { name: "UnknownError" };
  console.error(JSON.stringify({
    level: "error",
    event: "request.failed",
    correlationId,
    method: req.method,
    path: req.path,
    ...details,
  }));
  if (res.headersSent) return;
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "The request could not be completed.", correlationId },
  });
};
app.use(errorHandler);
