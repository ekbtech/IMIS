import { z } from "zod";

export const workflowEncounterIdSchema = z.string().uuid();
export const workflowTaskIdSchema = z.string().uuid();
export const workflowIdempotencyKeySchema = z.string().uuid();
export const workflowDepartmentIdSchema = z.coerce.number().int().positive().safe();

export const referralDetailsSchema = z.object({
  reason: z.string().trim().min(10).max(500),
  responsibleClinician: z.string().trim().min(2).max(120),
  clinicalContext: z.string().trim().max(300),
}).strict();

export const workflowTaskSchema = z.object({
  sendingDepartmentId: workflowDepartmentIdSchema,
  receivingDepartmentId: workflowDepartmentIdSchema,
  taskType: z.enum(["consultation", "diagnostic", "medication", "procedure", "referral", "handover", "other"]),
  title: z.string().trim().min(3).max(160),
  details: z.string().trim().min(1).max(1000),
}).strict().refine(
  (task) => task.sendingDepartmentId !== task.receivingDepartmentId,
  { message: "Sending and receiving departments must be different." },
).superRefine((task, context) => {
  if (task.taskType !== "referral") return;
  let details: unknown;
  try {
    details = JSON.parse(task.details);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["details"],
      message: "Referral details must include a valid reason, responsible clinician, and clinical context.",
    });
    return;
  }
  const parsedDetails = referralDetailsSchema.safeParse(details);
  if (!parsedDetails.success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["details"],
      message: "Referral details must include a reason of at least 10 characters and a responsible clinician.",
    });
  }
});

export const workflowTransitionSchema = z.object({
  action: z.enum(["accept", "reject", "start", "complete", "cancel"]),
  note: z.string().trim().min(1).max(1000).optional(),
}).strict().refine(
  (transition) => transition.action !== "reject" || Boolean(transition.note && transition.note.length >= 10),
  { message: "A rejection requires a reason of at least 10 characters." },
);

export type WorkflowTaskInput = z.infer<typeof workflowTaskSchema>;
export type WorkflowTransitionInput = z.infer<typeof workflowTransitionSchema>;
