# esa-azure-tts

Azure 语音合成（TTS）中转，运行在阿里云 ESA（边缘安全加速）边缘函数上。给 AI Agent 提供一个只认 Bearer token 的 `POST /tts`，Azure 密钥不出边缘；`GET /tts` 返回可用音色、语言与语速清单，音色列表缓存在 EdgeKV。

## 功能

- `POST /tts`：`{speaker, text, speed, lang}` → 流式返回 MP3。
- `GET /tts`：返回音色、语言、语速与默认值，支持 `?lang=` 过滤。
- `GET /healthz`：无鉴权存活探测，不访问 Azure / KV。
- 音色元数据缓存于 EdgeKV 命名空间 `esa-azure-tts`，过期自动刷新，刷新失败时回退旧缓存。
- 多 token 并存，便于轮换；所有配置经函数变量注入。

## 目录

```
esa-azure-tts/
├── app.js            # 唯一入口，全部实现
├── README.md
```

## 平台适配

面向阿里云 ESA 边缘函数编写：

- 入口形态为 `export default { fetch }`；
- 配置通过 `import { env } from "alibaba:workers"` 读取控制台「函数变量」；
- 缓存使用 ESA 内置 `EdgeKV`。

移植到其它边缘平台时，需替换以上平台能力。

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET  | `/tts` | `Authorization: Bearer` | 返回可用音色 / 语言 / 语速清单 |
| POST | `/tts` | `Authorization: Bearer` | 合成语音，返回 MP3 音频流 |
| OPTIONS | `/tts` | 无 | CORS 预检 |
| GET | `/status` | `Authorization: Bearer` | 返回当月调用日志（尽力而为） |
| GET | `/healthz` | 无 | 存活探测 |

鉴权头格式固定为 `Authorization: Bearer <API_TOKEN>`。其余路径返回 404；`/tts` 与 `/status` 上的其它方法返回 405（`/tts` 另有 OPTIONS 预检）。

### GET /tts

```http
GET /tts?lang=zh-CN HTTP/1.1
Authorization: Bearer <API_TOKEN>
```

`lang` 可省略；传 `zh` 按语言过滤，传 `zh-CN` 按具体区域过滤。响应：

```json
{
  "region": "eastasia",
  "audio": {
    "contentType": "audio/mpeg",
    "format": "audio-48khz-192kbitrate-mono-mp3"
  },
  "speeds": {
    "presets": [
      { "name": "x-slow", "rate": "-50%" },
      { "name": "slow", "rate": "-25%" },
      { "name": "normal", "rate": "0%" },
      { "name": "fast", "rate": "+25%" },
      { "name": "x-fast", "rate": "+50%" }
    ],
    "numericRange": [0.5, 2.0],
    "default": "normal"
  },
  "langs": [
    {
      "code": "zh",
      "locales": [{ "code": "zh-CN", "name": "Chinese (Mandarin, Simplified)" }],
      "speakerCount": 2
    }
  ],
  "speakers": [
    {
      "speaker": "zh-CN-XiaoxiaoNeural",
      "name": "晓晓",
      "displayName": "Xiaoxiao",
      "gender": "Female",
      "locale": "zh-CN",
      "localeName": "Chinese (Mandarin, Simplified)",
      "lang": "zh"
    }
  ],
  "defaults": {
    "lang": "zh",
    "speaker": "zh-CN-XiaoxiaoNeural",
    "speed": "normal"
  },
  "count": 1,
  "limits": { "maxTextChars": 200 },
  "cachedAt": "2026-10-25T03:40:50.471Z",
  "stale": false
}
```

- `speakers[].speaker` 即 `POST /tts` 的 `speaker` 参数（Azure voice `ShortName`）。
- 仅收录 `VoiceType=Neural` 且 `Status=GA` 的音色。
- 响应带 `ETag`，支持 `If-None-Match` → 304；`Cache-Control: private, max-age=300`。
- `X-Cache` 为 `HIT` / `MISS` / `STALE`。
- 指定 `lang` 但无匹配音色时返回 404 `unknown_lang`，并附带 `availableLangs`。

