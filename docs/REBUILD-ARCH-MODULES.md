# Rebuild architecture modules

### 5.3 Service name compatibility

- act-6 done: all eight owned services publish the same value under `remote-agent:*` and `ai-cluster:*`, including set-only contexts; alias failures retain the legacy publication.
- Covered by `test/phase1/dual-provide-all.test.js`; regenerate runtime output with `node scripts/build-plugin-entry.mjs`.
