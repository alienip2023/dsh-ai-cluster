import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const ticketDir = path.join(root, 'src/tickets')
const admissionDir = path.join(root, 'src/admission')
const omitted = new Set(['.git', 'node_modules', 'task-board'])

function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (omitted.has(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(file)
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) yield file
  }
}

function* imports(file) {
  const tokens = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|\b(?:import\s*(?:\(\s*|\s+(?:[\w$*{},\s]+?\s+from\s*)?)|export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s*|require\s*\(\s*)(['"])([^'"\r\n]+)\1|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g
  for (const match of fs.readFileSync(file, 'utf8').matchAll(tokens)) {
    if (match[2]) yield match[2]
  }
}

const withinTickets = file => file === ticketDir || file.startsWith(ticketDir + path.sep)

test('T-ISO-1 src/tickets imports only node: built-ins and its own files, and only src/admission and ticket tests may import it from outside', () => {
  for (const file of sources(root)) {
    for (const spec of imports(file)) {
      const target = path.resolve(path.dirname(file), spec.split(/[?#]/, 1)[0])
      if (withinTickets(file)) {
        assert.ok((spec.startsWith('node:') && isBuiltin(spec)) ||
          (spec.startsWith('./') && withinTickets(target) && fs.statSync(target, { throwIfNoEntry: false })?.isFile()),
        `${file} imports ${spec} outside the ticket module`)
      } else if (!file.startsWith(admissionDir + path.sep) &&
        !/^test\/phase1\/tickets-.*\.test\.js$/.test(path.relative(root, file))) {
        assert.ok(!withinTickets(target) && !/(?:^|\/)src\/tickets(?:\/|$)/.test(spec),
          `${file} imports the ticket module via ${spec}`)
      }
    }
  }
})

test('T-ISO-2 lib/client.js is byte-identical to the recorded hash', t => {
  if (!fs.existsSync(path.join(root, '.git'))) return t.skip('source snapshot has no git worktree for git diff')
  const diff = spawnSync('git', ['diff', '--quiet', '--', 'lib/client.js'], { cwd: root, encoding: 'utf8' })
  assert.equal(diff.status, 0, diff.error?.message || diff.stderr || 'git detected a change to lib/client.js')
})
