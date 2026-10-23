import { z } from "zod";

const measurement = z.number()
  .finite()
  .refine((value) => Number(value.toFixed(2)) === value, "Use no more than two decimal places.")
  .min(0);

export const observationRecordSchema = z.object({
  systolicBpMmhg: measurement.max(1000).optional(),
  diastolicBpMmhg: measurement.max(1000).optional(),
  pulseBpm: measurement.max(1000).optional(),
  respiratoryRateBpm: measurement.max(1000).optional(),
  temperatureCelsius: z.number().finite().min(-100).max(200).optional(),
  oxygenSaturationPercent: measurement.max(100).optional(),
  weightKg: measurement.max(99999.99).optional(),
  heightCm: measurement.max(9999.99).optional(),
}).strict().refine((values) => Object.values(values).some((value) => value !== undefined), {
  message: "Record at least one measurement.",
}).refine((values) =>
  (values.systolicBpMmhg === undefined) === (values.diastolicBpMmhg === undefined),
{
  message: "Record both systolic and diastolic blood pressure values.",
  path: ["systolicBpMmhg"],
});

export const encounterUuidSchema = z.string().uuid();
export const observationIdempotencyKeySchema = z.string().uuid();

export type ObservationRecord = z.infer<typeof observationRecordSchema>;
