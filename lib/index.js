// Keep named exports: the Cordis loader needs the namespace to expose Config.
export {
  apply,
  Config,
  ROLE,
  resolveRole,
  resolveRoleDetail,
  applyHub,
  newNodeToken,
  normalizeConfig,
  NODE_UPGRADE_PATH,
  HEALTH_PATH,
} from './plugin/index.js'
