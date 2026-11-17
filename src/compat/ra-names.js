/**
 * Name bridge: old `remote-agent:*` services and old `remote_*` tools -> new names.
 * Read-only alias table. Writes nothing, never consults a registry, never throws.
 * The only non-test file that may spell the old names; delete in one step (see
 * REBUILD-ARCH-MODULES.md section 5.3).
 */
const OLD_SERVICE_PREFIX = 'remote-agent:'
const NEW_SERVICE_PREFIX = 'ai-cluster:'

/** The 23 old tool suffixes (REBUILD-ARCH-MODULES.md section 5.1). */
const TOOL_SUFFIXES = Object.freeze([
  'nodes', 'agents', 'task', 'task_batch', 'status', 'handoff', 'manifest', 'pull',
  'cancel', 'interrupt', 'purge', 'selfcheck', 'ls', 'read', 'grep', 'tree',
  'write', 'mkdir', 'move', 'delete', 'ps', 'port', 'kill',
])

export const TOOL_ALIASES = Object.freeze(
  Object.fromEntries(TOOL_SUFFIXES.map((x) => [`remote_${x}`, `cluster_${x}`])),
)

export function resolveServiceName(name) {
  if (typeof name !== 'string' || !name.startsWith(OLD_SERVICE_PREFIX)) return name
  return NEW_SERVICE_PREFIX + name.slice(OLD_SERVICE_PREFIX.length)
}

export function resolveToolName(name) {
  if (typeof name !== 'string') return name
  return Object.prototype.hasOwnProperty.call(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : name
}
