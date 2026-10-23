import { z } from "zod";

const noteFields = {
  noteType: z.enum(["clinical", "nursing", "handover", "other"]),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(8000),
};

export const noteDraftSchema = z.object(noteFields).strict();
export const noteAmendmentSchema = z.object({
  ...noteFields,
  reason: z.string().trim().min(10).max(1000),
}).strict();
export const noteSignSchema = z.object({}).strict();
export const noteUuidSchema = z.string().uuid();
export const noteIdempotencyKeySchema = z.string().uuid();

export type NoteDraft = z.infer<typeof noteDraftSchema>;
export type NoteAmendment = z.infer<typeof noteAmendmentSchema>;
