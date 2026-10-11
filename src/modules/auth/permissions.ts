import type { Role } from '../../domain/types';

/** Role-based permission matrix (single source of truth; unit-tested). */
export const PERMISSIONS = {
  'events:ingest': ['ADMIN', 'SERVICE'],
  'events:read': ['ADMIN', 'OPERATOR', 'SERVICE'],
  'taxonomy:read': ['ADMIN', 'OPERATOR', 'SERVICE', 'USER'],
  'notifications:read:any': ['ADMIN', 'OPERATOR'],
  'notifications:read:own': ['USER'],
  'notifications:act:own': ['USER'],
  'users:create': ['ADMIN', 'SERVICE'],
  'users:read': ['ADMIN', 'OPERATOR', 'SERVICE'],
  'users:write': ['ADMIN', 'SERVICE'],
  'users:anonymize': ['ADMIN'],
  'preferences:read:any': ['ADMIN', 'OPERATOR', 'SERVICE'],
  'preferences:write:any': ['ADMIN', 'SERVICE'],
  'consent:read:any': ['ADMIN', 'OPERATOR', 'SERVICE'],
  'consent:write:any': ['ADMIN', 'SERVICE'],
  'compliance:read': ['ADMIN', 'OPERATOR'],
  'dnd:import': ['ADMIN'],
  'dnd:lookup': ['ADMIN', 'OPERATOR'],
  'templates:read': ['ADMIN', 'OPERATOR', 'SERVICE'],
  'templates:write': ['ADMIN'],
  'delivery:read': ['ADMIN', 'OPERATOR'],
  'dlq:read': ['ADMIN', 'OPERATOR'],
  'dlq:retry': ['ADMIN', 'OPERATOR'],
  'dlq:resolve': ['ADMIN', 'OPERATOR'],
  'dlq:discard': ['ADMIN'],
  'ops:read': ['ADMIN', 'OPERATOR'],
  'ops:write': ['ADMIN'],
  'analytics:read': ['ADMIN', 'OPERATOR'],
  'audit:read': ['ADMIN'],
  'auth:user-token': ['ADMIN', 'SERVICE'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  const allowed: readonly Role[] = PERMISSIONS[permission];
  return roles.some((r) => allowed.includes(r));
}
