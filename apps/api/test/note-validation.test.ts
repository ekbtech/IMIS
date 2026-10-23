import { describe, expect, it } from "vitest";
import {
  noteAmendmentSchema,
  noteDraftSchema,
  noteIdempotencyKeySchema,
  noteUuidSchema,
} from "../src/validation/note.js";

describe("controlled clinical note validation", () => {
  it("accepts supported note types and bounded text", () => {
    expect(noteDraftSchema.safeParse({
      noteType: "clinical",
      title: "Consultation note",
      content: "Clinician-authored synthetic note content.",
    }).success).toBe(true);
    expect(noteDraftSchema.safeParse({
      noteType: "prescription",
      title: "Treatment",
      content: "Do this.",
    }).success).toBe(false);
  });

  it("rejects blank, oversized, or unexpected note fields", () => {
    expect(noteDraftSchema.safeParse({ noteType: "clinical", title: " ", content: "text" }).success).toBe(false);
    expect(noteDraftSchema.safeParse({
      noteType: "clinical",
      title: "Title",
      content: "x".repeat(8001),
    }).success).toBe(false);
    expect(noteDraftSchema.safeParse({
      noteType: "clinical",
      title: "Title",
      content: "Note text",
      patientId: 42,
    }).success).toBe(false);
  });

  it("requires a reasoned amendment", () => {
    const note = { noteType: "clinical", title: "Correction", content: "Corrected note content." };
    expect(noteAmendmentSchema.safeParse({ ...note, reason: "Correction of transcription error." }).success).toBe(true);
    expect(noteAmendmentSchema.safeParse({ ...note, reason: "Fix" }).success).toBe(false);
  });

  it("requires UUID resource and idempotency keys", () => {
    expect(noteUuidSchema.safeParse("d9428888-122b-4e09-a6f7-6c8f8a4a9d01").success).toBe(true);
    expect(noteUuidSchema.safeParse("not-a-note-id").success).toBe(false);
    expect(noteIdempotencyKeySchema.safeParse("d9428888-122b-4e09-a6f7-6c8f8a4a9d01").success).toBe(true);
    expect(noteIdempotencyKeySchema.safeParse("retry").success).toBe(false);
  });
});
