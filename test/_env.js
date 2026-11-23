// Preloaded by `npm test` (node --import). Points per-Bot portable state at a temp dir
// so no test ever writes journals/identities into the user's real ~/.dsh/bots.
// Set once in the runner process; every test subprocess inherits the env var.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.DSH_BOTS_DIR) process.env.DSH_BOTS_DIR = mkdtempSync(join(tmpdir(), 'dsh-bots-test-'))
