import type { RowDataPacket } from "mysql2";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessFacility } from "../security/access-control.js";
import { writeAuditEvent } from "../security/audit.js";

const encounterUuidSchema = z.string().uuid();
const ENCOUNTER_LIMIT = 50;
const SECTION_LIMIT = 500;

interface EncounterRow extends RowDataPacket {
  encounter_id: number;
  encounter_uuid: string;
  facility_id: number;
  patient_id: number;
  record_number: string;
  encounter_type: "outpatient" | "emergency";
  status: "open" | "closed" | "cancelled";
  opened_at: Date;
}

interface ObservationRow extends RowDataPacket {
  observation_uuid: string;
  encounter_id: number;
  systolic_bp_mmhg: string | number | null;
  diastolic_bp_mmhg: string | number | null;
  pulse_bpm: string | number | null;
  respiratory_rate_bpm: string | number | null;
  temperature_celsius: string | number | null;
  oxygen_saturation_percent: string | number | null;
  weight_kg: string | number | null;
  height_cm: string | number | null;
  recorded_at: Date;
}

interface TriageRow extends RowDataPacket {
  triage_uuid: string;
  encounter_id: number;
  status: "awaiting_review" | "reviewed";
  captured_at: Date;
  reviewed_at: Date | null;
}

interface DiagnosticRow extends RowDataPacket {
  order_uuid: string;
  encounter_id: number;
  service_code: string;
  display_name: string;
  status: "ordered" | "cancelled";
  requested_at: Date;
}

interface AdmissionRow extends RowDataPacket {
  admission_uuid: string;
  encounter_id: number;
  status: "active" | "discharged";
  admitted_at: Date;
  discharged_at: Date | null;
  ward_code: string | null;
  bed_code: string | null;
}

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function dateString(value: Date): string {
  return new Date(value).toISOString();
}

