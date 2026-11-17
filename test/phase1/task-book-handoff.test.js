/** 红刀 2：intermediate 产物绝不进 handoff 卡。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHandoff } from '../../src/task-run/index.js'
import { ARTIFACT_KIND, ARTIFACT_ROLE } from '../../src/wire/index.js'

test('buildHandoff 只带 final，intermediate 只计数、不出现路径', () => {
  const manifest = {
    counts: { final: 1, intermediate: 1 },
    bytesFinal: 10,
    items: [
      { path: 'dist/report.md', role: ARTIFACT_ROLE.FINAL, kind: ARTIFACT_KIND.REPORT ?? 'report', bytes: 10, sha256: 'aa' },
      { path: 'node_modules/leak/INTERMEDIATE-MARK.js', role: ARTIFACT_ROLE.INTERMEDIATE, kind: 'other', bytes: 5, sha256: 'bb' },
    ],
  }
  const card = buildHandoff({
    rec: { taskId: 't1', goal: 'g', mode: 'exec', status: 'completed', logs: [] },
    nodeId: 'n1',
    result: { ok: true, final: 'done', exitCode: 0 },
    manifest,
    changed: [],
    diffs: [],
    workspace: '/w',
  })
  assert.equal(card.status, 'completed')
  assert.equal(card.nodeId, 'n1')
  assert.deepEqual(card.artifacts.final.map((f) => f.path), ['dist/report.md'])
  assert.equal(card.artifacts.intermediateCount, 1)
  const json = JSON.stringify(card)
  assert.equal(json.includes('INTERMEDIATE-MARK'), false)
  assert.equal(json.includes('"bb"'), false)
})
