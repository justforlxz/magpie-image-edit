# magpie-image-edit

magpie 插件：把「画图」和「按参考图改图」做成两个 MCP 工具，图片以 **base64** 返回。

插件本身不实现画图，它调用 magpie 网关的图片接口（`/v1/images/generations`、`/v1/images/edits`，
OpenAI 形状），所以用哪家的图片模型由 magpie 的「设置 → 模型 → 图片生成」决定。

| 工具 | 干什么 |
| --- | --- |
| `generate_image` | 文生图。给一句 prompt，返回图片的 base64 |
| `edit_image` | 图生图。给参考图（base64 / data URL / 路径 / 图片地址）+ 改图说明 |
| `image_result` | 图还没画好时，按 `jobId` 再要 |

通过 magpie 的 Plugin tools 服务给所有 agent 用，MCP 里的名字带插件前缀：
`magpie-image-edit_generate_image`、`magpie-image-edit_edit_image`、`magpie-image-edit_image_result`。

## 装

```sh
magpie plugin add ./                      # 本地目录
magpie plugin add github:justforlxz/magpie-image-edit   # 或从仓库
```

然后在 magpie 里确认 `plugins/tools`（Plugin tools）是打开的——它是把这些工具端给 agent 的那一环。
给某个 agent 用的地址：

- `/mcp/magpie/tools` — 所有插件的工具在一个服务里
- `/mcp/magpie/tools/magpie-image-edit` — 只有这个插件的工具

## 配

配置文件：magpie 设置目录下的 `magpie-image-edit.json`（Linux 上就是 `~/.config/magpie/magpie-image-edit.json`）。
环境变量优先于文件。

```json
{
  "baseUrl": "http://127.0.0.1:3425/v1",
  "apiKey": "",
  "model": "gpt-image-1",
  "waitSeconds": 40,
  "jobTimeoutSeconds": 300,
  "responseFormat": "b64"
}
```

| 字段 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `baseUrl` | `MAGPIE_IMAGE_EDIT_BASE_URL`、`MAGPIE_IMAGE_API_BASE` | `http://127.0.0.1:3425/v1` | 填到 `/v1` 为止；粘 `/images/generations` 进来也会被去掉 |
| `apiKey` | `MAGPIE_IMAGE_EDIT_API_KEY`、`MAGPIE_IMAGE_API_KEY` | 空 | 打 magpie 自己的接口可以留空，网关认 agent 的 key |
| `model` | `MAGPIE_IMAGE_EDIT_MODEL`、`MAGPIE_IMAGE_MODEL` | `gpt-image-1` | magpie 网关的写法是 `<provider>/<model>` |
| `waitSeconds` | — | `40` | 一次工具调用最多等几秒（硬上限 50：宿主只给 55 秒） |
| `jobTimeoutSeconds` | — | `300` | 一张图后台最多画多久，超时按失败算（10～3600） |
| `responseFormat` | `MAGPIE_IMAGE_EDIT_RESPONSE_FORMAT` | `b64` | 接口不认这个字段时设成 `""`，让它别发 |

另外 `MAGPIE_IMAGE_EDIT_CONFIG` 可以直接指定配置文件的绝对路径（多个 magpie 实例各自配置时有用）。

配置文件写坏了会明确报错（说清是哪个文件），不会被悄悄当成「没配置」；文件不存在才算没配置。

## 用

画一张：

```json
{"prompt": "一只在窗台上晒太阳的橘猫，晨光，浅景深", "size": "1024x1024"}
```

答复（有图就是 `status: "done"`）：

```json
{
  "status": "done",
  "model": "vendor/draw-2",
  "count": 1,
  "totalBytes": 1834240,
  "images": [{ "index": 0, "mimeType": "image/png", "bytes": 1834240, "b64": "iVBORw0…" }],
  "note": "b64 是图片本身的 base64；需要再改这张图，把它原样放进 edit_image 的 images。"
}
```

拿着这张图再改（b64 原样接过来就行）：

```json
{"prompt": "把猫换成黑猫，其他不动", "images": ["iVBORw0…"]}
```

`images` 每项可以是 base64、`data:image/png;base64,…`、`http(s)` 地址，或 magpie 所在机器上的文件路径；
一次最多 16 张，多张就是「把这几张合起来改」。

三个工具共用的参数：`model`、`size`、`quality`、`background`、`outputFormat`、`n`（1～4）、`extra`
（原样透传给接口的额外字段）、`waitSeconds`。

### 图比一次调用久的时候

宿主给一个工具 55 秒。插件自己只等 `waitSeconds`（默认 40），没画完就把 `jobId` 交回去：

```json
{"status": "running", "jobId": "img_3f1c…", "model": "vendor/draw-2", "waitedSeconds": 40,
 "hint": "图还在画。过一会儿用 image_result 要它：{\"jobId\":\"img_3f1c…\"}。同一张图只会画一次。"}
```

之后 `{"jobId": "img_3f1c…"}` 拿到底，或者继续 `running`。任务在插件进程里，登记表最多留 32 个；
magpie 重启后 `jobId` 就没了（`image_result` 会说 `status: "unknown"` 并列出现有任务）。

## 边界

- **工具参数整体上限 4 MiB**（magpie 的 Plugin tools 服务限制），图生图的 base64 要算在这里面。
  大图建议先在本地压一下，或者改用文件路径，或者多画几次小尺寸。
- 文件路径由 magpie 所在的机器读，不是 agent 那台。
- base64 进上下文很占地方：一张 1024×1024 的 PNG 大约 2～3 MB 的 base64 文本。真要批量出图，
  一次一张、用完就丢，比一口气画四张划算。
- 只有 OpenAI 形状的两条路径（`generations` / `edits`）。vendor 自己的怪形状用 `extra` 顶一下；
  实在不行就换模型。

## 开发

```sh
npm test        # node --test test/，不连网、不花钱
MAGPIE_DIR=~/src/magpie npm run e2e   # 可选：让真的 magpie 插件宿主加载一遍（要 bun + 源码树）
```

```
index.js          插件入口：ImageTools(input) → { tool: {...} }（宿主只认这个形状）
lib/config.js     配置读取与归一（纯函数，可单测）
lib/images-api.js 请求体拼装、答复解析、mime 嗅探（纯函数）
lib/ops.js        三个工具的实现：起后台任务、等结果、把图变成 base64
lib/jobs.js       后台任务登记表（有上限、会自己收尸）
test/             单测：假 fetch，不碰网络
```

设计上的两个取舍：

1. **图片一律转成 base64 再交出去**，因为 MCP 的答复只有文本，URL 还要客户端另外去取、还要处理鉴权和过期。
   vendor 只给 URL 时插件会把图取回来补成 base64；取不回来就退回给 URL，不把已经画好的图丢掉。
2. **工具自己管超时**，不指望 MCP 那边等：超时前主动交出 `jobId`，比被宿主砍断、钱花了图丢了要好。
