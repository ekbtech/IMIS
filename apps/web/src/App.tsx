import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { loginSchema, type LoginValues } from "./login-schema";
import PatientRegistry from "./modules/patients/PatientRegistry";
import OutpatientWorkspace from "./modules/outpatient/OutpatientWorkspace";
import TriageWorkspace from "./modules/triage/TriageWorkspace";
import DepartmentWorkflowWorkspace from "./modules/shared/DepartmentWorkflowWorkspace";
import DepartmentWorkspacePage from "./modules/shared/DepartmentWorkspacePage";
import OrganizationAdministration from "./modules/admin/OrganizationAdministration";
import InventoryWorkspace from "./modules/inventory/InventoryWorkspace";
import MaintenanceWorkspace from "./modules/maintenance/MaintenanceWorkspace";
import AssetsWorkspace from "./modules/assets/AssetsWorkspace";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";
async function apiRequest<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { credentials: "include" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body &&
      typeof body.error === "object" && body.error !== null && "message" in body.error &&
      typeof body.error.message === "string"
      ? body.error.message
      : "The request could not be completed.";
    throw new Error(message);
  }
  return body as T;
}
type User = {
  id: number;
  username: string;
  displayName: string;
  permissions: string[];
  mfaRequired: boolean;
  mfaVerified: boolean;
  mfaEnrolled: boolean;
  mustChangePassword: boolean;
};
type DepartmentWorkspaceSummary = {
  facilityId: number;
  facilityName: string;
  divisionId: number;
  divisionCode: string;
  divisionName: string;
  divisionOrder: number;
  departmentId: number;
  departmentCode: string;
  departmentName: string;
  unitType: string;
  roles: Array<{ roleId: number; roleCode: string; name: string; status: "active" | "inactive" }>;
};
type DivisionSummary = {
  divisionId: number;
  divisionCode: string;
  divisionName: string;
  divisionOrder: number;
};

