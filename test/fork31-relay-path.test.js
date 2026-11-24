import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { currentPatchFile } from '../lib/setup-routes.js'
import { MANAGED_BEGIN, MANAGED_END, writePatchBlock } from '../lib/setup.js'

const profilePath = fileFrom('../lib/profile-path.js')

function fileFrom(rel) {
  return path.join(path.dirname(new URL(import.meta.url).pathname), rel)
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function forbiddenDesktopPatch() {
  return path.join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
}

/** 同一条路径断言：临时 DSH_HOME 显式指定 web 时，必须命中该文件。 */
function assertResolvesWebProfile(resolvePatchFile) {
  const root = mkdtempSync(path.join(tmpdir(), 'fork31-dsh-home-'))
  const webFile = path.join(root, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(path.join(root, 'profiles', 'web', 'node_modules', 'dsh-remote-agent'), { recursive: true })
  writeFileSync(webFile, 'plugins: []\n')
  const prevHome = process.env.DSH_HOME
  const prevProfile = process.env.DSH_PROFILE
  try {
    process.env.DSH_HOME = root
    process.env.DSH_PROFILE = 'web'
    const got = resolvePatchFile()
    assert.strictEqual(got, webFile, '必须解析到 DSH_HOME/profiles/web/cordis.patch.yml')
    assert.notStrictEqual(got, forbiddenDesktopPatch(), '不得回落到 ~/.dsh/profiles/desktop/cordis.patch.yml')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = prevProfile
    rmSync(root, { recursive: true, force: true })
  }
}

async function withDiskMutationModule(filePath, mutate, run) {
  const original = readFileSync(filePath)
  const originalSha = sha256(original)
  try {
    writeFileSync(filePath, mutate(original.toString('utf8')))
    const reread = readFileSync(filePath, 'utf8')
    const mod = await import(pathToFileURL(filePath).href + '?fork31=' + Date.now() + Math.random())
    await assert.rejects(async () => { await run(mod, reread) }, '变异后主断言必须失败')
  } finally {
    writeFileSync(filePath, original)
    assert.strictEqual(sha256(readFileSync(filePath)), originalSha)
  }
}

test('T1: 临时 DSH_HOME 显式指定 web 时解析到该文件', () => {
  assertResolvesWebProfile(currentPatchFile)
})

test('M1: 忽略显式 DSH_PROFILE 后同一条路径断言必须红', async () => {
  await withDiskMutationModule(
    profilePath,
    (source) => source.replace(
      "typeof env.DSH_PROFILE === 'string'",
      'false // MUTATION explicit profile ignored',
    ),
    (mod) => assertResolvesWebProfile(mod.resolvePatchFile),
  )
})

test('T2: writePatchBlock 替换托管块，不碰 mcp-geelark，不追加第二个 id', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fork31-patch-'))
  const file = path.join(dir, 'cordis.patch.yml')
  const before = [
    'plugins:',
    '  - id: mcp-geelark',
    '    disabled: true',
    '  - id: other-plugin',
    '    config:',
    '      keep: 1',
    '',
  ].join('\n')
  const oldBlock = [
    '- id: remote-agent',
    '  name: dsh-remote-agent',
    "  inject: ['webServer', 'tools', 'systemPrompt']",
    '  config:',
    '    role: hub',
    '    transportMode: relay',
    "    relayUrl: 'ws://old.example/relay'",
    '    listenPort: 19387',
    '',
  ].join('\n')
  const original = `${before}${MANAGED_BEGIN}\n${oldBlock}${MANAGED_END}\n`
  writeFileSync(file, original)
  try {
    const blockYaml = [
      '- id: remote-agent',
      '  name: dsh-ai-cluster',
      "  inject: ['webServer', 'tools', 'systemPrompt']",
      '  config:',
      '    role: hub',
      '    transportMode: relay',
      "    relayUrl: 'ws://relay.example/relay'",
      '    relay:',
      "      url: 'ws://relay.example/relay'",
      "      token: 'rt_fork31_disk'",
      '',
    ].join('\n')
    const result = writePatchBlock({ file, blockYaml })
    assert.equal(result.ok, true, result.error)
    const written = readFileSync(file, 'utf8')
    assert.ok(written.startsWith(before), '托管块之前的其它插件必须原样保留')
    assert.ok(written.includes('  - id: mcp-geelark\n    disabled: true'), 'mcp-geelark disabled: true 不能删')
    assert.equal((written.match(/^\s*-\s+id:\s*remote-agent\b/gm) || []).length, 1, '不得追加第二个 remote-agent')
    assert.equal(written.includes('# BEGIN dsh-remote-agent managed'), false)
    assert.ok(written.includes("token: 'rt_fork31_disk'"), '必须写入 relay.token')
    assert.equal(written.includes('old.example'), false, '旧托管块必须被整块替换')
    assert.ok(written.includes("inject: ['webServer', 'tools', 'systemPrompt']"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
