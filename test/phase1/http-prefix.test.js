import test from 'node:test'
import assert from 'node:assert/strict'
import { UI_API_PREFIX } from '../../src/http/index.js'
import { UI_API_PREFIX as direct } from '../../src/http/prefix.js'

test('UI_API_PREFIX === /api/ai-cluster/ui', () => {
  assert.equal(UI_API_PREFIX, '/api/ai-cluster/ui')
  assert.equal(direct, '/api/ai-cluster/ui')
})