### POST /tts

```http
POST /tts HTTP/1.1
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"speaker":"zh-CN-XiaoxiaoNeural","text":"你好，世界","speed":1.1,"lang":"zh"}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | 是 | 非空，最多 200 个字符（按 Unicode 码点计） |
| `speaker` | string | 是* | Azure 音色 `ShortName`；配置 `DEFAULT_VOICE` 后可省略 |
| `lang` | string | 否 | 形如 `zh` / `zh-CN`；提供时须与 speaker 的 locale 匹配 |
| `speed` | number \| string | 否 | `0.5`–`2.0`，或预设 `x-slow` / `slow` / `normal` / `fast` / `x-fast` |

\* 未配置 `DEFAULT_VOICE` 且未传 `speaker` → 400 `speaker_required`。

成功响应为 MP3 流，`Content-Type: audio/mpeg`，附带：

| 响应头 | 说明 |
|---|---|
| `X-Request-Id` | 本次请求 ID，便于对照日志 |
| `X-Azure-Request-Id` | Azure 侧请求 ID（若返回） |
| `X-Voice` / `X-Lang` / `X-Speed` / `X-Chars` | 实际使用的音色 / locale / 语速 / 字符数 |
| `X-Output-Format` | Azure 输出格式 |
| `Cache-Control: no-store` | 音频不做缓存 |

数值语速按 `(speed - 1) × 100%` 换算：`0.5 → -50%`、`1.1 → +10%`、`1.5 → +50%`、`2.0 → +100%`。`1` 与 `normal` 不生成 `prosody`。

### GET /status

读取当前月份（UTC+8）的调用日志，鉴权与 `/tts` 相同。

```http
GET /status HTTP/1.1
Authorization: Bearer <API_TOKEN>
```

```json
{
  "month": "202610",
  "count": 2,
  "logs": [
    [1761360000000, "zh-CN-XiaoxiaoNeural", 12],
    [1761360012345, "zh-CN-YunxiNeural", 4]
  ]
}
```

- `logs` 按写入顺序排列，元素为 `[timestamp, speaker, text_len]`。
- `timestamp` 为 epoch 毫秒；`speaker` 为本次使用的 ShortName；`text_len` 为实际合成的码点数。
- 当月没有成功调用时返回 `{"month":"...","count":0,"logs":[]}`。
- 读取失败返回 502 `log_unavailable`，超时返回 504 `log_timeout`，value 损坏返回 502 `log_corrupt`。
- 非 GET 返回 405；缺少或错误 token 返回 401。

## 错误

错误响应为 JSON：

```json
{ "error": { "code": "text_too_long", "message": "text must be at most 200 characters" } }
```

| HTTP | code | 触发条件 |
|---|---|---|
| 400 | `invalid_json` / `invalid_body` | 请求体不是 JSON 对象 / 读取失败 |
| 400 | `invalid_text` / `text_too_long` | 文本为空或超 200 字符 |
| 400 | `invalid_speaker` / `speaker_required` | 音色格式非法 / 未提供且无默认音色 |
| 400 | `invalid_lang` / `lang_mismatch` | 语言格式非法 / 与音色 locale 不符 |
| 400 | `invalid_speed` | 不是预设且不在 0.5–2.0 |
| 400 | `azure_bad_request` | Azure 拒绝合成请求（如 SSML 或音色不可用） |
| 401 | `unauthorized` | 缺失或错误的 Bearer token |
| 404 | `not_found` / `unknown_lang` | 路径不存在 / 指定语言无音色 |
| 405 | `method_not_allowed` | 方法不支持 |
| 413 | `body_too_large` | 请求体超过 8 KB |
| 429 | `rate_limited` | Azure 限流，透传 `Retry-After` |
| 502 | `upstream_auth_failed` / `upstream_not_found` / `upstream_error` | Azure 鉴权失败、端点 404 或其它错误 |
| 502 | `log_unavailable` / `log_corrupt` | `/status` 读取当月日志失败 / 日志值不是数组 |
| 503 | `upstream_unavailable` | Azure 暂时不可用 |
| 504 | `upstream_timeout` / `log_timeout` | 等待 Azure 响应超时 / 读取当月日志超时 |
| 500 | `internal_error` | 未预期异常 |

## 配置

敏感配置不写死在代码里，由 ESA 控制台的**函数变量**注入（边缘计算和 AI → 函数和 Pages → 目标函数 → 基本信息 → 函数变量），代码通过 `import { env } from "alibaba:workers"` 读取。变量按环境独立存储，修改后需重新生成版本并发布。

| 变量键 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `API_TOKEN` | 是 | — | 调用方 Bearer token；多个用逗号或空白分隔，每个至少 16 字符 |
| `AZURE_SPEECH_KEY` | 是 | — | Azure 语音密钥，勾选加密存储 |
| `AZURE_REGION` | 否 | `eastasia` | 地域；用于默认端点与缓存归属 |
| `AZURE_ENDPOINT` | 否 | `https://{AZURE_REGION}.tts.speech.microsoft.com` | 仅协议 + 主机；误填 `*.api.cognitive.microsoft.com` 会自动改写到 `*.tts.*` |
| `AZURE_TTS_URL` | 否 | `{endpoint}/cognitiveservices/v1` | 完整 https URL，覆盖 TTS 地址 |
| `AZURE_VOICES_URL` | 否 | 由端点推导 | 完整 https URL，覆盖音色列表地址 |
| `AZURE_OUTPUT_FORMAT` | 否 | `audio-48khz-192kbitrate-mono-mp3` | 仅接受 `audio-{n}khz-{n}kbitrate-mono-mp3` |
| `KV_NAMESPACE` | 否 | `esa-azure-tts` | 音色缓存 KV 命名空间 |
| `VOICES_CACHE_TTL` | 否 | `86400` | 音色缓存 TTL（秒），范围 60–604800 |
| `DEFAULT_LANG` | 否 | `zh` | `GET /tts` 默认语言与默认音色选择依据 |
| `DEFAULT_SPEED` | 否 | `normal` | 预设或 0.5–2.0 |
| `DEFAULT_VOICE` | 否 | 空 | 设置后 `POST /tts` 可省略 `speaker` |
| `CORS_ORIGIN` | 否 | `*` | CORS 允许来源；建议生产改为具体域名 |

