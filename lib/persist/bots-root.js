// bots-root.js — where per-Bot portable state lives (identity, journal, checkpoint).
//
// Default: ~/.dsh/bots. DSH_BOTS_DIR overrides it (tests point it at a temp dir so a
// test run never writes into the user's real home). Resolved on every call, not at
// import time, so an override set after import still applies.
import { homedir } from 'node:os'
import { join } from 'node:path'

export function botsRoot() {
  const override = process.env.DSH_BOTS_DIR
  return typeof override === 'string' && override !== '' ? override : join(homedir(), '.dsh', 'bots')
}
