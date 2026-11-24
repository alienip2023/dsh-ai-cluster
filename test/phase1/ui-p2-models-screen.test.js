import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../../lib/client.js'), 'utf8')

test('source: no sync path, apiKey or appliedRevision in the client', () => {
  assert.doesNotMatch(src, /models\/sync/)
  assert.doesNotMatch(src, /apiKey/)
  assert.doesNotMatch(src, /appliedRevision/)
})
