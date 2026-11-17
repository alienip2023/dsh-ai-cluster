import { dualProvide } from '../../src/compat/dual-provide.js'

// Exposes the NodeRegistry instance into the cordis context so ds-bot's
// worker-bridge can retrieve it via ctx.get('remote-agent:registry').
// ctx.provide is the correct API (cordis 4.0.2); ctx.set throws without prior provide.
export function exposeRegistry(ctx, registry) {
  return dualProvide(ctx, 'registry', registry)
}
