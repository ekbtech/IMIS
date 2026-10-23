import { z } from "zod";

const eatDateTimeSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u,
  "Choose a valid date and time in East Africa Time.",
).refine((value) => {
  const date = new Date(`${value}:00+03:00`);
  const calendarDate = new Date(`${value}:00Z`);
  return !Number.isNaN(date.valueOf()) &&
    !Number.isNaN(calendarDate.valueOf()) &&
    calendarDate.toISOString().slice(0, 16) === value &&
    date.getTime() > Date.now();
}, "Choose a future date and time.");

export const appointmentFacilityIdSchema = z.coerce.number().int().positive().safe();
export const appointmentIdSchema = z.string().uuid();
export const appointmentIdempotencyKeySchema = z.string().uuid();

export const appointmentRequestSchema = z.object({
  patientId: z.coerce.number().int().positive().safe(),
  departmentId: z.coerce.number().int().positive().safe(),
  requestedAt: eatDateTimeSchema,
  reason: z.string().trim().min(10).max(500),
}).strict();

export const appointmentTransitionSchema = z.object({
  action: z.enum(["confirm", "decline", "cancel"]),
  note: z.string().trim().min(1).max(500).optional(),
}).strict().refine(
  (value) => value.action !== "decline" || Boolean(value.note && value.note.length >= 10),
  { message: "A decline requires a reason of at least 10 characters." },
);

export function eatDateTimeToUtc(value: string): string {
  return new Date(`${value}:00+03:00`).toISOString().slice(0, 19).replace("T", " ");
}
