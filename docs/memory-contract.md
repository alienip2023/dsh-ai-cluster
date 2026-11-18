# 记忆屏接口契约

记忆屏从 ds-bot 的同源 `POST /api/bot` 读取记忆范围。`lib/client.js` 的 `memoryScopes()` 发送 JSON 请求体 `{"endpoint":"memory-hub-scopes","payload":{}}`。

`GET /api/ai-cluster/ui/memory` 和旧别名 `GET /api/remote-agent/ui/memory` 是兼容桩，均返回 HTTP 200 和以下 JSON。

```json
{"ok":false,"code":"not-available","screen":"S4","reason":"memory-store-not-built"}
```

若将来接入真实记忆端点，接入层必须保留客户端 `botApiOutcome` 的结果形状。成功响应 `{ok: true, value}` 转为 `{kind: 'ok', value}`，由调用方取得 `value`。HTTP 404、非 JSON、缺少布尔 `ok` 或 `bot/not-found` 转为 `{kind: 'missing', reason: 'memory-api-missing'}`。页面分别显示接口不可用和成功返回的空记忆。其他业务失败保留 `{kind: 'error', reason}`。
