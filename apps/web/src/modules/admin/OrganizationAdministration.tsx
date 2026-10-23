import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  departmentGroups,
  hospitalSubgroups,
  type DepartmentGroupCode,
  type HospitalSubgroupCode,
} from "../shared/department-groups";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";
const unitTypes = ["department", "ward", "clinic", "store", "service_unit", "other"] as const;

type Facility = { facility_id: number; name: string };
type Division = {
  division_id: number;
  division_code: string;
  name: string;
  description: string;
  status: "active" | "inactive";
  display_order: number;
};
type Department = {
  department_id: number;
  division_id: number;
  department_code: string;
  department_group: DepartmentGroupCode;
  hospital_subgroup: HospitalSubgroupCode | null;
  name: string;
  status: "active" | "inactive";
  unit_type: typeof unitTypes[number];
  parent_department_id: number | null;
  display_order: number;
};
type Role = {
  roleId: number;
  roleCode: string;
  name: string;
  status: "active" | "inactive";
  mfaRequired: boolean;
  description: string;
  permissionCodes: string[];
  departmentAssignments: Array<{
    facilityId: number;
    departmentId: number;
    departmentCode: string;
    departmentName: string;
  }>;
};
type Permission = { permission_id: number; permission_code: string; description: string };
type OrganizationData = { roles: Role[]; permissions: Permission[] };
type MutationVariables = {
  path: string;
  method: string;
  body: unknown;
  transition?: "department-created" | "role-created" | "role-activated" | "role-deactivated";
};

async function adminRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof result === "object" && result !== null && "error" in result &&
      typeof result.error === "object" && result.error !== null && "message" in result.error &&
      typeof result.error.message === "string"
      ? result.error.message
      : "The organization settings could not be saved.";
    throw new Error(message);
  }
  return result as T;
}

