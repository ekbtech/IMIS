import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

type Department = {
  department_id: number;
  department_code: string;
  name: string;
  assigned_to_user: number | boolean;
};

type Task = {
  taskId: string;
  encounterId: string;
  recordNumber: string;
  taskType: "consultation" | "diagnostic" | "medication" | "procedure" | "referral" | "handover" | "other";
  title: string;
  details: string;
  sendingDepartment: string;
  receivingDepartment: string;
  status: "requested" | "accepted" | "in_progress" | "completed" | "rejected" | "cancelled";
  requestedBy: string;
  requestedAt: string;
  respondedBy: string | null;
  respondedAt: string | null;
  completedBy: string | null;
  completedAt: string | null;
};

type TaskEvent = {
  type: string;
  previousStatus: string | null;
  status: string;
  note: string | null;
  actor: string;
  occurredAt: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body &&
      typeof body.error === "object" && body.error !== null && "message" in body.error &&
      typeof body.error.message === "string"
      ? body.error.message
      : "The workflow request could not be completed.";
    throw new Error(message);
  }
  return body as T;
}

export default function EncounterWorkflowPanel({
  encounterId,
  facilityId,
  canCreate,
  canRespond,
}: {
  encounterId: string;
  facilityId: number;
  canCreate: boolean;
  canRespond: boolean;
}) {
  const queryClient = useQueryClient();
  const [sourceDepartment, setSourceDepartment] = useState("");
  const [targetDepartment, setTargetDepartment] = useState("");
  const [taskType, setTaskType] = useState<Task["taskType"]>("referral");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [referralReason, setReferralReason] = useState("");
  const [responsibleClinician, setResponsibleClinician] = useState("");
  const [clinicalContext, setClinicalContext] = useState("");
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const departmentsQuery = useQuery({
    queryKey: ["workflow-departments", facilityId],
    queryFn: () => request<{ departments: Department[] }>(
      `/api/v1/workflow/facilities/${facilityId}/departments`,
    ),
    retry: false,
  });
  const tasksQuery = useQuery({
    queryKey: ["workflow-encounter-tasks", encounterId],
    queryFn: () => request<{ tasks: Task[] }>(
      `/api/v1/workflow/encounters/${encodeURIComponent(encounterId)}/tasks`,
    ),
    retry: false,
    refetchInterval: 30_000,
  });
  const departments = departmentsQuery.data?.departments ?? [];
  const assignedDepartments = departments.filter((department) =>
    Boolean(department.assigned_to_user) && department.department_code !== "FINANCE");
  const selectedSource = assignedDepartments.find((department) => String(department.department_id) === sourceDepartment);
  const selectedTarget = departments.find((department) => String(department.department_id) === targetDepartment);
  const availableTargets = departments.filter((department) =>
    String(department.department_id) !== sourceDepartment && department.department_code !== "FINANCE");

  const createTask = useMutation({
    mutationFn: () => request<{ task: Task }>("/api/v1/workflow/encounters/" + encodeURIComponent(encounterId) + "/tasks", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        sendingDepartmentId: Number(sourceDepartment),
        receivingDepartmentId: Number(targetDepartment),
        taskType,
        title: taskType === "referral" ? `Referral to ${selectedTarget?.name ?? "department"}` : title,
        details: taskType === "referral"
          ? JSON.stringify({ reason: referralReason, responsibleClinician, clinicalContext })
          : details,
      }),
    }),
    onSuccess: async (result) => {
      setMessage(`Task sent to ${result.task.receivingDepartment}.`);
      setErrorMessage("");
      setTitle("");
      setDetails("");
      setReferralReason("");
      setResponsibleClinician("");
      setClinicalContext("");
      await queryClient.invalidateQueries({ queryKey: ["workflow-encounter-tasks", encounterId] });
    },
    onError: (error) => {
      setErrorMessage(error.message);
      setMessage("");
    },
  });

  const transition = useMutation({
    mutationFn: ({ taskId, action, note }: { taskId: string; action: string; note?: string }) =>
      request<{ task: Task }>(`/api/v1/workflow/tasks/${encodeURIComponent(taskId)}/transitions`, {
        method: "POST",
        body: JSON.stringify({ action, ...(note ? { note } : {}) }),
      }),
    onSuccess: async (result) => {
      setMessage(`Task ${result.task.status}.`);
      setErrorMessage("");
      await queryClient.invalidateQueries({ queryKey: ["workflow-encounter-tasks", encounterId] });
      await queryClient.invalidateQueries({ queryKey: ["workflow-task-events", result.task.taskId] });
    },
    onError: (error) => {
      setErrorMessage(error.message);
      setMessage("");
    },
  });

  return (
    <section className="workflow-card" aria-labelledby="department-workflow-title">
      <div className="section-title">
        <div>
          <h2 id="department-workflow-title">Department requests and referrals</h2>
          <p>Requests are linked to this encounter and remain open until acknowledged and completed.</p>
        </div>
        <button className="text-button" type="button" onClick={() => void tasksQuery.refetch()}>Refresh</button>
      </div>
      {departmentsQuery.isError && <p className="form-error" role="alert">{departmentsQuery.error.message}</p>}
      {tasksQuery.isError && <p className="form-error" role="alert">{tasksQuery.error.message}</p>}
      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      {message && <p className="inline-message" role="status">{message}</p>}

      {canCreate && (
        <form
          className="triage-form"
          onSubmit={(event) => {
            event.preventDefault();
            createTask.mutate();
          }}
        >
          <h3>Send a department request</h3>
          <div className="triage-fields">
            <label>
              Sending department
              <select value={sourceDepartment} onChange={(event) => {
                setSourceDepartment(event.target.value);
                setTargetDepartment("");
              }} required>
                <option value="">Choose your assigned department…</option>
                {assignedDepartments.map((department) => (
                  <option key={department.department_id} value={department.department_id}>{department.name}</option>
                ))}
              </select>
            </label>
            <label>
              Receiving department
              <select value={targetDepartment} onChange={(event) => setTargetDepartment(event.target.value)} required>
                <option value="">Choose receiving department…</option>
                {availableTargets.map((department) => (
                  <option key={department.department_id} value={department.department_id}>{department.name}</option>
                ))}
              </select>
            </label>
            <label>
              Request type
              <select value={taskType} onChange={(event) => setTaskType(event.target.value as Task["taskType"])}>
                <option value="consultation">Consultation</option>
                <option value="diagnostic">Diagnostic request</option>
                <option value="medication">Medication request</option>
                <option value="procedure">Procedure</option>
                <option value="referral">Referral</option>
                <option value="handover">Handover</option>
                <option value="other">Other</option>
              </select>
            </label>
            {taskType === "referral" ? (
              <>
                <label>
                  Reason for referral
                  <textarea value={referralReason} onChange={(event) => setReferralReason(event.target.value)} minLength={10} maxLength={500} required />
                </label>
                <label>
                  Responsible clinician or receiving team
                  <input value={responsibleClinician} onChange={(event) => setResponsibleClinician(event.target.value)} minLength={2} maxLength={120} required />
                </label>
                <label>
                  Relevant clinical context
                  <textarea value={clinicalContext} onChange={(event) => setClinicalContext(event.target.value)} maxLength={300} />
                </label>
              </>
            ) : (
              <>
                <label>
                  Short title
                  <input value={title} onChange={(event) => setTitle(event.target.value)} minLength={3} maxLength={160} required />
                </label>
                <label>
                  Request details
                  <textarea value={details} onChange={(event) => setDetails(event.target.value)} maxLength={1000} required />
                </label>
              </>
            )}
          </div>
          {!selectedSource && departmentsQuery.isSuccess && <p className="field-hint">A department assignment is required to send a request.</p>}
          <button className="primary-button" type="submit" disabled={
            createTask.isPending || !selectedSource || !selectedTarget ||
            (taskType === "referral"
              ? referralReason.trim().length < 10 || !responsibleClinician.trim()
              : !title.trim() || !details.trim())
          }>
            {createTask.isPending ? "Sending…" : taskType === "referral" ? "Send referral" : "Send request"}
          </button>
        </form>
      )}

      <div className="triage-arrivals">
        {(tasksQuery.data?.tasks ?? []).length === 0 && !tasksQuery.isPending && (
          <p className="muted">No tasks for this encounter are visible to your assigned departments.</p>
        )}
        {tasksQuery.data?.tasks.map((task) => {
          const isReceiving = assignedDepartments.some((department) =>
            department.department_code === task.receivingDepartment);
          const isSending = assignedDepartments.some((department) =>
            department.department_code === task.sendingDepartment);
          return (
            <TaskCard
              key={task.taskId}
              task={task}
              isReceiving={isReceiving}
              isSending={isSending}
              canRespond={canRespond}
              onTransition={(action, note) => transition.mutate({ taskId: task.taskId, action, note })}
              busy={transition.isPending}
            />
          );
        })}
      </div>
    </section>
  );
}

