export interface Principal {
  userId: number;
  sessionId: number;
  permissions: ReadonlySet<string>;
  facilityIds: ReadonlySet<number>;
  departmentAssignments: ReadonlySet<string>;
  mfaRequired: boolean;
  mfaVerified: boolean;
  mfaEnrolled: boolean;
  mustChangePassword: boolean;
}

export function hasPermission(principal: Principal, permission: string): boolean {
  return principal.permissions.has(permission);
}

export function canAccessFacility(principal: Principal, facilityId: number): boolean {
  return principal.facilityIds.has(facilityId);
}

export function canAccessDepartment(
  principal: Principal,
  facilityId: number,
  departmentId: number,
): boolean {
  return principal.departmentAssignments.has(`${facilityId}:${departmentId}`);
}

export function canAccessSensitiveRecord(
  principal: Principal,
  requiredPermission: string,
  facilityId: number,
): boolean {
  return hasPermission(principal, requiredPermission) && canAccessFacility(principal, facilityId);
}

export function canUsePermission(principal: Principal, permission: string): boolean {
  return hasPermission(principal, permission) &&
    !principal.mustChangePassword &&
    (!principal.mfaRequired || principal.mfaVerified);
}
