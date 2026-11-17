/**
 * Hub-side wiring. src/tools, src/http and src/ops (slice 7) and the hub
 * registry/botnet layers do not exist under src/ yet, so this imports the old
 * lib/hub module (named in the slice report) rather than copying it.
 */
export { applyHub, newNodeToken, normalizeConfig, NODE_UPGRADE_PATH, HEALTH_PATH } from '../../lib/hub/index.js'
