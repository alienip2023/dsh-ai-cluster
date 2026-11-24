// Which DSH this machine runs, for the daemon to supervise. Filled in from the DSH CLI
// facts verified on the real app (phase 0); DSH_BIN always wins.
export function detectDshCommand(env = process.env) {
  if (typeof env.DSH_BIN === 'string' && env.DSH_BIN !== '') return { command: env.DSH_BIN, args: [] }
  return undefined
}
