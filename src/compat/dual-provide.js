import { SERVICE_ALIASES } from './ra-names.js'

const publications = new WeakMap()

/** Publish one value under both owned service names, with one shared disposer. */
export function dualProvide(ctx, suffix, value) {
  const legacyName = `remote-agent:${suffix}`
  const name = SERVICE_ALIASES[legacyName]
  if (!name) throw new TypeError(`unsupported owned service: ${suffix}`)
  if (typeof ctx?.provide !== 'function') {
    ctx?.set?.(legacyName, value)
    ctx?.set?.(name, value)
    return () => {
      ctx?.set?.(name, undefined)
      ctx?.set?.(legacyName, undefined)
    }
  }

  let services = publications.get(ctx)
  if (!services) publications.set(ctx, services = new Map())
  let publication = services.get(suffix)
  const added = []
  let aliasFailure
  try {
    for (const serviceName of [name, legacyName]) {
      try {
        const current = ctx.get?.(serviceName, false)
        if (typeof current === 'undefined') {
          added.push(ctx.provide(serviceName, value))
        } else if (current !== value) {
          ctx.set(serviceName, value)
        }
      } catch (error) {
        if (serviceName !== name) throw error
        // An unavailable alias must not prevent ds-bot's legacy publication.
        aliasFailure = { error }
      }
    }
  } catch (error) {
    for (const dispose of added.reverse()) dispose?.()
    throw error
  }

  if (!publication) {
    const disposers = []
    let disposed = false
    publication = {
      disposers,
      dispose() {
        if (disposed) return
        disposed = true
        services.delete(suffix)
        for (const dispose of disposers.reverse()) dispose?.()
      },
    }
    services.set(suffix, publication)
  }
  publication.disposers.push(...added)
  if (aliasFailure) throw aliasFailure.error
  return publication.dispose
}