async function fetchCurrentUser(): Promise<User> {
  const response = await fetch(`${apiBase}/api/v1/auth/me`, { credentials: "include" });
  if (response.status === 401) throw new Error("UNAUTHENTICATED");
  if (!response.ok) throw new Error("The session could not be verified.");
  const body = await response.json() as { user: User };
  return body.user;
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });
  const mutation = useMutation({
    mutationFn: async (values: LoginValues) => {
      const response = await fetch(`${apiBase}/api/v1/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, otp: values.otp || undefined }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "Sign in could not be completed.");
      }
      return response.json() as Promise<{ user: { id: number } }>;
    },
    onSuccess: onSignedIn,
  });

  return (
    <main className="signin-layout">
      <section className="signin-aside" aria-label="System information">
        <div className="brand brand-light">
          <span className="brand-mark">i</span>
          <span>IMIS<span className="brand-dot">.</span></span>
        </div>
        <div className="aside-copy">
          <p className="eyebrow">Integrated care, responsibly</p>
          <h1>One secure workspace for better coordinated care.</h1>
          <p className="aside-description">A modular hospital information system foundation for a Kenyan Level 5 facility.</p>
        </div>
        <div className="aside-footer">
          <span className="status-dot" />
          <span>Development environment · synthetic data only</span>
        </div>
      </section>

      <section className="signin-content">
        <div className="signin-card">
          <div className="mobile-brand brand">
            <span className="brand-mark">i</span>
            <span>IMIS<span className="brand-dot">.</span></span>
          </div>
          <p className="eyebrow">Secure sign in</p>
          <h2>Welcome back</h2>
          <p className="muted">Use your authorized hospital account to continue.</p>

          <form className="signin-form" onSubmit={handleSubmit((values) => mutation.mutate(values))} noValidate>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              autoComplete="username"
              aria-invalid={Boolean(errors.username)}
              aria-describedby={errors.username ? "username-error" : undefined}
              {...register("username")}
            />
            {errors.username && <span className="field-error" id="username-error">{errors.username.message}</span>}

            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "password-error" : undefined}
              {...register("password")}
            />
            {errors.password && <span className="field-error" id="password-error">{errors.password.message}</span>}

            <label htmlFor="otp">Authenticator code <span className="optional-label">if enrolled</span></label>
            <input
              id="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              aria-invalid={Boolean(errors.otp)}
              aria-describedby={errors.otp ? "otp-error" : undefined}
              {...register("otp")}
            />
            {errors.otp && <span className="field-error" id="otp-error">{errors.otp.message}</span>}

            {mutation.isError && (
              <p className="form-error" role="alert">{mutation.error.message}</p>
            )}
            <button className="primary-button" type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Verifying…" : "Sign in"}
              <span aria-hidden="true">→</span>
            </button>
          </form>

          <div className="security-note">
            <span className="lock-icon" aria-hidden="true">⌑</span>
            <p>Access is limited by your assigned role. Activity is audited.</p>
          </div>
          <p className="support-note">Need access? Contact your hospital system administrator.</p>
        </div>
        <footer className="page-footer">IMIS · Phase 1 foundation <span>•</span> Not for clinical use</footer>
      </section>
    </main>
  );
}

function Workspace({ user, onLogout, onRefresh }: { user: User; onLogout: () => void; onRefresh: () => void }) {
  const location = useLocation();
  const departmentWorkspacesQuery = useQuery({
    queryKey: ["department-workspaces"],
    queryFn: () => apiRequest<{
      divisions: DivisionSummary[];
      workspaces: DepartmentWorkspaceSummary[];
      administratorView: boolean;
    }>("/api/v1/departments/workspaces"),
    retry: false,
    enabled: !user.mustChangePassword && !(user.mfaRequired && !user.mfaVerified),
  });
  const departmentRoute = /^\/departments\/(\d+)\/(\d+)$/u.exec(location.pathname);
  const selectedFacilityId = departmentRoute ? Number(departmentRoute[1]) : undefined;
  const selectedDepartmentId = departmentRoute ? Number(departmentRoute[2]) : undefined;
  const canSearchPatients = user.permissions.includes("patient.mpi.search");
  const canRegisterPatients = user.permissions.includes("patient.registration.create");
  const canManageUsers = user.permissions.includes("security.user.manage");
  const canManageRoles = user.permissions.includes("security.role.manage");
  const canRegisterEncounters = user.permissions.includes("encounter.registration.create");
  const canReadEncounterQueue = user.permissions.includes("encounter.queue.read");
  const canReadObservations = user.permissions.includes("encounter.observation.read");
  const canRecordObservations = user.permissions.includes("encounter.observation.record");
  const canReadTriageQueue = user.permissions.includes("triage.queue.read");
  const canCaptureTriage = user.permissions.includes("triage.assessment.capture");
  const canReviewTriage = user.permissions.includes("triage.assessment.review");
  const canReadWorkflowTasks = user.permissions.includes("workflow.task.read");
  const canCreateWorkflowTasks = user.permissions.includes("workflow.task.create");
  const canRespondToWorkflowTasks = user.permissions.includes("workflow.task.respond");
  const canRequestAppointments = user.permissions.includes("appointment.request.create") && canSearchPatients;
  const canReadAppointments = user.permissions.includes("appointment.request.read");
  const canConfirmAppointments = user.permissions.includes("appointment.request.confirm");
  const canUseAppointments = canRequestAppointments || canReadAppointments || canConfirmAppointments;
  const canReadInventory = user.permissions.includes("inventory.stock.read");
  const canManageInventoryCatalog = user.permissions.includes("inventory.catalog.manage");
  const canReceiveInventory = user.permissions.includes("inventory.stock.receive");
  const canIssueInventory = user.permissions.includes("inventory.stock.issue");
  const canUseInventory = canReadInventory || canManageInventoryCatalog || canReceiveInventory || canIssueInventory;
  const canCreateMaintenance = user.permissions.includes("maintenance.request.create");
  const canReadMaintenance = user.permissions.includes("maintenance.request.read");
  const canManageMaintenance = user.permissions.includes("maintenance.request.manage");
  const canUseMaintenance = canCreateMaintenance || canReadMaintenance || canManageMaintenance;
  const canReadAssets = user.permissions.includes("asset.register.read");
  const canManageAssets = user.permissions.includes("asset.register.manage");
  const biomedicalFacilityIds = [...new Set((departmentWorkspacesQuery.data?.workspaces ?? [])
    .filter((workspace) => workspace.departmentCode === "BIOMEDICAL")
    .map((workspace) => workspace.facilityId))];
  const visibleDivisions = (departmentWorkspacesQuery.data?.divisions ?? []).map((division) => ({
    ...division,
    workspaces: (departmentWorkspacesQuery.data?.workspaces ?? [])
      .filter((workspace) => workspace.divisionId === division.divisionId),
  }));

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">i</span><span>IMIS<span className="brand-dot">.</span></span></div>
        <div className="topbar-right">
          <span className="environment-chip"><span className="status-dot" />Development</span>
          <span className="user-label">{user.displayName}</span>
          <button className="text-button" onClick={onLogout}>Sign out</button>
        </div>
      </header>
      {(canManageUsers || canManageRoles) && (
        <nav className="admin-nav" aria-label="Admin navigation">
          <Link className={location.pathname === "/" ? "admin-nav-current" : ""} to="/">Dashboard</Link>
          {canManageUsers && <Link className={location.pathname === "/staff" ? "admin-nav-current" : ""} to="/staff">Staff</Link>}
          {canManageRoles && <Link className={location.pathname === "/organization" ? "admin-nav-current" : ""} to="/organization">Departments</Link>}
        </nav>
      )}
      <div className="workspace-body">
        {user.mustChangePassword ? (
          <PasswordChangeForm onComplete={onRefresh} />
        ) : user.mfaRequired && !user.mfaVerified ? (
          <MfaEnrollment user={user} onComplete={onRefresh} />
        ) : (
          <>
          <aside className="sidebar">
            <p className="sidebar-label">WORKSPACE</p>
            <Link className={`sidebar-link ${location.pathname === "/" ? "sidebar-current" : ""}`} to="/"><span className="sidebar-icon">◫</span> Overview</Link>
            {(canSearchPatients || canRegisterEncounters || canReadEncounterQueue || canReadObservations || canRecordObservations || canReadTriageQueue || canReadWorkflowTasks || canUseInventory || canUseMaintenance || canReadAssets) && <p className="sidebar-label sidebar-label-spaced">WORKFLOWS</p>}
            {canSearchPatients && <Link className={`sidebar-link ${location.pathname === "/patients" ? "sidebar-current" : ""}`} to="/patients"><span className="sidebar-icon">◎</span> Patient identity</Link>}
            {(canRegisterEncounters || canReadEncounterQueue || canReadObservations || canRecordObservations || canUseAppointments) && <Link className={`sidebar-link ${location.pathname === "/outpatient" ? "sidebar-current" : ""}`} to="/outpatient"><span className="sidebar-icon">＋</span> OPD / appointments</Link>}
            {canReadTriageQueue && <Link className={`sidebar-link ${location.pathname === "/triage" ? "sidebar-current" : ""}`} to="/triage"><span className="sidebar-icon">◉</span> Triage</Link>}
            {canReadWorkflowTasks && <Link className={`sidebar-link ${location.pathname === "/workflow" ? "sidebar-current" : ""}`} to="/workflow"><span className="sidebar-icon">⇄</span> Department handovers</Link>}
            {canUseInventory && <Link className={`sidebar-link ${location.pathname === "/inventory" ? "sidebar-current" : ""}`} to="/inventory"><span className="sidebar-icon">▤</span> Stores / inventory</Link>}
            {canUseMaintenance && <Link className={`sidebar-link ${location.pathname === "/maintenance" ? "sidebar-current" : ""}`} to="/maintenance"><span className="sidebar-icon">⚙</span> Biomedical maintenance</Link>}
            {canReadAssets && <Link className={`sidebar-link ${location.pathname === "/assets" ? "sidebar-current" : ""}`} to="/assets"><span className="sidebar-icon">▧</span> Equipment register</Link>}
            {visibleDivisions.length ? (
              <>
                <p className="sidebar-label sidebar-label-spaced">DEPARTMENTS</p>
                {visibleDivisions.map((division) => (
                  <details
                    className="sidebar-department-group"
                    key={division.divisionId}
                    open={division.workspaces.some((workspace) => location.pathname === `/departments/${workspace.facilityId}/${workspace.departmentId}`)}
                  >
                    <summary><span>{division.divisionName}</span><small>{division.workspaces.length}</small></summary>
                    {division.workspaces.map((workspace) => {
                      const path = `/departments/${workspace.facilityId}/${workspace.departmentId}`;
                      return (
                        <Link className={`sidebar-link sidebar-department-link ${location.pathname === path ? "sidebar-current" : ""}`} to={path} key={path}>
                          <span className="sidebar-icon">▧</span>
                          <span>{workspace.departmentName}<small>{workspace.facilityName}</small></span>
                        </Link>
                      );
                    })}
                    {division.workspaces.length === 0 && <p className="sidebar-empty-group">No departments yet</p>}
                  </details>
                ))}
              </>
            ) : departmentWorkspacesQuery.isPending ? (
              <p className="sidebar-empty-group">Loading departments…</p>
            ) : departmentWorkspacesQuery.isError ? (
              <p className="sidebar-error" role="status">Department list unavailable</p>
            ) : null}
            <div className="sidebar-bottom"><span className="status-dot" /> Platform foundation</div>
          </aside>
          {location.pathname === "/patients" ? (
            <main className="main-content"><PatientRegistry canRegister={canRegisterPatients} isSystemAdmin={canManageUsers} /></main>
          ) : location.pathname === "/outpatient" && (canRegisterEncounters || canReadEncounterQueue || canReadObservations || canRecordObservations || canUseAppointments) ? (
            <main className="main-content">
              <OutpatientWorkspace
                canSearchPatients={canSearchPatients}
                canRegisterEncounters={canRegisterEncounters}
                canReadQueue={canReadEncounterQueue}
                canReadObservations={canReadObservations}
                canRecordObservations={canRecordObservations}
                canReadNotes={user.permissions.includes("encounter.note.read")}
                canCreateNotes={user.permissions.includes("encounter.note.create")}
                canSignNotes={user.permissions.includes("encounter.note.sign")}
                canAmendNotes={user.permissions.includes("encounter.note.amend")}
                canReadCareContext={user.permissions.includes("care.context.read")}
                canCreateWorkflowTasks={canCreateWorkflowTasks}
                canRespondToWorkflowTasks={canRespondToWorkflowTasks}
                canRequestAppointments={canRequestAppointments}
                canReadAppointments={canReadAppointments}
                canConfirmAppointments={canConfirmAppointments}
                userId={user.id}
                isSystemAdmin={canManageUsers}
              />
            </main>
          ) : location.pathname === "/staff" && canManageUsers ? (
            <main className="main-content"><StaffProvisioning /></main>
          ) : location.pathname === "/organization" && canManageRoles ? (
            <main className="main-content"><OrganizationAdministration /></main>
          ) : location.pathname === "/triage" && canReadTriageQueue ? (
            <main className="main-content">
              <TriageWorkspace
                canCapture={canCaptureTriage}
                canReview={canReviewTriage}
                canReadCareContext={user.permissions.includes("care.context.read")}
              />
            </main>
          ) : location.pathname === "/workflow" && canReadWorkflowTasks ? (
            <main className="main-content">
              <DepartmentWorkflowWorkspace
                canRespond={canRespondToWorkflowTasks}
                canCreate={canCreateWorkflowTasks}
              />
            </main>
          ) : location.pathname === "/inventory" && canUseInventory ? (
            <main className="main-content">
              <InventoryWorkspace
                isSystemAdmin={canManageUsers}
                canRead={canReadInventory}
                canManageCatalog={canManageInventoryCatalog}
                canReceive={canReceiveInventory}
                canIssue={canIssueInventory}
              />
            </main>
          ) : location.pathname === "/maintenance" && canUseMaintenance ? (
            <main className="main-content">
              <MaintenanceWorkspace
                isSystemAdmin={canManageUsers}
                canCreate={canCreateMaintenance}
                canRead={canReadMaintenance}
                canManage={canManageMaintenance}
                biomedicalFacilityIds={biomedicalFacilityIds}
              />
            </main>
          ) : location.pathname === "/assets" && canReadAssets ? (
            <main className="main-content">
              <AssetsWorkspace
                isSystemAdmin={canManageUsers}
                canRead={canReadAssets}
                canManage={canManageAssets}
              />
            </main>
          ) : selectedFacilityId !== undefined && selectedDepartmentId !== undefined ? (
            <main className="main-content">
              <DepartmentWorkspacePage
                facilityId={selectedFacilityId}
                departmentId={selectedDepartmentId}
                permissions={user.permissions}
                administratorView={departmentWorkspacesQuery.data?.administratorView ?? canManageRoles}
              />
            </main>
          ) : (
          <Dashboard
            user={user}
            divisions={departmentWorkspacesQuery.data?.divisions ?? []}
            workspaces={departmentWorkspacesQuery.data?.workspaces ?? []}
            canManageUsers={canManageUsers}
            canManageRoles={canManageRoles}
            isLoading={departmentWorkspacesQuery.isPending}
            hasLoadError={departmentWorkspacesQuery.isError}
          />
          )}
          </>
        )}
      </div>
    </main>
  );
}

function Dashboard({
  user,
  divisions,
  workspaces,
  canManageUsers,
  canManageRoles,
  isLoading,
  hasLoadError,
}: {
  user: User;
  divisions: DivisionSummary[];
  workspaces: DepartmentWorkspaceSummary[];
  canManageUsers: boolean;
  canManageRoles: boolean;
  isLoading: boolean;
  hasLoadError: boolean;
}) {
  const activeRoleCodes = [...new Set(workspaces.flatMap((workspace) =>
    workspace.roles.filter((role) => role.status === "active").map((role) => role.roleCode),
  ))];
  const mappedDepartmentCount = workspaces.filter((workspace) =>
    workspace.roles.some((role) => role.status === "active"),
  ).length;
  const facilityCount = new Set(workspaces.map((workspace) => workspace.facilityId)).size;
  const divisionCounts = divisions.map((division) => ({
    ...division,
    count: workspaces.filter((workspace) => workspace.divisionId === division.divisionId).length,
  }));
  const maxDivisionCount = Math.max(1, ...divisionCounts.map((division) => division.count));
  const today = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date());

  return (
    <section className="main-content admin-dashboard">
      <div className="dashboard-welcome">
        <div className="dashboard-welcome-copy">
          <p className="eyebrow">HOSPITAL MANAGEMENT</p>
          <h1>Welcome back, {user.displayName}</h1>
          <p>
            {canManageRoles
              ? "Here is an overview of configured departments and staff access."
              : "Here is an overview of the department workspaces available to your role."}
          </p>
          <span className="dashboard-date">{today} <span aria-hidden="true">·</span> Development environment</span>
        </div>
        <div className="dashboard-welcome-art" aria-hidden="true">
          <span className="dashboard-hospital-cross">+</span>
          <span className="dashboard-hospital-name">IMIS</span>
          <span className="dashboard-hospital-caption">Integrated care workspace</span>
        </div>
      </div>

      {hasLoadError && (
        <p className="dashboard-load-error" role="alert">
          Department data could not be loaded. Refresh the page or check your connection before relying on these figures.
        </p>
      )}

      <div className="dashboard-metrics" aria-label="Configured system overview">
        <article className="dashboard-metric">
          <span className="dashboard-metric-icon metric-blue" aria-hidden="true">▦</span>
          <div><span>Department workspaces</span><strong>{isLoading ? "—" : workspaces.length}</strong><small>Configured departments</small></div>
        </article>
        <article className="dashboard-metric">
          <span className="dashboard-metric-icon metric-green" aria-hidden="true">✓</span>
          <div><span>Departments with roles</span><strong>{isLoading ? "—" : mappedDepartmentCount}</strong><small>Active role mappings</small></div>
        </article>
        <article className="dashboard-metric">
          <span className="dashboard-metric-icon metric-purple" aria-hidden="true">♙</span>
          <div><span>Active mapped roles</span><strong>{isLoading ? "—" : activeRoleCodes.length}</strong><small>Across visible departments</small></div>
        </article>
        <article className="dashboard-metric">
          <span className="dashboard-metric-icon metric-teal" aria-hidden="true">⌂</span>
          <div><span>Facilities</span><strong>{isLoading ? "—" : facilityCount}</strong><small>With configured workspaces</small></div>
        </article>
      </div>

      <div className="dashboard-panels">
        <section className="dashboard-panel dashboard-department-chart">
          <div className="dashboard-panel-heading">
            <div><h2>Departments by division</h2><p>Configured department workspaces</p></div>
            {canManageRoles && <Link to="/organization">Manage</Link>}
          </div>
          {isLoading ? <p className="dashboard-empty">Loading division totals…</p> : hasLoadError ? (
            <p className="dashboard-empty">Division totals are unavailable until department data loads.</p>
          ) : (
            <div className="dashboard-group-list">
              {divisionCounts.map((division) => (
                <div className="dashboard-group-row" key={division.divisionId}>
                  <span>{division.divisionName}</span>
                  <span className="dashboard-group-track" aria-hidden="true">
                    <span style={{ width: `${(division.count / maxDivisionCount) * 100}%` }} />
                  </span>
                  <strong>{division.count}</strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="dashboard-panel dashboard-department-overview">
          <div className="dashboard-panel-heading">
            <div><h2>{canManageRoles ? "Department overview" : "Your departments"}</h2><p>Workspace availability and role configuration</p></div>
            {canManageRoles && <Link to="/organization">View all</Link>}
          </div>
          {isLoading ? <p className="dashboard-empty">Loading department workspaces…</p> : hasLoadError ? (
            <p className="dashboard-empty">Department workspaces are unavailable. Try again when the connection is restored.</p>
          ) : workspaces.length === 0 ? (
            <p className="dashboard-empty">No department workspaces are configured for this account yet.</p>
          ) : (
            <div className="dashboard-table-scroll">
              <table className="dashboard-table">
                <thead><tr><th>Department</th><th>Division</th><th>Facility</th><th>Active roles</th><th>Status</th></tr></thead>
                <tbody>
                  {workspaces.slice(0, 8).map((workspace) => {
                    const roleCount = workspace.roles.filter((role) => role.status === "active").length;
                    return (
                      <tr key={`${workspace.facilityId}:${workspace.departmentId}`}>
                        <td>
                          <Link to={`/departments/${workspace.facilityId}/${workspace.departmentId}`}>
                            {workspace.departmentName}
                          </Link>
                        </td>
                        <td>{workspace.divisionName}</td>
                        <td>{workspace.facilityName}</td>
                        <td>{roleCount}</td>
                        <td><span className={`dashboard-status ${roleCount ? "dashboard-status-ready" : "dashboard-status-pending"}`}>
                          {roleCount ? "Configured" : "Roles pending"}
                        </span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {workspaces.length > 8 && <p className="dashboard-table-note">Showing 8 of {workspaces.length} configured departments.</p>}
            </div>
          )}
        </section>

        <section className="dashboard-panel dashboard-shortcuts">
          <div className="dashboard-panel-heading"><div><h2>Administration</h2><p>Manage facility setup and access</p></div></div>
          <div className="dashboard-shortcut-list">
            {canManageUsers && <Link to="/staff"><span className="shortcut-icon">♙</span><span><strong>User management</strong><small>Provision staff accounts with assigned roles</small></span><span aria-hidden="true">→</span></Link>}
            {canManageRoles && <Link to="/organization"><span className="shortcut-icon">▦</span><span><strong>Departments &amp; roles</strong><small>Review department mappings and permissions</small></span><span aria-hidden="true">→</span></Link>}
            {!canManageUsers && !canManageRoles && <p className="dashboard-empty">Administration tools are not assigned to your role.</p>}
          </div>
        </section>

        <section className="dashboard-panel dashboard-environment">
          <div className="dashboard-panel-heading"><div><h2>System status</h2><p>Development foundation</p></div><span className="dashboard-status dashboard-status-foundation">Foundation</span></div>
          <div className="dashboard-environment-note">
            <span className="dashboard-info-icon" aria-hidden="true">i</span>
            <p>This dashboard reports configured departments and roles only. Patient volumes, visits, approvals, alerts, and live clinical activity are not represented here.</p>
          </div>
          <p className="dashboard-safety-note">Synthetic development data only · Not for clinical decision-making</p>
        </section>
      </div>
      <div className="bottom-strip"><span>Signed in as {user.displayName}</span><span>Access is limited to the workflows granted to your role.</span></div>
    </section>
  );
}

function StaffProvisioning() {
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const form = useForm({
    defaultValues: {
      username: "",
      displayName: "",
      temporaryPassword: "",
      roleCode: "",
      facilityId: "",
      departmentCode: "",
    },
  });
  const selectedFacilityId = form.watch("facilityId");
  const selectedDepartmentCode = form.watch("departmentCode");
  const rolesQuery = useQuery({
    queryKey: ["admin-roles", selectedFacilityId, selectedDepartmentCode],
    queryFn: () => {
      const query = new URLSearchParams({ facilityId: selectedFacilityId });
      if (selectedDepartmentCode) query.set("departmentId", String(
        (departmentsQuery.data?.departments ?? []).find((department) => department.department_code === selectedDepartmentCode)?.department_id ?? "",
      ));
      return apiRequest<{ roles: { roleCode: string; name: string; mfaRequired: boolean; departmentRequired: boolean }[] }>(
        `/api/v1/admin/roles?${query.toString()}`,
      );
    },
    enabled: Boolean(selectedFacilityId),
  });
  const facilitiesQuery = useQuery({
    queryKey: ["admin-facilities"],
    queryFn: () => apiRequest<{ facilities: { facility_id: number; name: string }[] }>("/api/v1/admin/facilities"),
  });
  const selectedRoleCode = form.watch("roleCode");
  const departmentsQuery = useQuery({
    queryKey: ["admin-departments", selectedFacilityId],
    queryFn: () => apiRequest<{ departments: { department_id: number; department_code: string; name: string }[] }>(
      `/api/v1/admin/departments?facilityId=${encodeURIComponent(selectedFacilityId)}`,
    ),
    enabled: Boolean(selectedFacilityId),
    retry: false,
  });
  const createUser = useMutation({
    mutationFn: async (values: {
      username: string;
      displayName: string;
      temporaryPassword: string;
      roleCode: string;
      facilityId: string;
      departmentCode: string;
    }) => {
      const response = await fetch(`${apiBase}/api/v1/admin/users`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          facilityId: Number(values.facilityId),
          departmentCode: values.departmentCode,
        }),
      });
      const body = await response.json() as { user?: { username: string; roleCode: string }; mfaRequired?: boolean; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Staff account could not be created.");
      return body;
    },
    onSuccess: (result) => {
      setErrorMessage("");
      setStatusMessage(`Created ${result.user?.username} as ${result.user?.roleCode}. ${result.mfaRequired ? "MFA is required at sign-in." : "MFA enrollment is available to the staff member."}`);
      form.reset({
        username: "",
        displayName: "",
        temporaryPassword: "",
        roleCode: "",
        facilityId: form.getValues("facilityId"),
        departmentCode: "",
      });
    },
    onError: (error) => { setStatusMessage(""); setErrorMessage(error.message); },
  });
  const facilities = facilitiesQuery.data?.facilities ?? [];
  const roles = rolesQuery.data?.roles ?? [];
  const departments = departmentsQuery.data?.departments ?? [];
  const selectedDepartment = departments.find((department) => department.department_code === selectedDepartmentCode);
  const availableRoles = roles.filter((role) => {
    if (!role.departmentRequired) return false;
    if (role.roleCode.startsWith("finance_")) return selectedDepartmentCode === "FINANCE";
    if (["triage_nurse", "triage_clinician"].includes(role.roleCode)) return selectedDepartmentCode === "TRIAGE";
    return true;
  });

  return (
    <section className="security-gate">
      <div className="security-gate-card staff-card">
        <p className="eyebrow">ACCESS ADMINISTRATION</p>
        <h1>Provision staff access</h1>
        <p className="muted">Create individual accounts with a facility, department and role assignment. Department role mappings are enforced during provisioning. System-administrator grants require a separate approved process.</p>
        {facilitiesQuery.isError && <p className="form-error" role="alert">Facility list could not be loaded.</p>}
        {rolesQuery.isError && <p className="form-error" role="alert">Active role list could not be loaded.</p>}
        <form className="signin-form" onSubmit={form.handleSubmit((values) => createUser.mutate(values))}>
          <label htmlFor="staff-username">Username</label>
          <input id="staff-username" autoComplete="off" {...form.register("username", { required: true, minLength: 3, pattern: /^[a-zA-Z0-9._-]+$/u })} />
          <label htmlFor="staff-display-name">Display name</label>
          <input id="staff-display-name" autoComplete="off" {...form.register("displayName", { required: true, minLength: 2 })} />
          <label htmlFor="staff-temp-password">Temporary password</label>
          <input id="staff-temp-password" type="password" autoComplete="new-password" minLength={6} {...form.register("temporaryPassword", { required: true, minLength: 6 })} />
          <label htmlFor="staff-facility">Facility</label>
          <select id="staff-facility" {...form.register("facilityId", {
            required: true,
            onChange: () => {
              form.setValue("departmentCode", "");
              form.setValue("roleCode", "");
            },
          })}>
            <option value="">Choose facility…</option>
            {facilities.map((facility) => <option key={facility.facility_id} value={facility.facility_id}>{facility.name}</option>)}
          </select>
          <label htmlFor="staff-department">Department</label>
          <select id="staff-department" {...form.register("departmentCode", {
            required: true,
            onChange: () => form.setValue("roleCode", ""),
          })}>
            <option value="">Choose department…</option>
            {departments.map((department) => (
              <option key={department.department_id} value={department.department_code}>{department.name}</option>
            ))}
          </select>
          {departmentsQuery.isError && <p className="form-error" role="alert">Department list could not be loaded.</p>}
          {selectedDepartment && (
            <>
              <label htmlFor="staff-role">Role</label>
              <select id="staff-role" {...form.register("roleCode", { required: true })}>
                <option value="">Choose role…</option>
                {availableRoles.map((role) => <option key={role.roleCode} value={role.roleCode}>{role.name}</option>)}
              </select>
              {rolesQuery.isError && <p className="form-error" role="alert">Active roles could not be loaded for this department.</p>}
              {rolesQuery.isSuccess && availableRoles.length === 0 && <p className="muted">No role is mapped to this department yet. Configure an explicit role mapping under Departments and roles first.</p>}
              {rolesQuery.data?.roles.some((role) => role.departmentRequired) && (
                <p className="field-hint">Roles mapped to other departments are excluded. Configure mappings under Departments and roles.</p>
              )}
            </>
          )}
          {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
          {statusMessage && <p className="inline-message" role="status">{statusMessage}</p>}
          <button
            className="primary-button"
            type="submit"
            disabled={createUser.isPending || facilitiesQuery.isPending || rolesQuery.isPending ||
              departmentsQuery.isPending || availableRoles.length === 0 || facilities.length === 0 ||
              departments.length === 0 || !selectedDepartmentCode || !selectedRoleCode}
          >
            {createUser.isPending ? "Creating account…" : "Create staff account"} <span aria-hidden="true">→</span>
          </button>
        </form>
        <p className="support-note">Never share temporary passwords in chat or email. Staff must set a personal password before using protected modules.</p>
      </div>
    </section>
  );
}

function SessionGate() {
  const queryClient = useQueryClient();
  const { data: user, isPending, error, refetch } = useQuery({
    queryKey: ["current-user"],
    queryFn: fetchCurrentUser,
    retry: false,
  });
  const logout = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${apiBase}/api/v1/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error("Sign out could not be completed.");
    },
    onSuccess: async () => {
      queryClient.clear();
      await refetch();
    },
  });

  if (isPending) return <div className="loading-screen" role="status">Checking secure session…</div>;
  if (user) return <Workspace
    user={user}
    onLogout={() => logout.mutate()}
    onRefresh={() => { void queryClient.invalidateQueries({ queryKey: ["current-user"] }); void refetch(); }}
  />;
  if (error instanceof Error && error.message !== "UNAUTHENTICATED") {
    return <div className="loading-screen" role="alert">Unable to connect to the IHIS API. Check that the API service is running.</div>;
  }
  return <SignIn onSignedIn={() => void refetch()} />;
}

function RouteNotFound() {
  return <main className="loading-screen"><p>That workspace route is not available.</p></main>;
}

function PasswordChangeForm({ onComplete }: { onComplete: () => void }) {
  const [formError, setFormError] = useState("");
  const mutation = useMutation({
    mutationFn: async ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) => {
      const response = await fetch(`${apiBase}/api/v1/auth/change-password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) throw new Error(body?.error?.message ?? "Password change could not be completed.");
    },
    onSuccess: onComplete,
  });

  return (
    <section className="security-gate">
      <div className="security-gate-card">
        <p className="eyebrow">ACCOUNT SECURITY</p>
        <h1>Set a new password</h1>
        <p className="muted">Your account was issued a temporary password. Change it before opening any protected workspace.</p>
        <form className="signin-form" onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const currentPassword = String(formData.get("currentPassword") ?? "");
          const newPassword = String(formData.get("newPassword") ?? "");
          if (currentPassword === newPassword) {
            setFormError("Your new password must be different from your temporary password.");
            mutation.reset();
            return;
          }
          setFormError("");
          mutation.mutate({ currentPassword, newPassword });
        }}>
          <label htmlFor="current-password">Temporary password</label>
          <input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required />
          <label htmlFor="new-password">New password</label>
          <input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={6} required />
          <p className="muted">Use at least 6 characters. Choose a unique password and never reuse a shared account password.</p>
          {(formError || mutation.isError) && <p className="form-error" role="alert">{formError || mutation.error?.message || "Password change could not be completed."}</p>}
          <button className="primary-button" type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Updating…" : "Change password"} <span aria-hidden="true">→</span>
          </button>
        </form>
      </div>
    </section>
  );
}

