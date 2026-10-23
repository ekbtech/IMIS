import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

type Facility = { facility_id: number; name: string };
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
  taskType: string;
  title: string;
  details: string;
  sendingDepartment: string;
  receivingDepartment: string;
  status: "requested" | "accepted" | "in_progress" | "completed" | "rejected" | "cancelled";
  requestedBy: string;
  requestedAt: string;
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

export default function DepartmentWorkflowWorkspace({
  canRespond,
  canCreate,
}: {
  canRespond: boolean;
  canCreate: boolean;
}) {
  const queryClient = useQueryClient();
  const [facilityId, setFacilityId] = useState<number>();
  const [departmentId, setDepartmentId] = useState<number>();
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const facilitiesQuery = useQuery({
    queryKey: ["workflow-assigned-facilities"],
    queryFn: () => request<{ facilities: Facility[] }>("/api/v1/facilities"),
    retry: false,
  });
  const facilities = facilitiesQuery.data?.facilities ?? [];
  const selectedFacility = facilityId ?? facilities[0]?.facility_id;
  const departmentsQuery = useQuery({
    queryKey: ["workflow-departments", selectedFacility],
    queryFn: () => request<{ departments: Department[] }>(
      `/api/v1/workflow/facilities/${selectedFacility}/departments`,
    ),
    enabled: Boolean(selectedFacility),
    retry: false,
  });
  const assignedDepartments = (departmentsQuery.data?.departments ?? []).filter((item) => Boolean(item.assigned_to_user));
  const selectedDepartment = departmentId ?? assignedDepartments[0]?.department_id;
  const tasksQuery = useQuery({
    queryKey: ["workflow-department-tasks", selectedFacility, selectedDepartment],
    queryFn: () => request<{ tasks: Task[]; truncated: boolean }>(
      `/api/v1/workflow/departments/${selectedDepartment}/tasks?facilityId=${selectedFacility}`,
    ),
    enabled: Boolean(selectedFacility && selectedDepartment),
    refetchInterval: 30_000,
    retry: false,
  });
  const transition = useMutation({
    mutationFn: ({ taskId, action, note }: { taskId: string; action: string; note?: string }) =>
      request<{ task: Task }>(`/api/v1/workflow/tasks/${encodeURIComponent(taskId)}/transitions`, {
        method: "POST",
        body: JSON.stringify({ action, ...(note ? { note } : {}) }),
      }),
    onSuccess: async (result) => {
      setErrorMessage("");
      setStatusMessage(`Task ${result.task.status}.`);
      await queryClient.invalidateQueries({ queryKey: ["workflow-department-tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["workflow-task-history", result.task.taskId] });
    },
    onError: (error) => {
      setStatusMessage("");
      setErrorMessage(error.message);
    },
  });

  if (facilitiesQuery.isPending) return <p className="muted">Loading assigned facilities…</p>;
  if (facilitiesQuery.isError) return <p className="form-error" role="alert">{facilitiesQuery.error.message}</p>;

  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SHARED WORKFLOW</p>
          <h1>Department handovers</h1>
          <p className="muted">Receive, acknowledge and complete requests routed by other hospital departments.</p>
        </div>
        {facilities.length > 1 && (
          <select aria-label="Facility" value={selectedFacility ?? ""} onChange={(event) => {
            setFacilityId(Number(event.target.value));
            setDepartmentId(undefined);
          }}>
            {facilities.map((facility) => <option key={facility.facility_id} value={facility.facility_id}>{facility.name}</option>)}
          </select>
        )}
      </div>
      <div className="notice-card">
        <span className="notice-icon">i</span>
        <div><strong>Workflow routing only</strong><p>Tasks do not place laboratory orders, dispense medicine, diagnose, or record completed clinical procedures. Use only according to approved department procedures.</p></div>
      </div>
      {departmentsQuery.isError && <p className="form-error" role="alert">{departmentsQuery.error.message}</p>}
      {assignedDepartments.length > 1 && (
        <label className="workflow-card">
          Department
          <select value={selectedDepartment ?? ""} onChange={(event) => setDepartmentId(Number(event.target.value))}>
            {assignedDepartments.map((department) => (
              <option key={department.department_id} value={department.department_id}>{department.name}</option>
            ))}
          </select>
        </label>
      )}
      {assignedDepartments.length === 0 && departmentsQuery.isSuccess && (
        <p className="muted">This account has no active department assignment.</p>
      )}
      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      {statusMessage && <p className="inline-message" role="status">{statusMessage}</p>}
      {tasksQuery.isPending && selectedDepartment && <p className="muted">Loading department tasks…</p>}
      {tasksQuery.isError && <p className="form-error" role="alert">{tasksQuery.error.message}</p>}
      {(tasksQuery.data?.tasks ?? []).length === 0 && !tasksQuery.isPending && selectedDepartment && (
        <p className="muted">No tasks are currently visible to this department.</p>
      )}
      <div className="triage-arrivals">
        {tasksQuery.data?.tasks.map((task) => (
          <TaskInboxCard
            key={task.taskId}
            task={task}
            departmentCode={assignedDepartments.find((department) => department.department_id === selectedDepartment)?.department_code ?? ""}
            canRespond={canRespond}
            canCreate={canCreate}
            busy={transition.isPending}
            onTransition={(action, note) => transition.mutate({ taskId: task.taskId, action, note })}
          />
        ))}
      </div>
      {tasksQuery.data?.truncated && <p className="field-hint">Showing the latest 100 tasks.</p>}
    </section>
  );
}

function TaskInboxCard({
  task,
  departmentCode,
  canRespond,
  canCreate,
  busy,
  onTransition,
}: {
  task: Task;
  departmentCode: string;
  canRespond: boolean;
  canCreate: boolean;
  busy: boolean;
  onTransition: (action: string, note?: string) => void;
}) {
  const historyQuery = useQuery({
    queryKey: ["workflow-task-history", task.taskId],
    queryFn: () => request<{ events: TaskEvent[] }>(`/api/v1/workflow/tasks/${encodeURIComponent(task.taskId)}`),
    retry: false,
  });
  const isReceiving = task.receivingDepartment === departmentCode;
  const isSending = task.sendingDepartment === departmentCode;
  return (
    <article className="triage-arrival">
      <div>
        <strong>{task.title}</strong>
        <p>{task.recordNumber} · {task.taskType} · {task.sendingDepartment} → {task.receivingDepartment} · {task.status}</p>
        <p>{task.details}</p>
        <p className="field-hint">Requested by {task.requestedBy} · {new Date(task.requestedAt).toLocaleString()}</p>
        {historyQuery.data?.events.map((event, index) => (
          <p className="field-hint" key={`${event.occurredAt}-${index}`}>
            {event.type}: {event.previousStatus ? `${event.previousStatus} → ` : ""}{event.status}
            {" · "}{event.actor} · {new Date(event.occurredAt).toLocaleString()}
            {event.note ? ` · ${event.note}` : ""}
          </p>
        ))}
        {historyQuery.isError && <p className="field-hint">Task event history is unavailable.</p>}
      </div>
      {canRespond && isReceiving && task.status === "requested" && (
        <div className="triage-actions">
          <button className="text-button" type="button" disabled={busy} onClick={() => onTransition("accept")}>Accept</button>
          <button className="text-button" type="button" disabled={busy} onClick={() => {
            const reason = window.prompt("Provide a rejection reason (at least 10 characters).");
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
      {canCreate && isSending && task.status === "requested" && (
        <button className="text-button" type="button" disabled={busy} onClick={() => onTransition("cancel")}>Cancel request</button>
      )}
    </article>
  );
}
