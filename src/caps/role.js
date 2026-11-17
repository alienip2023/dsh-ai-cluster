import { dualProvide } from '../compat/dual-provide.js'

export const ROLE_SERVICE = 'ai-cluster:role'

/**
 * Surface the resolved role to other plugins. Least privilege: anything that
 * is not explicitly hub/both is surfaced as "worker" — an unconfigured or
 * unreadable role must never hand another plugin hub powers.
 */
export function exposeRole(ctx, role) {
  const value = role === 'hub' || role === 'both' ? role : 'worker'
  return dualProvide(ctx, 'role', value)
}