缺少 `API_TOKEN`、`AZURE_SPEECH_KEY`，或变量格式非法时，函数启动即抛错，避免静默失败。

代码内常量：`MAX_TEXT_CHARS = 200`、`MAX_BODY_BYTES = 8192`、`VOICES_KEY = "meta_voices_v1"`、日志写入超时 800 ms、日志读取超时 3 s、单月日志上限 1.5 MB、上游等待上限 9s（TTS）/ 8s（音色列表）。

## 部署

1. 控制台创建边缘函数，入口代码即 `app.js`。
2. 创建（或确认）KV 命名空间 `esa-azure-tts`；`EdgeKV` 由运行时注入。
3. 按上表添加函数变量，`AZURE_SPEECH_KEY` 与 `API_TOKEN` 勾选加密存储。
4. 将函数路由挂到站点根路径：至少覆盖 `/tts`、`/status`、`/healthz`。函数按完整路径匹配，若挂在 `/api/*` 前缀下，请求会变成 `/api/tts` 而返回 404。
5. 生成版本并发布。

部署后自检：

```bash
curl -sS https://<host>/healthz
curl -sS https://<host>/tts -H "Authorization: Bearer $API_TOKEN" | head -c 400
curl -sS https://<host>/status -H "Authorization: Bearer $API_TOKEN"
```

## 使用示例

```bash
# 音色清单（可按语言过滤）
curl -sS "https://<host>/tts?lang=zh" \
  -H "Authorization: Bearer $API_TOKEN"

# 合成 MP3
curl -sS -X POST "https://<host>/tts" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"speaker":"zh-CN-XiaoxiaoNeural","text":"你好，世界","lang":"zh","speed":1.1}' \
  -o out.mp3
```

