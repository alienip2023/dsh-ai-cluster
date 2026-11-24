// Which DSH this machine runs, for the daemon to supervise.
// Priority: DSH_BIN env > App CLI > CLI install. Returns { command, args } or undefined.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Candidates in preference order. */
function platformCandidates(platform = process.platform) {
  if (platform === 'darwin') {
    return [
      '/Applications/DeepSeek Harness.app/Contents/Resources/dsh-cli/dsh',
      '/Applications/DeepSeek Harness.app/Contents/MacOS/dsh',
      join(homedir(), 'Applications/DeepSeek Harness.app/Contents/Resources/dsh-cli/dsh'),
      '/usr/local/bin/dsh',
      '/opt/homebrew/bin/dsh',
    ]
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return [
      join(localAppData, 'Programs', 'DeepSeek Harness', 'dsh.exe'),
      join(localAppData, 'DeepSeek Harness', 'dsh.exe'),
      'dsh.exe',
    ]
  }
  // Linux / others
  return [
    join(homedir(), '.local', 'share', 'deepseek-harness', 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ]
}

/**
 * Detect which DSH command to supervise.
 * @param {object} [env] defaults to process.env
 * @param {string} [platform] defaults to process.platform
 * @returns {{ command: string, args: string[] } | undefined}
 */
export function detectDshCommand(env = process.env, platform = process.platform) {
  // DSH_BIN always wins.
  if (typeof env.DSH_BIN === 'string' && env.DSH_BIN !== '') return { command: env.DSH_BIN, args: [] }
  for (const candidate of platformCandidates(platform)) {
    try {
      if (existsSync(candidate)) return { command: candidate, args: [] }
    } catch { /* access denied — skip */ }
  }
  return undefined
}

/**
 * Autostart installation: returns the shell commands to install a user-level
 * autostart entry for the daemon on the current platform, as an array of
 * human-readable lines (the user runs them once). Does not write anything.
 * @param {{ daemonScript: string, nodeCommand: string, platform?: string }} opts
 * @returns {string[]} Lines the user should run, or [] if unsupported.
 */
export function autostartInstructions({ daemonScript, nodeCommand, platform = process.platform }) {
  if (platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.deepseek.dsh-node-daemon.plist')
    return [
      `# macOS: install launchd user agent`,
      `cat > "${plist}" << 'EOF'`,
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0"><dict>`,
      `  <key>Label</key><string>com.deepseek.dsh-node-daemon</string>`,
      `  <key>ProgramArguments</key><array>`,
      `    <string>${nodeCommand}</string>`,
      `    <string>${daemonScript}</string>`,
      `  </array>`,
      `  <key>RunAtLoad</key><true/>`,
      `  <key>KeepAlive</key><false/>`,
      `</dict></plist>`,
      `EOF`,
      `launchctl load -w "${plist}"`,
    ]
  }
  if (platform === 'linux') {
    const unitDir = join(homedir(), '.config', 'systemd', 'user')
    const unit = join(unitDir, 'dsh-node-daemon.service')
    return [
      `# Linux: install systemd user unit`,
      `mkdir -p "${unitDir}"`,
      `cat > "${unit}" << 'EOF'`,
      `[Unit]`,
      `Description=DSH Node Daemon`,
      `After=network.target`,
      ``,
      `[Service]`,
      `ExecStart=${nodeCommand} ${daemonScript}`,
      `Restart=no`,
      ``,
      `[Install]`,
      `WantedBy=default.target`,
      `EOF`,
      `systemctl --user daemon-reload`,
      `systemctl --user enable --now dsh-node-daemon.service`,
      `loginctl enable-linger $USER`,
    ]
  }
  if (platform === 'win32') {
    return [
      `# Windows: install Task Scheduler entry (run as administrator)`,
      `schtasks /Create /TN "DSH Node Daemon" /TR "${nodeCommand} ${daemonScript}" /SC ONLOGON /RL HIGHEST /F`,
    ]
  }
  return []
}
