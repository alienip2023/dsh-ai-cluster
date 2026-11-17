# fsbox

按声明的 roots 约束文件读写（`createFsService`）。零依赖：不 import `wire` 或 `store`。

- 错误码用本地冻结表 `FS_ERROR_CODE`，与 `wire` 的 `ERROR_CODE` 同值，由 `test/phase1/fsbox-codes-match-wire.test.js` 守卫漂移。
- `isDenied` 从 `lib/node/exec.js` 原样复制进来（exec.js 依赖 protocol，不能引入）。
- `write` 里的临时文件 + rename（`index.js` 的 `.dshra-tmp-` 段）刻意留在 fsbox 内，不走 `store/atomic.js`：这是「唯一原子写入器」的有意例外，因为 fsbox 不能依赖 store，且该路径要求同步、无重试、权限 0o600 与旧行为一致。