## Token 轮换

`API_TOKEN` 支持逗号 / 空白分隔的多个值，用于无缝轮换：

1. 在变量中加入新 token：`old-token...,new-token...`，重新生成版本并发布。
2. 让调用方切换到新 token。
3. 删除旧 token，再次发布。

旧 token 在下一次发布前仍然有效；每个 token 至少 16 字符。比较采用定长遍历，避免按字符提前返回。

## 音色缓存

- 键：`meta_voices_v1`，值为精简后的音色数组及元信息（`v` / `region` / `endpoint` / `voicesUrl` / `fetchedAt` / `voices`）。
- 读取时校验元信息与配置一致；`region`、`AZURE_ENDPOINT`、`AZURE_VOICES_URL` 变化会自动使旧缓存失效。
- TTL 由 `VOICES_CACHE_TTL` 控制；过期后请求会同步刷新并回写。
- 刷新失败但存在旧缓存时，返回旧数据并标记 `stale: true`、`X-Cache: STALE`。
- 没有管理接口：需要立即刷新时，在 KV 控制台删除 `meta_voices_v1`；否则等待 TTL 到期。
- EdgeKV 为最终一致，冷启动后多个边缘节点可能各拉取一次音色列表，不影响正确性。

## 调用日志

- **仅成功的 `POST /tts` 写入**；失败请求、`GET /tts`、`/status`、`/healthz` 都不写。
- 键：`log-YYYYMM`，月份按 UTC+8 计算（如 `log-202610`），与音色缓存共用 `KV_NAMESPACE`。
- 值：JSON 数组 `[[timestamp, speaker, text_len], ...]`；`timestamp` 为 epoch 毫秒，`speaker` 为本次使用的 ShortName，`text_len` 为实际合成的码点数。
- 写入是尽力而为：读/写失败、800 ms 超时、value 超过 1.5 MB、或已有值不是数组时，只写函数控制台日志，本次 API 响应不受影响。
- 读取通过 `GET /status`；日志读取失败返回 502 / 504，不会影响 `/tts`。
- EdgeKV 没有原子追加，并发下读-改-写可能丢条目；该日志适合用量趋势与计费参考，不适合强一致审计。
- 日志不设过期，按月累积；需要清理时在 KV 控制台删除对应的 `log-YYYYMM`。

## 注意事项

- **命令即整个请求**：`POST /tts` 的请求体上限 8 KB，文本上限 200 字符，避免超过 ESA 网关 10 秒无数据限制与 Azure 10 分钟音频上限。代码等待 Azure 响应头最多 9 秒，之后以流式转发音频。
- **超时不取消上游**：`AbortSignal` 在该运行时不可用，超时仅停止等待，Azure 请求可能继续执行。
- **子请求数**：`POST` 为 1 次 Azure TTS + 日志 1 次 KV 读 + 1 次 KV 写；`GET /tts` 冷启动最多 1 次音色列表 + 若干 EdgeKV 操作；`GET /status` 为 1 次 KV 读，均在 ESA 单次 4 个子请求限制内。
- **音频不缓存**：响应统一 `Cache-Control: no-store`，每次调用都会产生 Azure 计费。
- **SSML 服务端生成**：文本经 XML 转义，`speaker` / `lang` / `speed` 严格校验，调用方不能注入任意 SSML。
- **函数日志**：以 JSON 记录事件、请求 ID、音色、字符数、耗时、Azure 错误摘要；不记录 token 与 Azure 密钥，正常路径不记录文本内容（仅记录字符数）。
- **日志延迟**：成功合成会在返回音频前尝试写调用日志，最坏增加 800 ms 首字节延迟；写失败或超时直接放弃，不影响音频返回。
- **CORS**：预检不鉴权，实际请求仍必须携带 Bearer token；浏览器端不要内嵌长期 token。
- `AZURE_REGION` 仅用于默认端点与缓存归属；鉴权直接使用订阅密钥，不调用 STS `issueToken`，也不随请求刷新 token。
