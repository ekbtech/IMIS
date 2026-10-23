import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

type Facility = { facility_id: number; name: string };
type Department = { department_id: number; name: string };
type AssetEvent = {
  type: "registered" | "updated" | "reassigned";
  previousDepartment: string | null;
  department: string;
  changes: Record<string, string[] | string>;
  actor: string;
  occurredAt: string;
};
type Asset = {
  assetId: string;
  departmentId: number;
  department: string;
  assetTag: string;
  name: string;
  category: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  location: string;
  registeredBy: string;
  registeredAt: string;
  updatedBy: string;
  updatedAt: string;
  events: AssetEvent[];
};

type AssetForm = {
  departmentId: string;
  assetTag: string;
  name: string;
  category: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  location: string;
};

const emptyForm: AssetForm = {
  departmentId: "",
  assetTag: "",
  name: "",
  category: "",
  manufacturer: "",
  model: "",
  serialNumber: "",
  location: "",
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body &&
      typeof body.error === "object" && body.error !== null ? body.error : null;
    throw new Error(
      error && "message" in error && typeof error.message === "string"
        ? error.message
        : "The equipment register request could not be completed.",
    );
  }
  return body as T;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function AssetsWorkspace({
  isSystemAdmin,
  canRead,
  canManage,
}: {
  isSystemAdmin: boolean;
  canRead: boolean;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [facilitySelection, setFacilitySelection] = useState("");
  const [form, setForm] = useState<AssetForm>(emptyForm);
  const [editingAssetId, setEditingAssetId] = useState<string>();
  const [feedback, setFeedback] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const facilitiesQuery = useQuery({
    queryKey: ["asset-facilities"],
    queryFn: () => request<{ facilities: Facility[] }>(
      isSystemAdmin ? "/api/v1/admin/facilities" : "/api/v1/facilities",
    ),
    retry: false,
  });
  const facilities = facilitiesQuery.data?.facilities ?? [];
  const facilityId = Number(facilitySelection) || facilities[0]?.facility_id;
  const registerQuery = useQuery({
    queryKey: ["assets", facilityId],
    queryFn: () => request<{ assets: Asset[]; departments: Department[]; truncated: boolean }>(
      `/api/v1/assets/facilities/${facilityId}/assets`,
    ),
    enabled: Boolean(facilityId && canRead),
    retry: false,
    refetchInterval: 30_000,
  });
  const assets = registerQuery.data?.assets ?? [];
  const departments = registerQuery.data?.departments ?? [];
  const saveAsset = useMutation({
    mutationFn: () => request<{ asset: Asset; changed?: boolean }>(
      editingAssetId
        ? `/api/v1/assets/assets/${editingAssetId}`
        : `/api/v1/assets/facilities/${facilityId}/assets`,
      {
        method: editingAssetId ? "PUT" : "POST",
        body: JSON.stringify({
          departmentId: Number(form.departmentId || departments[0]?.department_id),
          ...(editingAssetId ? {} : { assetTag: form.assetTag }),
          name: form.name,
          category: form.category,
          manufacturer: form.manufacturer,
          model: form.model,
          serialNumber: form.serialNumber,
          location: form.location,
        }),
      },
    ),
    onSuccess: async ({ asset, changed }) => {
      setFeedback(editingAssetId && changed === false
        ? `${asset.assetTag} is unchanged.`
        : `${asset.assetTag} ${editingAssetId ? "updated" : "registered"} successfully.`);
      setErrorMessage("");
      setForm(emptyForm);
      setEditingAssetId(undefined);
      await queryClient.invalidateQueries({ queryKey: ["assets", facilityId] });
    },
    onError: (error) => {
      setFeedback("");
      setErrorMessage(error.message);
    },
  });

  const editAsset = (asset: Asset) => {
    setEditingAssetId(asset.assetId);
    setForm({
      departmentId: String(asset.departmentId),
      assetTag: asset.assetTag,
      name: asset.name,
      category: asset.category,
      manufacturer: asset.manufacturer,
      model: asset.model,
      serialNumber: asset.serialNumber,
      location: asset.location,
    });
    setFeedback("");
    setErrorMessage("");
  };

  return (
    <section className="inventory-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">EQUIPMENT AND ASSETS</p>
          <h1>Equipment register</h1>
          <p className="muted">Maintain equipment identifiers and current department/location assignments.</p>
        </div>
      </div>

      <section className="organization-section">
        <div className="section-title"><div><h2>Facility</h2><p>The register shows equipment assigned to your departments.</p></div></div>
        {facilitiesQuery.isError ? <p className="form-error" role="alert">{facilitiesQuery.error.message}</p> : (
          <label className="field-label" htmlFor="asset-facility">
            Facility
            <select
              id="asset-facility"
              value={facilityId ?? ""}
              disabled={facilities.length < 2}
              onChange={(event) => {
                setFacilitySelection(event.target.value);
                setEditingAssetId(undefined);
                setForm(emptyForm);
              }}
            >
              {facilities.map((facility) => <option key={facility.facility_id} value={facility.facility_id}>{facility.name}</option>)}
            </select>
          </label>
        )}
      </section>

      {canManage && (
        <section className="organization-section">
          <div className="section-title">
            <div><h2>{editingAssetId ? "Update equipment record" : "Register equipment"}</h2><p>Asset tags are unique within a facility and cannot be changed after registration.</p></div>
            {editingAssetId && <button className="text-button" type="button" onClick={() => { setEditingAssetId(undefined); setForm(emptyForm); }}>Cancel edit</button>}
          </div>
          {registerQuery.isError && <p className="form-error" role="alert">{registerQuery.error.message}</p>}
          {departments.length > 0 ? (
            <form className="inventory-form" onSubmit={(event) => {
              event.preventDefault();
              saveAsset.mutate();
            }}>
              <label className="field-label" htmlFor="asset-tag">
                Facility asset tag
                <input id="asset-tag" required maxLength={100} disabled={Boolean(editingAssetId)} value={form.assetTag} onChange={(event) => setForm({ ...form, assetTag: event.target.value })} />
              </label>
              <label className="field-label" htmlFor="asset-name">
                Equipment name
                <input id="asset-name" required minLength={2} maxLength={190} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              </label>
              <label className="field-label" htmlFor="asset-category">
                Category
                <input id="asset-category" required minLength={2} maxLength={100} value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
              </label>
              <label className="field-label" htmlFor="asset-department">
                Assigned department
                <select id="asset-department" required value={form.departmentId || departments[0]?.department_id || ""} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}>
                  {departments.map((department) => <option key={department.department_id} value={department.department_id}>{department.name}</option>)}
                </select>
              </label>
              <label className="field-label" htmlFor="asset-location">
                Location
                <input id="asset-location" required minLength={2} maxLength={250} value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} />
              </label>
              <label className="field-label" htmlFor="asset-manufacturer">
                Manufacturer <span className="optional-label">optional</span>
                <input id="asset-manufacturer" maxLength={120} value={form.manufacturer} onChange={(event) => setForm({ ...form, manufacturer: event.target.value })} />
              </label>
              <label className="field-label" htmlFor="asset-model">
                Model <span className="optional-label">optional</span>
                <input id="asset-model" maxLength={120} value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} />
              </label>
              <label className="field-label" htmlFor="asset-serial">
                Serial number <span className="optional-label">optional, encrypted</span>
                <input id="asset-serial" maxLength={100} value={form.serialNumber} onChange={(event) => setForm({ ...form, serialNumber: event.target.value })} />
              </label>
              <button className="primary-button" type="submit" disabled={saveAsset.isPending}>
                {saveAsset.isPending ? "Saving…" : editingAssetId ? "Save equipment changes" : "Register equipment"}
              </button>
            </form>
          ) : !registerQuery.isPending && !registerQuery.isError ? (
            <p className="muted">No assigned active departments are available for the equipment register.</p>
          ) : null}
        </section>
      )}

      {feedback && <p className="status-message" role="status">{feedback}</p>}
      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}

      <section className="organization-section">
        <div className="section-title">
          <div><h2>Registered equipment</h2><p>Current assignment and append-only change history.</p></div>
          <span className="module-count">{assets.length} ASSET{assets.length === 1 ? "" : "S"}</span>
        </div>
        {registerQuery.isPending ? <p className="muted">Loading equipment register…</p> : registerQuery.isError ? (
          <p className="form-error" role="alert">{registerQuery.error.message}</p>
        ) : assets.length === 0 ? (
          <p className="muted">No equipment records are visible for your assigned departments.</p>
        ) : (
          <div className="inventory-table-wrap">
            <table className="inventory-table">
              <thead><tr><th>Asset</th><th>Department / location</th><th>Details</th><th>Last updated</th><th>History</th><th>Action</th></tr></thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.assetId}>
                    <td><strong>{asset.assetTag}</strong><br />{asset.name}</td>
                    <td>{asset.department}<br />{asset.location}</td>
                    <td>{asset.category}<br />{[asset.manufacturer, asset.model].filter(Boolean).join(" · ")}<br /><small>{asset.serialNumber ? `Serial: ${asset.serialNumber}` : "No serial number recorded"}</small></td>
                    <td>{asset.updatedBy}<br /><small>{formatDate(asset.updatedAt)}</small></td>
                    <td>
                      {asset.events.map((event, index) => (
                        <p key={`${event.type}-${event.occurredAt}-${index}`}>
                          <small>{event.type} · {event.actor} · {formatDate(event.occurredAt)}{event.previousDepartment ? ` · ${event.previousDepartment} → ${event.department}` : ""}</small>
                        </p>
                      ))}
                    </td>
                    <td>{canManage && <button className="text-button" type="button" onClick={() => editAsset(asset)}>Edit</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {registerQuery.data?.truncated && <p className="muted">Showing up to 100 assigned assets.</p>}
          </div>
        )}
      </section>
    </section>
  );
}
