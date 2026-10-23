import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { departmentGroups } from "./department-groups";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

type Workspace = {
  facilityId: number;
  facilityName: string;
  departmentId: number;
  departmentGroup: typeof departmentGroups[number]["code"];
  departmentCode: string;
  departmentName: string;
  unitType: string;
  roles: Array<{ roleId: number; roleCode: string; name: string; status: "active" | "inactive" }>;
};

async function fetchWorkspace(facilityId: number, departmentId: number): Promise<Workspace> {
  const response = await fetch(
    `${apiBase}/api/v1/departments/workspaces/${facilityId}/${departmentId}`,
    { credentials: "include" },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body &&
      typeof body.error === "object" && body.error !== null && "message" in body.error &&
      typeof body.error.message === "string"
      ? body.error.message
      : "The department workspace could not be loaded.";
    throw new Error(message);
  }
  return (body as { workspace: Workspace }).workspace;
}

export default function DepartmentWorkspacePage({
  facilityId,
  departmentId,
  permissions,
  administratorView,
}: {
  facilityId: number;
  departmentId: number;
  permissions: string[];
  administratorView: boolean;
}) {
  const workspaceQuery = useQuery({
    queryKey: ["department-workspace", facilityId, departmentId],
    queryFn: () => fetchWorkspace(facilityId, departmentId),
    retry: false,
  });
  const workspace = workspaceQuery.data;
  const availableWorkflows = [
    {
      label: "Patient identity",
      path: "/patients",
      icon: "◎",
      available: permissions.includes("patient.mpi.search"),
      description: "Search and register patient identities.",
    },
    {
      label: "OPD and observations",
      path: "/outpatient",
      icon: "＋",
      available: permissions.some((permission) => [
        "encounter.registration.create",
        "encounter.queue.read",
        "encounter.observation.read",
        "encounter.observation.record",
      ].includes(permission)),
      description: "Available outpatient and encounter workflows.",
    },
    {
      label: "Appointments",
      path: "/outpatient",
      icon: "▦",
      available: permissions.some((permission) => [
        "appointment.request.create",
        "appointment.request.read",
        "appointment.request.confirm",
      ].includes(permission)),
      description: "Request, review, and respond to appointment requests.",
    },
    {
      label: "Triage",
      path: "/triage",
      icon: "◉",
      available: permissions.includes("triage.queue.read"),
      description: "The configured triage capture and review workflow.",
    },
    {
      label: "Department handovers",
      path: "/workflow",
      icon: "⇄",
      available: permissions.includes("workflow.task.read"),
      description: "Route and track generic interdepartmental tasks.",
    },
    {
      label: "Stores and inventory",
      path: "/inventory",
      icon: "▤",
      available: permissions.includes("inventory.stock.read"),
      description: "Record facility stock receipts and issues with batch-level balances.",
    },
    {
      label: "Biomedical maintenance",
      path: "/maintenance",
      icon: "⚙",
      available: permissions.some((permission) => [
        "maintenance.request.create",
        "maintenance.request.read",
        "maintenance.request.manage",
      ].includes(permission)),
      description: "Report equipment faults or manage the Biomedical Engineering request queue.",
    },
    {
      label: "Equipment register",
      path: "/assets",
      icon: "▧",
      available: permissions.includes("asset.register.read"),
      description: "Review registered equipment assigned to your departments.",
    },
  ].filter((workflow) => workflow.available);

  if (workspaceQuery.isPending) return <p className="muted">Loading department workspace…</p>;
  if (workspaceQuery.isError) return <p className="form-error" role="alert">{workspaceQuery.error.message}</p>;
  if (!workspace) return <p className="form-error" role="alert">The department workspace is unavailable.</p>;

  const activeRoles = workspace.roles.filter((role) => role.status === "active");
  const inactiveRoles = workspace.roles.filter((role) => role.status === "inactive");
  const departmentGroup = departmentGroups.find((group) => group.code === workspace.departmentGroup)?.label ?? "Hospital";

  return (
    <section className="department-page">
      <div className="dashboard-welcome department-dashboard-welcome">
        <div className="dashboard-welcome-copy">
          <p className="eyebrow">{workspace.facilityName} · {workspace.departmentCode}</p>
          <h1>{workspace.departmentName}</h1>
          <p>{departmentGroup} · {workspace.unitType.replaceAll("_", " ")} workspace</p>
          <span className="dashboard-date">{administratorView ? "Administrator view" : "Assigned department"} <span aria-hidden="true">·</span> Available workflows are based on your permissions</span>
        </div>
        <div className="dashboard-welcome-art" aria-hidden="true">
          <span className="dashboard-hospital-cross">+</span>
          <span className="dashboard-hospital-name">{workspace.departmentCode}</span>
          <span className="dashboard-hospital-caption">Department workspace</span>
        </div>
      </div>

      <div className="dashboard-metrics department-dashboard-metrics" aria-label="Department overview">
        <article className="dashboard-metric">
          <span className="dashboard-metric-icon metric-green" aria-hidden="true">✓</span>
          <div><span>Active roles</span><strong>{activeRoles.length}</strong><small>Mapped to this department</small></div>
        </article>
        <article className="dashboard-metric">
          <span className="dashboard-metric-icon metric-blue" aria-hidden="true">▦</span>
          <div><span>Available workflows</span><strong>{availableWorkflows.length}</strong><small>Enabled by your permissions</small></div>
        </article>
        <article className="dashboard-metric">
          <span className="dashboard-metric-icon metric-purple" aria-hidden="true">⌂</span>
          <div><span>Department group</span><strong className="department-metric-text">{departmentGroup}</strong><small>{workspace.unitType.replaceAll("_", " ")}</small></div>
        </article>
      </div>

      <div className="dashboard-panels department-dashboard-panels">
        <section className="dashboard-panel department-workflows-section">
          <div className="dashboard-panel-heading">
            <div><h2>Available workflows</h2><p>Only implemented workflows allowed by your role are shown.</p></div>
          </div>
          {availableWorkflows.length > 0 ? (
            <div className="dashboard-shortcut-list department-workflow-list">
              {availableWorkflows.map((workflow) => (
                <Link to={workflow.path} key={workflow.label}>
                  <span className="shortcut-icon" aria-hidden="true">{workflow.icon}</span>
                  <span><strong>{workflow.label}</strong><small>{workflow.description}</small></span>
                  <span aria-hidden="true">→</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="dashboard-empty">There are no implemented operational workflows available to your account in this workspace.</p>
          )}
        </section>

        <section className="dashboard-panel department-roles-section">
          <div className="dashboard-panel-heading">
            <div><h2>Department roles</h2><p>{administratorView ? "All mapped roles, including inactive catalogue entries." : "Active roles assigned to your account in this department."}</p></div>
            <span className="module-count">{workspace.roles.length} ROLE{workspace.roles.length === 1 ? "" : "S"}</span>
          </div>
          {workspace.roles.length > 0 ? (
            <div className="department-role-grid">
              {workspace.roles.map((role) => (
                <article className="department-role-card" key={role.roleId}>
                  <span className={`organization-status organization-status-${role.status}`}>{role.status}</span>
                  <h3>{role.name}</h3>
                  <code>{role.roleCode}</code>
                </article>
              ))}
            </div>
          ) : (
            <p className="dashboard-empty">No active role is currently assigned here. An administrator can configure role mappings.</p>
          )}
          {inactiveRoles.length > 0 && (
            <p className="dashboard-table-note">{inactiveRoles.length} inactive role{inactiveRoles.length === 1 ? "" : "s"} shown for administrator review.</p>
          )}
        </section>
      </div>

      <div className="notice-card department-dashboard-notice">
        <span className="notice-icon">i</span>
        <div>
          <strong>Department-specific operations are being delivered in phases</strong>
          <p>Role mapping and access-aware navigation are available. Department assignments do not yet scope every existing patient or clinical API; those remain permission- and facility-scoped. Other operational services are not enabled until their approved workflows are implemented and validated.</p>
        </div>
      </div>
    </section>
  );
}