function MfaEnrollment({ user, onComplete }: { user: User; onComplete: () => void }) {
  const [secret, setSecret] = useState("");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [qrCodeError, setQrCodeError] = useState("");
  const [code, setCode] = useState("");
  const [enrollmentStarted, setEnrollmentStarted] = useState(false);
  const setup = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${apiBase}/api/v1/auth/mfa/enrollment/start`, {
        method: "POST",
        credentials: "include",
      });
      const body = await response.json() as { secret?: string; otpauthUri?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "MFA enrollment could not be started.");
      return body;
    },
    onSuccess: (body) => {
      if (body.secret && body.otpauthUri) {
        setSecret(body.secret);
        setOtpauthUri(body.otpauthUri);
      }
      setEnrollmentStarted(true);
    },
  });
  useEffect(() => {
    if (!otpauthUri) return;
    let active = true;
    void QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: "M", margin: 2, width: 220 })
      .then((dataUrl) => {
        if (active) setQrCode(dataUrl);
      })
      .catch(() => {
        if (active) setQrCodeError("The QR code could not be generated. Use the manual setup key below.");
      });
    return () => {
      active = false;
    };
  }, [otpauthUri]);
  const verify = useMutation({
    mutationFn: async () => {
      const endpoint = user.mfaEnrolled ? "/verify" : "/enrollment/verify";
      const response = await fetch(`${apiBase}/api/v1/auth/mfa${endpoint}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "The authenticator code could not be verified.");
    },
    onSuccess: onComplete,
  });

  return (
    <section className="security-gate">
      <div className="security-gate-card">
        <p className="eyebrow">MULTI-FACTOR AUTHENTICATION</p>
        <h1>{user.mfaEnrolled ? "Verify your authenticator" : "Secure your account"}</h1>
        <p className="muted">
          {user.mfaEnrolled
            ? "Enter the current six-digit code from your authenticator app to continue."
            : "This role requires an authenticator app. Enrollment is time-limited and your secret is shown only once."}
        </p>
        {!user.mfaEnrolled && !enrollmentStarted && (
          <button className="primary-button" type="button" disabled={setup.isPending} onClick={() => setup.mutate()}>
            {setup.isPending ? "Preparing enrollment…" : "Start secure enrollment"} <span aria-hidden="true">→</span>
          </button>
        )}
        {setup.isError && <p className="form-error" role="alert">{setup.error.message}</p>}
        {secret && (
          <div className="secret-panel">
            <strong>Scan this QR code with your authenticator app</strong>
            {qrCode && <img className="mfa-qr-code" src={qrCode} alt="Authenticator app enrollment QR code" />}
            {qrCodeError && <p className="form-error" role="alert">{qrCodeError}</p>}
            <p>Keep this enrollment screen private. The setup expires in 10 minutes. Enter the current code below to confirm.</p>
            <details>
              <summary>Can’t scan? Show the setup key</summary>
              <code>{secret}</code>
              <p>Enter this key manually in your authenticator app and keep it private.</p>
            </details>
          </div>
        )}
        {(user.mfaEnrolled || (enrollmentStarted && secret)) && (
          <form className="signin-form" onSubmit={(event) => { event.preventDefault(); verify.mutate(); }}>
            <label htmlFor="mfa-code">Six-digit authenticator code</label>
            <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} required />
            {verify.isError && <p className="form-error" role="alert">{verify.error.message}</p>}
            <button className="primary-button" type="submit" disabled={verify.isPending || !/^\d{6}$/u.test(code)}>
              {verify.isPending ? "Verifying…" : user.mfaEnrolled ? "Verify and continue" : "Enable MFA"} <span aria-hidden="true">→</span>
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<SessionGate />} />
      <Route path="/patients" element={<SessionGate />} />
      <Route path="/outpatient" element={<SessionGate />} />
      <Route path="/staff" element={<SessionGate />} />
      <Route path="/organization" element={<SessionGate />} />
      <Route path="/triage" element={<SessionGate />} />
      <Route path="/workflow" element={<SessionGate />} />
      <Route path="/inventory" element={<SessionGate />} />
      <Route path="/maintenance" element={<SessionGate />} />
      <Route path="/assets" element={<SessionGate />} />
      <Route path="/departments/:facilityId/:departmentId" element={<SessionGate />} />
      <Route path="*" element={<RouteNotFound />} />
    </Routes>
  );
}