function TaskCard({
  task,
  isReceiving,
  isSending,
  canRespond,
  onTransition,
  busy,
}: {
  task: Task;
  isReceiving: boolean;
  isSending: boolean;
  canRespond: boolean;
  onTransition: (action: string, note?: string) => void;
  busy: boolean;
}) {
  const eventsQuery = useQuery({
    queryKey: ["workflow-task-events", task.taskId],
    queryFn: () => request<{ events: TaskEvent[] }>(`/api/v1/workflow/tasks/${encodeURIComponent(task.taskId)}`),
    retry: false,
  });

  return (
    <article className="triage-arrival">
      <div>
        <strong>{task.title}</strong>
        <p>{task.taskType} · {task.sendingDepartment} → {task.receivingDepartment} · {task.status}</p>
        <p className="workflow-task-details">{formatTaskDetails(task)}</p>
        {eventsQuery.data?.events.map((event, index) => (
          <p className="field-hint" key={`${event.occurredAt}-${index}`}>
            {event.type}: {event.previousStatus ? `${event.previousStatus} → ` : ""}{event.status} · {event.actor} · {new Date(event.occurredAt).toLocaleString()}
            {event.note ? ` · ${event.note}` : ""}
          </p>
        ))}
      </div>
      {canRespond && isReceiving && task.status === "requested" && (
        <div className="triage-actions">
          <button className="text-button" type="button" disabled={busy} onClick={() => onTransition("accept")}>Accept</button>
          <button className="text-button" type="button" disabled={busy} onClick={() => {
            const reason = window.prompt("Provide a reason for rejecting this request (at least 10 characters).");
            if (reason?.trim() && reason.trim().length >= 10) onTransition("reject", reason.trim());
          }}>Reject</button>
        </div>
      )}
      {canRespond && isReceiving && task.status === "accepted" && (
        <div className="triage-actions">
          <button className="text-button" type="button" disabled={busy} onClick={() => onTransition("start")}>Start</button>
          <button className="text-button" type="button" disabled={busy} onClick={() => onTransition("complete")}>Complete</button>
        </div>
      )}
      {canRespond && isReceiving && task.status === "in_progress" && (
        <button className="text-button" type="button" disabled={busy} onClick={() => onTransition("complete")}>Complete</button>
      )}
      {isSending && task.status === "requested" && (
        <button className="text-button" type="button" disabled={busy} onClick={() => onTransition("cancel")}>Cancel request</button>
      )}
      {eventsQuery.isError && <p className="field-hint">Workflow history is unavailable.</p>}
    </article>
  );
}

function formatTaskDetails(task: Task): string {
  if (task.taskType !== "referral") return task.details;
  try {
    const details: unknown = JSON.parse(task.details);
    if (
      typeof details === "object" && details !== null &&
      "reason" in details && typeof details.reason === "string" &&
      "responsibleClinician" in details && typeof details.responsibleClinician === "string" &&
      "clinicalContext" in details && typeof details.clinicalContext === "string"
    ) {
      return [
        `Reason: ${details.reason}`,
        `Responsible clinician/team: ${details.responsibleClinician}`,
        ...(details.clinicalContext ? [`Clinical context: ${details.clinicalContext}`] : []),
      ].join("\n");
    }
  } catch {
    return task.details;
  }
  return task.details;
}
