import { describe, expect, it } from "vitest";
import { workflowTaskSchema } from "../src/validation/workflow.js";

const referralTask = {
  sendingDepartmentId: 1,
  receivingDepartmentId: 2,
  taskType: "referral",
  title: "Referral to cardiology",
  details: JSON.stringify({
    reason: "Requires specialist review of persistent symptoms.",
    responsibleClinician: "Cardiology team",
    clinicalContext: "Seen in outpatient clinic.",
  }),
};

describe("department workflow validation", () => {
  it("accepts a structured referral with its required clinical routing fields", () => {
    expect(workflowTaskSchema.safeParse(referralTask).success).toBe(true);
  });

  it("rejects referrals with malformed or incomplete structured details", () => {
    expect(workflowTaskSchema.safeParse({ ...referralTask, details: "free text" }).success).toBe(false);
    expect(workflowTaskSchema.safeParse({
      ...referralTask,
      details: JSON.stringify({ reason: "short", responsibleClinician: "", clinicalContext: "" }),
    }).success).toBe(false);
  });

  it("keeps existing non-referral task details as free text", () => {
    expect(workflowTaskSchema.safeParse({
      ...referralTask,
      taskType: "handover",
      title: "Shift handover",
      details: "Please review the patient during the next round.",
    }).success).toBe(true);
  });
});
