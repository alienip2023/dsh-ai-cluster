import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Strict fake ctx: duplicate provide throws, like the real host. */
export function makeCtx() {
  const services = new Map()
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ai-plugin-'))
  return {
    services,
    stateDir,
    logger: { info() {}, warn() {} },
    provide(name, value) {
      if (services.has(name)) throw new Error(`service "${name}" has been registered`)
      services.set(name, value)
      return () => { services.delete(name) }
    },
    get(name) { return services.get(name) },
    inject(name) { return services.get(name) },
    cleanup() { rmSync(stateDir, { recursive: true, force: true }) },
  }
}