function measurement(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

export const careContextRouter = Router();
careContextRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
careContextRouter.use(requireSession);

careContextRouter.get(
  "/:encounterId/care-context",
  requirePermission("care.context.read"),
  async (req: Request, res: Response, next) => {
    const principal = req.principal;
    const parsedEncounter = encounterUuidSchema.safeParse(req.params.encounterId);
    if (!parsedEncounter.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }

    try {
      const [anchorRows] = await pool.execute<EncounterRow[]>(
        `SELECT e.encounter_id, e.encounter_uuid, e.facility_id, e.patient_id,
                p.record_number, e.encounter_type, e.status, e.opened_at
         FROM encounters e
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         WHERE e.encounter_uuid = ? AND p.status = 'active'
         LIMIT 1`,
        [parsedEncounter.data],
      );
      const anchor = anchorRows[0];
      if (!anchor || !canAccessFacility(principal, Number(anchor.facility_id))) {
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "care.context.read",
          resourceType: "encounter",
          resourceId: parsedEncounter.data,
          outcome: "denied",
          ipAddress: req.ip,
        });
        respondError(res, 404, "ENCOUNTER_NOT_FOUND", "No accessible encounter was found.");
        return;
      }

      const [encounterRows] = await pool.execute<EncounterRow[]>(
        `SELECT e.encounter_id, e.encounter_uuid, e.facility_id, e.patient_id,
                p.record_number, e.encounter_type, e.status, e.opened_at
         FROM encounters e
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         WHERE e.facility_id = ? AND e.patient_id = ? AND p.status = 'active'
         ORDER BY e.opened_at DESC, e.encounter_id DESC
         LIMIT ?`,
        [anchor.facility_id, anchor.patient_id, ENCOUNTER_LIMIT + 1],
      );
      const encounters = encounterRows.slice(0, ENCOUNTER_LIMIT);
      const encounterIds = encounters.map((encounter) => Number(encounter.encounter_id));
      const placeholders = encounterIds.map(() => "?").join(", ");
      const truncatedSections: string[] = [];
      const byEncounter = new Map<number, {
        encounterId: string;
        encounterType: string;
        status: string;
        openedAt: string;
        observations?: Array<Record<string, unknown>>;
        triageAssessments?: Array<Record<string, unknown>>;
        diagnosticOrders?: Array<Record<string, unknown>>;
        admissions?: Array<Record<string, unknown>>;
      }>();

      for (const encounter of encounters) {
        byEncounter.set(Number(encounter.encounter_id), {
          encounterId: encounter.encounter_uuid,
          encounterType: encounter.encounter_type,
          status: encounter.status,
          openedAt: dateString(encounter.opened_at),
        });
      }

      const sections: string[] = [];
      if (principal.permissions.has("encounter.observation.read") && encounterIds.length > 0) {
        const [rows] = await pool.execute<ObservationRow[]>(
          `SELECT observation_uuid, encounter_id, systolic_bp_mmhg, diastolic_bp_mmhg,
                  pulse_bpm, respiratory_rate_bpm, temperature_celsius,
                  oxygen_saturation_percent, weight_kg, height_cm, recorded_at
           FROM encounter_observations
           WHERE facility_id = ? AND encounter_id IN (${placeholders})
           ORDER BY recorded_at DESC, observation_id DESC
           LIMIT ?`,
          [anchor.facility_id, ...encounterIds, SECTION_LIMIT + 1],
        );
        sections.push("observations");
        if (rows.length > SECTION_LIMIT) truncatedSections.push("observations");
        for (const row of rows.slice(0, SECTION_LIMIT)) {
          const context = byEncounter.get(Number(row.encounter_id));
          if (!context) continue;
          context.observations ??= [];
          context.observations.push({
            observationId: row.observation_uuid,
            systolicBpMmhg: measurement(row.systolic_bp_mmhg),
            diastolicBpMmhg: measurement(row.diastolic_bp_mmhg),
            pulseBpm: measurement(row.pulse_bpm),
            respiratoryRateBpm: measurement(row.respiratory_rate_bpm),
            temperatureCelsius: measurement(row.temperature_celsius),
            oxygenSaturationPercent: measurement(row.oxygen_saturation_percent),
            weightKg: measurement(row.weight_kg),
            heightCm: measurement(row.height_cm),
            recordedAt: dateString(row.recorded_at),
          });
        }
      }

      if (
        (principal.permissions.has("triage.queue.read") ||
          principal.permissions.has("triage.assessment.capture") ||
          principal.permissions.has("triage.assessment.review")) &&
        encounterIds.length > 0
      ) {
        const [settingsRows] = await pool.execute<RowDataPacket[]>(
          "SELECT enabled FROM triage_module_settings WHERE facility_id = ? LIMIT 1",
          [anchor.facility_id],
        );
        if (Number(settingsRows[0]?.enabled) === 1) {
          const [rows] = await pool.execute<TriageRow[]>(
            `SELECT triage_uuid, encounter_id, status, captured_at, reviewed_at
             FROM triage_assessments
             WHERE facility_id = ? AND encounter_id IN (${placeholders})
             ORDER BY captured_at DESC, triage_assessment_id DESC
             LIMIT ?`,
            [anchor.facility_id, ...encounterIds, SECTION_LIMIT + 1],
          );
          sections.push("triage");
          if (rows.length > SECTION_LIMIT) truncatedSections.push("triage");
          for (const row of rows.slice(0, SECTION_LIMIT)) {
            const context = byEncounter.get(Number(row.encounter_id));
            if (!context) continue;
            context.triageAssessments ??= [];
            context.triageAssessments.push({
              triageId: row.triage_uuid,
              status: row.status,
              capturedAt: dateString(row.captured_at),
              reviewedAt: row.reviewed_at ? dateString(row.reviewed_at) : null,
            });
          }
        }
      }

      if (principal.permissions.has("diagnostics.order.read") && encounterIds.length > 0) {
        const [settingsRows] = await pool.execute<RowDataPacket[]>(
          "SELECT enabled FROM diagnostic_module_settings WHERE facility_id = ? LIMIT 1",
          [anchor.facility_id],
        );
        if (Number(settingsRows[0]?.enabled) === 1) {
          const [rows] = await pool.execute<DiagnosticRow[]>(
            `SELECT o.order_uuid, o.encounter_id, s.service_code, s.display_name,
                    o.status, o.requested_at
             FROM diagnostic_orders o
             JOIN diagnostic_services s ON s.service_id = o.service_id AND s.facility_id = o.facility_id
             WHERE o.facility_id = ? AND o.encounter_id IN (${placeholders})
             ORDER BY o.requested_at DESC, o.diagnostic_order_id DESC
             LIMIT ?`,
            [anchor.facility_id, ...encounterIds, SECTION_LIMIT + 1],
          );
          sections.push("diagnostics");
          if (rows.length > SECTION_LIMIT) truncatedSections.push("diagnostics");
          for (const row of rows.slice(0, SECTION_LIMIT)) {
            const context = byEncounter.get(Number(row.encounter_id));
            if (!context) continue;
            context.diagnosticOrders ??= [];
            context.diagnosticOrders.push({
              orderId: row.order_uuid,
              serviceCode: row.service_code,
              serviceName: row.display_name,
              status: row.status,
              requestedAt: dateString(row.requested_at),
            });
          }
        }
      }

      if (principal.permissions.has("inpatient.admission.read") && encounterIds.length > 0) {
        const [settingsRows] = await pool.execute<RowDataPacket[]>(
          "SELECT enabled FROM inpatient_module_settings WHERE facility_id = ? LIMIT 1",
          [anchor.facility_id],
        );
        if (Number(settingsRows[0]?.enabled) === 1) {
          const [rows] = await pool.execute<AdmissionRow[]>(
            `SELECT a.admission_uuid, a.encounter_id, a.status, a.admitted_at, a.discharged_at,
                    w.ward_code, b.bed_code
             FROM inpatient_admissions a
             LEFT JOIN inpatient_bed_assignments ba
               ON ba.admission_id = a.admission_id AND ba.facility_id = a.facility_id
               AND ba.ended_at IS NULL
             LEFT JOIN inpatient_beds b ON b.bed_id = ba.bed_id AND b.facility_id = ba.facility_id
             LEFT JOIN inpatient_wards w ON w.ward_id = b.ward_id AND w.facility_id = b.facility_id
             WHERE a.facility_id = ? AND a.encounter_id IN (${placeholders})
             ORDER BY a.admitted_at DESC, a.admission_id DESC
             LIMIT ?`,
            [anchor.facility_id, ...encounterIds, SECTION_LIMIT + 1],
          );
          sections.push("inpatient");
          if (rows.length > SECTION_LIMIT) truncatedSections.push("inpatient");
          for (const row of rows.slice(0, SECTION_LIMIT)) {
            const context = byEncounter.get(Number(row.encounter_id));
            if (!context) continue;
            context.admissions ??= [];
            context.admissions.push({
              admissionId: row.admission_uuid,
              status: row.status,
              admittedAt: dateString(row.admitted_at),
              dischargedAt: row.discharged_at ? dateString(row.discharged_at) : null,
              wardCode: row.ward_code,
              bedCode: row.bed_code,
            });
          }
        }
      }

      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "care.context.read",
        resourceType: "patient",
        resourceId: String(anchor.patient_id),
        outcome: "allowed",
        ipAddress: req.ip,
      });
      const timeline = encounters.map((encounter) => {
        const context = byEncounter.get(Number(encounter.encounter_id));
        if (!context) throw new Error("An encounter was not available while assembling its shared context.");
        return context;
      });
      res.json({
        patient: {
          patientId: Number(anchor.patient_id),
          recordNumber: anchor.record_number,
        },
        encounters: timeline,
        sections,
        truncated: encounterRows.length > ENCOUNTER_LIMIT,
        truncatedSections,
      });
    } catch (error) {
      next(error);
    }
  },
);