function DepartmentEditor({
  department,
  departments,
  divisions,
  onSave,
}: {
  department: Department;
  departments: Department[];
  divisions: Division[];
  onSave: (id: number, values: Omit<Department, "department_id" | "department_code">) => void;
}) {
  const [status, setStatus] = useState(department.status);
  const [divisionId, setDivisionId] = useState(String(department.division_id));
  const [departmentGroup, setDepartmentGroup] = useState(department.department_group);
  const [hospitalSubgroup, setHospitalSubgroup] = useState<HospitalSubgroupCode>(
    department.hospital_subgroup ?? "other",
  );
  const [unitType, setUnitType] = useState(department.unit_type);
  const [parentId, setParentId] = useState(department.parent_department_id?.toString() ?? "");
  const [displayOrder, setDisplayOrder] = useState(String(department.display_order));
  const [name, setName] = useState(department.name);

  return (
    <details className="organization-editor">
      <summary>Edit</summary>
      <form className="organization-form" onSubmit={(event) => {
        event.preventDefault();
        onSave(department.department_id, {
          division_id: Number(divisionId),
          name,
          status,
          department_group: departmentGroup,
          hospital_subgroup: departmentGroup === "hospital" ? hospitalSubgroup : null,
          unit_type: unitType,
          parent_department_id: parentId ? Number(parentId) : null,
          display_order: Number(displayOrder),
        });
      }}>
        <label>Name<input required minLength={2} maxLength={190} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Division<select required value={divisionId} onChange={(event) => setDivisionId(event.target.value)}>
          {divisions.filter((division) => division.status === "active").map((division) => (
            <option key={division.division_id} value={division.division_id}>{division.name}</option>
          ))}
        </select></label>
        <label>Group<select value={departmentGroup} onChange={(event) => {
          const group = event.target.value as DepartmentGroupCode;
          setDepartmentGroup(group);
          if (group === "hospital" && department.hospital_subgroup === null) setHospitalSubgroup("other");
        }}>
          {departmentGroups.map((group) => <option key={group.code} value={group.code}>{group.label}</option>)}
        </select></label>
        {departmentGroup === "hospital" && <label>Hospital subgroup<select required value={hospitalSubgroup} onChange={(event) => setHospitalSubgroup(event.target.value as HospitalSubgroupCode)}>
          {hospitalSubgroups.map((subgroup) => <option key={subgroup.code} value={subgroup.code}>{subgroup.label}</option>)}
        </select></label>}
        <label>Resource type<select value={unitType} onChange={(event) => setUnitType(event.target.value as typeof unitType)}>
          {unitTypes.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
        </select></label>
        <label>Parent unit<select value={parentId} onChange={(event) => setParentId(event.target.value)}>
          <option value="">No parent</option>
          {departments.filter((item) => item.department_id !== department.department_id && item.status === "active")
            .map((item) => <option key={item.department_id} value={item.department_id}>{item.name}</option>)}
        </select></label>
        <label>Display order<input type="number" min={0} max={65535} value={displayOrder} onChange={(event) => setDisplayOrder(event.target.value)} /></label>
        <label>Status<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="active">Active</option><option value="inactive">Inactive</option>
        </select></label>
        <button className="secondary-button" type="submit">Save department</button>
      </form>
    </details>
  );
}

function DivisionEditor({
  division,
  onSave,
}: {
  division: Division;
  onSave: (id: number, values: Omit<Division, "division_id" | "division_code">) => void;
}) {
  const [name, setName] = useState(division.name);
  const [description, setDescription] = useState(division.description);
  const [status, setStatus] = useState(division.status);
  const [displayOrder, setDisplayOrder] = useState(String(division.display_order));

  return (
    <details className="organization-editor">
      <summary>Edit</summary>
      <form className="organization-form" onSubmit={(event) => {
        event.preventDefault();
        onSave(division.division_id, { name, description, status, display_order: Number(displayOrder) });
      }}>
        <label>Name<input required minLength={2} maxLength={190} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Description<input maxLength={255} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label>Display order<input type="number" min={0} max={65535} value={displayOrder} onChange={(event) => setDisplayOrder(event.target.value)} /></label>
        <label>Status<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="active">Active</option><option value="inactive">Inactive</option>
        </select></label>
        <button className="secondary-button" type="submit">Save division</button>
      </form>
    </details>
  );
}

export default function OrganizationAdministration() {
  const queryClient = useQueryClient();
  const [facilityId, setFacilityId] = useState("");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [createDepartmentGroup, setCreateDepartmentGroup] = useState<DepartmentGroupCode>("hospital");
  const [createHospitalSubgroup, setCreateHospitalSubgroup] = useState<HospitalSubgroupCode>("other");
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const [selectedDepartmentIds, setSelectedDepartmentIds] = useState<number[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [activationSuccess, setActivationSuccess] = useState("");
  const departmentFormRef = useRef<HTMLFormElement>(null);
  const roleFormRef = useRef<HTMLFormElement>(null);
  const activationDialogRef = useRef<HTMLDialogElement>(null);

  const facilitiesQuery = useQuery({
    queryKey: ["admin-facilities"],
    queryFn: () => adminRequest<{ facilities: Facility[] }>("/api/v1/admin/facilities"),
  });
  const divisionsQuery = useQuery({
    queryKey: ["organization-divisions", facilityId],
    queryFn: () => adminRequest<{ divisions: Division[] }>(`/api/v1/admin/config/divisions?facilityId=${encodeURIComponent(facilityId)}`),
    enabled: Boolean(facilityId),
  });
  const departmentsQuery = useQuery({
    queryKey: ["organization-departments", facilityId],
    queryFn: () => adminRequest<{ departments: Department[] }>(`/api/v1/admin/config/departments?facilityId=${encodeURIComponent(facilityId)}`),
    enabled: Boolean(facilityId),
  });
  const organizationQuery = useQuery({
    queryKey: ["organization-roles"],
    queryFn: () => adminRequest<OrganizationData>("/api/v1/admin/config/roles"),
  });
  const roles = organizationQuery.data?.roles ?? [];
  const divisions = divisionsQuery.data?.divisions ?? [];
  const departments = departmentsQuery.data?.departments ?? [];
  const selectedRole = roles.find((role) => role.roleId === selectedRoleId);
  const permissions = (organizationQuery.data?.permissions ?? []).filter(
    (permission) => !["security.role.manage", "security.user.manage"].includes(permission.permission_code),
  );
  const permissionGroups = [...new Set(permissions.map((permission) => permission.permission_code.split(".")[0]))];
  useEffect(() => {
    if (activationSuccess && activationDialogRef.current && !activationDialogRef.current.open) {
      activationDialogRef.current.showModal();
    }
  }, [activationSuccess]);

  const runMutation = useMutation<unknown, Error, MutationVariables>({
    mutationFn: ({ path, method, body }) => adminRequest(path, method, body),
    onSuccess: async (result, variables) => {
      setErrorMessage("");
      setStatusMessage(
        variables.transition === "role-activated"
          ? ""
          : variables.transition === "role-deactivated"
            ? "Role deactivated. Its permissions no longer grant access to assigned users."
            : variables.transition === "department-created"
              ? "Department created. Continue with role setup."
              : variables.transition === "role-created"
                ? "Role created without permissions. Configure permissions to continue."
                : "Organization settings saved.",
      );
      if (variables.transition === "role-activated") {
        setActivationSuccess("Role activated. MFA is required for users assigned to this role.");
      }
      if (variables.transition === "department-created") {
        departmentFormRef.current?.reset();
        setCreateDepartmentGroup("hospital");
        setCreateHospitalSubgroup("other");
        setStep(2);
      }
      if (variables.transition === "role-created") {
        roleFormRef.current?.reset();
        setSelectedDepartmentIds([]);
        const created = result as { roleId?: number };
        if (typeof created.roleId === "number") {
          setSelectedRoleId(created.roleId);
          setStep(3);
        }
      }
      if (variables.transition === "role-activated" || variables.transition === "role-deactivated") {
        setSelectedRoleId(null);
        setSelectedDepartmentIds([]);
        setStep(2);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["organization-departments", facilityId] }),
        queryClient.invalidateQueries({ queryKey: ["organization-divisions", facilityId] }),
        queryClient.invalidateQueries({ queryKey: ["organization-roles"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-roles"] }),
      ]);
    },
    onError: (error) => {
      setStatusMessage("");
      setErrorMessage(error.message);
    },
  });

  function selectRole(roleId: number) {
    setSelectedRoleId(roleId);
    setSelectedDepartmentIds(
      roles.find((role) => role.roleId === roleId)?.departmentAssignments
        .filter((assignment) =>
          assignment.facilityId === Number(facilityId) &&
          departments.some((department) => department.department_id === assignment.departmentId && department.status === "active"),
        )
        .map((assignment) => assignment.departmentId) ?? [],
    );
    setErrorMessage("");
    setStatusMessage("");
    setStep(3);
  }

  return (
    <section className="organization-admin">
      <div className="page-heading">
        <div>
          <p className="eyebrow">ADMIN</p>
          <h1>Departments &amp; roles</h1>
        </div>
      </div>

      <section className="organization-section organization-setup">
        <label className="organization-facility">Facility
          <select
            value={facilityId}
            onChange={(event) => {
              setFacilityId(event.target.value);
              setStep(1);
              setStatusMessage("");
              setErrorMessage("");
            }}
          >
            <option value="">Choose facility…</option>
            {(facilitiesQuery.data?.facilities ?? []).map((facility) => (
              <option key={facility.facility_id} value={facility.facility_id}>{facility.name}</option>
            ))}
          </select>
        </label>

        {facilitiesQuery.isError && <p className="form-error" role="alert">Facility list could not be loaded. Refresh or contact the system administrator.</p>}
        {(departmentsQuery.isError || divisionsQuery.isError || organizationQuery.isError) &&
          <p className="form-error" role="alert">Organization settings could not be loaded. Refresh or contact the system administrator.</p>}
        {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
        {statusMessage && !activationSuccess && <p className="inline-message" role="status">{statusMessage}</p>}

        <ol className="organization-stepper" aria-label="Organization setup steps">
          {[
            { number: 1, title: "Departments", caption: "Facility units" },
            { number: 2, title: "Role", caption: "Choose or create" },
            { number: 3, title: "Permissions", caption: "Review and activate" },
          ].map((item) => (
            <li className={step === item.number ? "organization-step-current" : step > item.number ? "organization-step-complete" : ""} key={item.number}>
              <button
                type="button"
                onClick={() => {
                  if (item.number < step) setStep(item.number as 1 | 2 | 3);
                }}
                disabled={!facilityId || item.number >= step}
                aria-current={step === item.number ? "step" : undefined}
              >
                <span className="organization-step-number">{step > item.number ? "✓" : item.number}</span>
                <span><strong>{item.title}</strong><small>{item.caption}</small></span>
              </button>
            </li>
          ))}
        </ol>

        {!facilityId ? (
          <div className="organization-empty"><strong>Choose a facility to begin</strong></div>
        ) : step === 1 ? (
          <div className="organization-step-content">
            <div className="organization-step-heading">
              <span>STEP 1 OF 3</span>
              <h2>Departments and units</h2>
            </div>
            <section className="organization-division-catalog">
              <div className="organization-existing-heading">
                <div><strong>Divisions</strong><span>Organizational groupings do not grant access or activate services.</span></div>
                <span>{divisions.length} divisions</span>
              </div>
              <form className="organization-form organization-division-create" onSubmit={(event) => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                runMutation.mutate({
                  path: "/api/v1/admin/config/divisions",
                  method: "POST",
                  body: {
                    facilityId: Number(facilityId),
                    divisionCode: String(values.get("divisionCode") ?? ""),
                    name: String(values.get("name") ?? ""),
                    description: String(values.get("description") ?? ""),
                    displayOrder: Number(values.get("displayOrder") ?? 0),
                  },
                });
                event.currentTarget.reset();
              }}>
                <label>Division code<input name="divisionCode" required maxLength={64} pattern="[A-Za-z0-9_]{2,64}" placeholder="e.g. CLINICAL_SERVICES" /></label>
                <label>Division name<input name="name" required minLength={2} maxLength={190} placeholder="e.g. Clinical Services" /></label>
                <label>Description<input name="description" maxLength={255} placeholder="Optional purpose or scope" /></label>
                <label>Display order<input name="displayOrder" type="number" min={0} max={65535} defaultValue={0} /></label>
                <button className="secondary-button" type="submit" disabled={runMutation.isPending}>{runMutation.isPending ? "Saving…" : "Add division"}</button>
              </form>
              <div className="organization-division-list">
                {divisions.map((division) => (
                  <article className="organization-division-row" key={division.division_id}>
                    <div><strong>{division.name}</strong><small>{division.division_code}{division.description ? ` · ${division.description}` : ""}</small></div>
                    <span className={`organization-status organization-status-${division.status}`}>{division.status}</span>
                    <DivisionEditor
                      division={division}
                      onSave={(id, values) => runMutation.mutate({
                        path: `/api/v1/admin/config/divisions/${id}`,
                        method: "PUT",
                        body: {
                          name: values.name,
                          description: values.description,
                          status: values.status,
                          displayOrder: values.display_order,
                        },
                      })}
                    />
                  </article>
                ))}
                {divisions.length === 0 && <p className="dashboard-empty">No divisions configured. Add a division before creating or assigning departments.</p>}
              </div>
            </section>
            <form ref={departmentFormRef} className="organization-form organization-create" onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              runMutation.mutate({
                path: "/api/v1/admin/config/departments",
                method: "POST",
                body: {
                  facilityId: Number(facilityId),
                  divisionId: Number(values.get("divisionId") ?? 0),
                  departmentCode: String(values.get("departmentCode") ?? ""),
                  name: String(values.get("name") ?? ""),
                  departmentGroup: String(values.get("departmentGroup") ?? "hospital"),
                  hospitalSubgroup: values.get("hospitalSubgroup") ? String(values.get("hospitalSubgroup")) : null,
                  unitType: String(values.get("unitType") ?? "department"),
                  parentDepartmentId: values.get("parentDepartmentId") ? Number(values.get("parentDepartmentId")) : null,
                  displayOrder: Number(values.get("displayOrder") ?? 0),
                },
                transition: "department-created",
              });
            }}>
              <label>Division<select name="divisionId" required defaultValue="">
                <option value="">Choose division…</option>
                {divisions.filter((division) => division.status === "active").map((division) => (
                  <option key={division.division_id} value={division.division_id}>{division.name}</option>
                ))}
              </select></label>
              <label>Department code<input name="departmentCode" required maxLength={64} pattern="[A-Za-z0-9_]{2,64}" placeholder="e.g. OPD_WEST" /></label>
              <label>Display name<input name="name" required minLength={2} maxLength={190} placeholder="e.g. West Outpatient Clinic" /></label>
              <label>Group<select name="departmentGroup" value={createDepartmentGroup} onChange={(event) => {
                const group = event.target.value as DepartmentGroupCode;
                setCreateDepartmentGroup(group);
                if (group === "hospital") setCreateHospitalSubgroup("other");
              }}>{departmentGroups.map((group) => <option key={group.code} value={group.code}>{group.label}</option>)}</select></label>
              {createDepartmentGroup === "hospital" && <label>Hospital subgroup<select name="hospitalSubgroup" required value={createHospitalSubgroup} onChange={(event) => setCreateHospitalSubgroup(event.target.value as HospitalSubgroupCode)}>
                {hospitalSubgroups.map((subgroup) => <option key={subgroup.code} value={subgroup.code}>{subgroup.label}</option>)}
              </select></label>}
              <label>Unit type<select name="unitType">{unitTypes.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}</select></label>
              <label>Parent unit<select name="parentDepartmentId"><option value="">No parent</option>{departments.filter((item) => item.status === "active").map((item) => <option key={item.department_id} value={item.department_id}>{item.name}</option>)}</select></label>
              <label>Display order<input name="displayOrder" type="number" min={0} max={65535} defaultValue={0} /></label>
              <button className="primary-button organization-submit" type="submit" disabled={runMutation.isPending || divisions.filter((division) => division.status === "active").length === 0}>
                {runMutation.isPending ? "Saving department…" : "Save department and continue"} <span aria-hidden="true">→</span>
              </button>
            </form>
            <div className="organization-existing">
              <div className="organization-existing-heading"><strong>Current facility catalogue</strong><span>{departments.length} units</span></div>
              <div className="table-scroll">
                <table className="encounter-table organization-table">
                  <thead><tr><th>Code</th><th>Name</th><th>Division</th><th>Group</th><th>Hospital subgroup</th><th>Type</th><th>Parent</th><th>Status</th><th>Manage</th></tr></thead>
                  <tbody>{departments.map((department) => (
                    <tr key={department.department_id}>
                      <td>{department.department_code}</td>
                      <td>{department.name}</td>
                      <td>{divisions.find((division) => division.division_id === department.division_id)?.name ?? "—"}</td>
                      <td>{departmentGroups.find((group) => group.code === department.department_group)?.label ?? "Hospital"}</td>
                      <td>{hospitalSubgroups.find((subgroup) => subgroup.code === department.hospital_subgroup)?.label ?? "—"}</td>
                      <td>{department.unit_type.replaceAll("_", " ")}</td>
                      <td>{departments.find((item) => item.department_id === department.parent_department_id)?.name ?? "—"}</td>
                      <td><span className={`organization-status organization-status-${department.status}`}>{department.status}</span></td>
                      <td><DepartmentEditor
                        department={department}
                        departments={departments}
                        divisions={divisions}
                        onSave={(id, values) => runMutation.mutate({
                          path: `/api/v1/admin/config/departments/${id}`,
                          method: "PUT",
                          body: {
                            divisionId: values.division_id,
                            name: values.name,
                            status: values.status,
                            departmentGroup: values.department_group,
                            hospitalSubgroup: values.hospital_subgroup,
                            unitType: values.unit_type,
                            parentDepartmentId: values.parent_department_id,
                            displayOrder: values.display_order,
                          },
                        })}
                      /></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <button className="text-button organization-continue" type="button" onClick={() => { setStep(2); setStatusMessage(""); }}>
                Continue to roles <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>
        ) : step === 2 ? (
          <div className="organization-step-content">
            <div className="organization-step-heading">
              <span>STEP 2 OF 3</span>
              <h2>Choose or create a role</h2>
              <p>Catalogue roles are inactive until you select permissions in the next step.</p>
            </div>
            {organizationQuery.isPending ? <p className="muted">Loading role catalogue…</p> : (
              <div className="organization-role-picker">
                {roles.filter((role) => role.roleCode !== "system_admin").map((role) => (
                  <button
                    className="organization-role-option"
                    key={role.roleId}
                    type="button"
                    onClick={() => selectRole(role.roleId)}
                  >
                    <strong>{role.name}</strong>
                    <span>{role.roleCode}</span>
                    <span className={`organization-status organization-status-${role.status}`}>{role.status}</span>
                    {role.description && <small>{role.description}</small>}
                    <small>{role.permissionCodes.length} permission{role.permissionCodes.length === 1 ? "" : "s"} configured · MFA {role.mfaRequired ? "required" : "not required"}</small>
                    <span className="organization-role-action">Configure permissions <span aria-hidden="true">→</span></span>
                  </button>
                ))}
              </div>
            )}
            <details className="organization-new-role">
              <summary>Create a new role instead</summary>
              <form ref={roleFormRef} className="organization-form organization-create" onSubmit={(event) => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                runMutation.mutate({
                  path: "/api/v1/admin/config/roles",
                  method: "POST",
                  body: {
                    roleCode: String(values.get("roleCode") ?? ""),
                    name: String(values.get("name") ?? ""),
                    description: String(values.get("description") ?? ""),
                  },
                  transition: "role-created",
                });
              }}>
                <label>Role code<input name="roleCode" required pattern="[a-z][a-z0-9_]{1,63}" placeholder="e.g. outpatient_nurse" /></label>
                <label>Role name<input name="name" required minLength={2} maxLength={190} placeholder="e.g. Outpatient nurse" /></label>
                <label>Description<input name="description" maxLength={255} placeholder="Describe the approved responsibility" /></label>
                <button className="primary-button organization-submit" type="submit" disabled={runMutation.isPending}>
                  {runMutation.isPending ? "Creating role…" : "Create role and continue"} <span aria-hidden="true">→</span>
                </button>
              </form>
            </details>
          </div>
        ) : (
          <div className="organization-step-content">
            <div className="organization-step-heading">
              <span>STEP 3 OF 3</span>
              <h2>Review permissions and activate</h2>
              <p>Select only the permissions approved for this role. Activation requires at least one permission and enforces MFA.</p>
            </div>
            {!selectedRole ? (
              <div className="organization-empty"><strong>Choose a role first</strong><p>Return to the previous step and choose a catalogue role or create a new one.</p>
                <button className="secondary-button" type="button" onClick={() => setStep(2)}>Back to roles</button>
              </div>
            ) : selectedRole.roleCode === "system_admin" ? (
              <div className="notice-card"><div><strong>Protected role</strong><p>The built-in system administrator role and its grants are managed through the separate approved bootstrap process.</p></div></div>
            ) : (
              <>
                <div className="organization-selected-role">
                  <div><span>SELECTED ROLE</span><strong>{selectedRole.name}</strong><small>{selectedRole.roleCode}</small></div>
                  <span className={`organization-status organization-status-${selectedRole.status}`}>{selectedRole.status}</span>
                </div>
                <form className="organization-activation-form" onSubmit={(event) => {
                  event.preventDefault();
                  const values = new FormData(event.currentTarget);
                  const permissionCodes = values.getAll("permissionCode").map(String);
                  if (selectedDepartmentIds.length === 0) {
                    setErrorMessage("Assign this role to at least one active department in the selected facility.");
                    setStatusMessage("");
                    return;
                  }
                  runMutation.mutate({
                    path: `/api/v1/admin/config/roles/${selectedRole.roleId}/activate`,
                    method: "PUT",
                    body: {
                      name: String(values.get("name") ?? ""),
                      description: String(values.get("description") ?? ""),
                      facilityId: Number(facilityId),
                      departmentIds: selectedDepartmentIds,
                      permissionCodes,
                    },
                    transition: "role-activated",
                  });
                }}>
                  <div className="organization-form organization-role-details">
                    <label>Role name<input name="name" required minLength={2} maxLength={190} defaultValue={selectedRole.name} /></label>
                    <label>Description<input name="description" maxLength={255} defaultValue={selectedRole.description} /></label>
                  </div>
                  <fieldset className="organization-department-assignments">
                    <legend>Departments for this role</legend>
                    <p>Select the active departments where staff may be provisioned with this role. This mapping does not grant permissions by itself.</p>
                    {departments.filter((department) => department.status === "active").map((department) => (
                      <label className="organization-permission" key={department.department_id}>
                        <input
                          type="checkbox"
                          checked={selectedDepartmentIds.includes(department.department_id)}
                          onChange={(event) => setSelectedDepartmentIds((current) =>
                            event.target.checked
                              ? [...current, department.department_id]
                              : current.filter((id) => id !== department.department_id),
                          )}
                        />
                        <span><strong>{department.name}</strong><small>{department.department_code} · {department.unit_type.replaceAll("_", " ")}</small></span>
                      </label>
                    ))}
                    {departments.filter((department) => department.status === "active").length === 0 && (
                      <p className="muted">Add an active department in step 1 before activating a role.</p>
                    )}
                  </fieldset>
                  <div className="organization-permissions">
                    <div className="organization-permission-heading">
                      <h3>Available permissions</h3>
                      <p>Protected user and role administration grants are not assignable here.</p>
                    </div>
                    {permissionGroups.map((group) => (
                      <fieldset className="organization-permission-group" key={group}>
                        <legend>{group.replaceAll("_", " ")}</legend>
                        {permissions.filter((permission) => permission.permission_code.startsWith(`${group}.`)).map((permission) => (
                          <label className="organization-permission" key={permission.permission_id}>
                            <input
                              type="checkbox"
                              name="permissionCode"
                              value={permission.permission_code}
                              defaultChecked={selectedRole.permissionCodes.includes(permission.permission_code)}
                            />
                            <span><strong>{permission.permission_code}</strong><small>{permission.description}</small></span>
                          </label>
                        ))}
                      </fieldset>
                    ))}
                  </div>
                  <p className="organization-security-note">Activating grants selected access to every user assigned this role. MFA is mandatory. Verify the permissions against facility policy before continuing.</p>
                  <div className="organization-form-actions">
                    <button className="secondary-button" type="button" onClick={() => setStep(2)}>Back to roles</button>
                    {selectedRole.status === "active" && (
                      <button
                        className="secondary-button organization-deactivate"
                        type="button"
                        disabled={runMutation.isPending}
                        onClick={() => runMutation.mutate({
                          path: `/api/v1/admin/config/roles/${selectedRole.roleId}`,
                          method: "PUT",
                          body: {
                            name: selectedRole.name,
                            description: selectedRole.description,
                            status: "inactive",
                            mfaRequired: true,
                          },
                          transition: "role-deactivated",
                        })}
                      >
                        Deactivate role
                      </button>
                    )}
                    <button className="primary-button organization-submit" type="submit" disabled={runMutation.isPending}>
                      {runMutation.isPending ? "Saving role access…" : selectedRole.status === "active" ? "Save role access" : "Save permissions and activate"} <span aria-hidden="true">→</span>
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        )}
        <dialog
          ref={activationDialogRef}
          className="success-dialog"
          aria-labelledby="role-success-title"
          aria-describedby="role-success-message"
          onClose={() => setActivationSuccess("")}
        >
          {activationSuccess && (
            <>
              <div className="success-dialog-heading">
                <span className="success-dialog-icon" aria-hidden="true">✓</span>
                <div>
                  <p className="form-step-label">ROLE ADMINISTRATION</p>
                  <h2 id="role-success-title">Success</h2>
                </div>
              </div>
              <p id="role-success-message">{activationSuccess}</p>
              <div className="success-dialog-actions">
                <button className="primary-button" type="button" autoFocus onClick={() => activationDialogRef.current?.close()}>
                  Continue
                </button>
              </div>
            </>
          )}
        </dialog>
      </section>
    </section>
  );
}
