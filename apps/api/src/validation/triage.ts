import { z } from "zod";
import { observationRecordSchema } from "./observation.js";

export const triageFacilitySchema = z.object({
  facilityId: z.coerce.number().int().positive(),
});

export const triageObservationSchema = observationRecordSchema;
export const triageAssessmentUuidSchema = z.string().uuid();
export const triageIdempotencyKeySchema = z.string().uuid();
export const triageReviewSchema = z.object({}).strict();

export type TriageObservation = z.infer<typeof triageObservationSchema>;
