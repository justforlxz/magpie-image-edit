// 三个工具真正干活的地方：拼请求、等结果、把图变成 base64。
//
// 依赖全部走 deps 传进来（config/jobs/fetch/now/readFile），所以这一层也能
// 用假 fetch 单测，不用真连网。
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import {
  EDIT_FILE_FIELD,

  buildEditFields,
  buildGenerateBody,
  classifyImageSource,
  errorMessage,
  parseImagesResponse,
} from "./images-api.js"
import { clampInt } from "./config.js"

/** 宿主给每个工具 55 秒，我们自己最多等这么久（留出传输和编码的余量）。 */
export const MAX_WAIT_SECONDS = 50

const str = (v) => (typeof v === "string" ? v.trim() : "")

const PNG = "image/png"

/** 调用方给的图片：接受单个字符串、字符串数组，也接受 image 这个别名。 */
export function imageInputs(args) {
  const raw = args?.images ?? args?.image
  if (typeof raw === "string") return str(raw) ? [str(raw)] : []
  if (!Array.isArray(raw)) return []
  return raw.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())
}

/** anySignal：把若干 AbortSignal 合成一个（老运行时退化成第一个）。 */
function anySignal(signals) {
  const list = signals.filter(Boolean)
  if (list.length <= 1) return list[0]
  if (typeof AbortSignal.any === "function") return AbortSignal.any(list)
  return list[0]
}

/**
 * readImage：把调用方给的任一种图片输入，变成可以上传的字节。
 * file:// 和本地路径直接读盘，http(s) 先取回来，data URL / 裸 base64 就地解码。
 */
export async function readImage(src, io) {
  const { kind } = classifyImageSource(src)
  if (kind === "empty") throw new Error("images 里有一项是空的")
  if (kind === "url") {
    const res = await io.fetch(src, { signal: io.signal })
    if (!res.ok) throw new Error(`取这张图失败：${src} 答复 ${res.status}`)
    const data = Buffer.from(await res.arrayBuffer())
    return { data, mime: sniffOr(data, "image/png"), name: nameOf(src, "png") }
  }
  if (kind === "file" || kind === "path") {
    const file = kind === "file" ? fileURLToPath(src) : src
    let data
    try {
      data = io.readFileBytes(file)
    } catch (e) {
      throw new Error(`读不到这张图：${file}（${e?.message ?? e}）`)
    }
    return { data, mime: sniffOr(data, PNG), name: nameOf(file, "png") }
  }
  if (kind === "data") {
    const comma = src.indexOf(",")
    const meta = src.slice(5, comma)
    const b64 = src.slice(comma + 1)
    const data = Buffer.from(b64, "base64")
    if (!data.length) throw new Error("这张图的 data URL 里没有内容")
    const mime = (meta.split(";")[0] || "").trim()
    return { data, mime: mime || sniffOr(data, PNG), name: nameOf("", "png") }
  }
  // 裸 base64
  const data = Buffer.from(src, "base64")
  if (!data.length) throw new Error("这段 base64 解出来是空的")
  return { data, mime: sniffOr(data, PNG), name: nameOf("", "png") }
}

/** sniffOr：认得出就按内容说，认不出用给定的兜底。 */
function sniffOr(bytes, fallback) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return PNG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg"
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF") return "image/webp"
  if (bytes.length >= 6 && bytes.toString("latin1", 0, 3) === "GIF") return "image/gif"
  return fallback
}

/** nameOf：multipart 里给文件一个像样的名字。 */
function nameOf(p, ext) {
  const base = String(p || "").split(/[\\/]/).pop() || ""
  const clean = base.replace(/[^\w.-]/g, "")
  if (clean && /\.(png|jpe?g|webp|gif)$/i.test(clean)) return clean
  const e = String(ext || "png").replace(/^\./, "")
  return clean ? `${clean}.${e}` : `image.${e}`
}

/**
 * callImages：一次真实的画图请求。
 * 生成走 JSON，编辑走 multipart（OpenAI 只认 multipart，magpie 两种都认）。
 */
export async function callImages(mode, cfg, p, io) {
  const url = `${cfg.baseUrl}/images/${mode}`
  const headers = {}
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`

  let body
  if (mode === "generations") {
    headers["content-type"] = "application/json"
    body = JSON.stringify(buildGenerateBody(cfg, p))
  } else {
    const form = new FormData()
    for (const [k, v] of Object.entries(buildEditFields(cfg, p))) form.append(k, String(v))
    for (const [i, f] of p.files.entries()) {
      form.append(EDIT_FILE_FIELD, new Blob([f.data], { type: f.mime || PNG }), f.name || `image-${i + 1}.png`)
    }
    body = form
  }

  const signal = anySignal([io.signal, io.timeoutMs > 0 ? AbortSignal.timeout(io.timeoutMs) : null])
  let res
  try {
    res = await io.fetch(url, { method: "POST", headers, body, signal })
  } catch (e) {
    if (e?.name === "AbortError" || e?.name === "TimeoutError") {
      throw new Error(`${url} 超时（${Math.round(io.timeoutMs / 1000)} 秒）：图还没画完。可以把 jobTimeoutSeconds 调大，或改用更快的模型/更小的尺寸`)
    }
    throw new Error(`连不上 ${url}：${e?.message ?? e}`)
  }

  const text = await res.text()
  if (!res.ok) throw new Error(`${url} 答复 ${res.status}：${errorMessage(text, res.status)}`)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${url} 的答复不是 JSON：${text.slice(0, 300)}`)
  }
  const out = parseImagesResponse(json)
  if (!out.images.length) throw new Error(`${url} 没给图：${text.slice(0, 300)}`)
  return { ...out, model: out.model || p.model, images: await inlineImages(out.images, io) }
}

/** inlineImages：vendor 只给了 URL 的图，取回来补成 base64（我们的契约是 base64）。 */
async function inlineImages(images, io) {
  const out = []
  for (const im of images) {
    if (im.b64) {
      out.push({ b64: im.b64, mimeType: im.mimeType || "", revisedPrompt: im.revisedPrompt, url: im.url })
      continue
    }
    try {
      const res = await io.fetch(im.url, { signal: io.signal })
      if (!res.ok) throw new Error(`答复 ${res.status}`)
      const data = Buffer.from(await res.arrayBuffer())
      out.push({ b64: data.toString("base64"), mimeType: sniffOr(data, PNG), revisedPrompt: im.revisedPrompt, url: im.url })
    } catch (e) {
      // 取不回来也把 URL 交出去，别让「已经花钱画好的图」丢掉
      io.log?.("warn", `图在 ${im.url} 取不回来：${e?.message ?? e}`)
      out.push({ b64: "", mimeType: "", revisedPrompt: im.revisedPrompt, url: im.url })
    }
  }
  return out
}

/** toAnswer：把内部结果变成给模型看的形状（base64 在里面）。 */
export function toAnswer(result) {
  const images = (result?.images ?? []).map((im, i) => {
    const bytes = im.b64 ? Buffer.byteLength(im.b64, "base64") : 0
    const one = { index: i, mimeType: im.mimeType || PNG, bytes }
    if (im.b64) one.b64 = im.b64
    if (im.url) one.url = im.url
    if (im.revisedPrompt) one.revisedPrompt = im.revisedPrompt
    return one
  })
  const totalBytes = images.reduce((a, b) => a + b.bytes, 0)
  return {
    status: "done",
    model: result?.model ?? "",
    count: images.length,
    totalBytes,
    images,
    note: "b64 是图片本身的 base64；需要再改这张图，把它原样放进 edit_image 的 images。",
  }
}

/** runningAnswer：还没画完，把 jobId 交回去。 */
function runningAnswer(id, model, waitedSeconds) {
  return {
    status: "running",
    jobId: id,
    model,
    waitedSeconds,
    hint: `图还在画。过一会儿用 image_result 要它：{"jobId":"${id}"}。同一张图只会画一次。`,
  }
}

/** draw：generate 和 edit 共用的流程（起后台任务 → 等一小会儿 → 交结果或 jobId）。 */
async function draw(mode, args, ctx, deps) {
  const cfg = deps.config()
  const model = str(args?.model) || cfg.model
  const prompt = str(args?.prompt)
  if (!prompt) throw new Error("prompt 不能为空：说清楚要画什么，或要把它改成什么样")
  const n = clampInt(args?.n, 1, 1, 4)
  const waitSeconds = clampInt(args?.waitSeconds, cfg.waitSeconds, 1, MAX_WAIT_SECONDS)

  const p = {
    model,
    prompt,
    n,
    size: args?.size,
    quality: args?.quality,
    background: args?.background,
    outputFormat: args?.outputFormat,
    extra: args?.extra,
    files: [],
  }

  if (mode === "edits") {
    const srcs = imageInputs(args)
    if (!srcs.length) throw new Error("edit_image 需要 images：一张或几张参考图（base64、data URL、http(s) 地址或本机路径）")
    if (srcs.length > 16) throw new Error("edit_image 最多 16 张参考图")
    p.files = await Promise.all(srcs.map((s) => readImage(s, deps.io(ctx))))
  }

  const io = deps.io(ctx)
  const job = deps.jobs.start((signal) =>
    callImages(mode, cfg, p, { ...io, signal, timeoutMs: cfg.jobTimeoutSeconds * 1000 }),
  )
  return settle(job.id, model, waitSeconds, ctx, deps)
}

/** settle：等任务 waitSeconds 秒，等到就给图，等不到就给 jobId。 */
async function settle(id, model, waitSeconds, ctx, deps) {
  const r = await deps.jobs.wait(id, waitSeconds * 1000, ctx?.abort)
  if (r.status === "done") return toAnswer(r.result)
  if (r.status === "failed") throw new Error(r.error || "画图失败")
  return runningAnswer(id, model, waitSeconds)
}

/** generateImage：文生图。 */
export function generateImage(args, ctx, deps) {
  return draw("generations", args, ctx, deps)
}

/** editImage：图生图（给定参考图 + 改图说明）。 */
export function editImage(args, ctx, deps) {
  return draw("edits", args, ctx, deps)
}

/** imageResult：按 jobId 去要还在画的那张图。 */
export async function imageResult(args, ctx, deps) {
  const cfg = deps.config()
  const id = str(args?.jobId)
  if (!id) throw new Error("jobId 不能为空：用 generate_image 或 edit_image 返回的 jobId")
  const waitSeconds = clampInt(args?.waitSeconds, cfg.waitSeconds, 1, MAX_WAIT_SECONDS)
  const r = await deps.jobs.wait(id, waitSeconds * 1000, ctx?.abort)
  if (r.status === "done") return toAnswer(r.result)
  if (r.status === "failed") throw new Error(r.error || "画图失败")
  if (r.status === "unknown") {
    return {
      status: "unknown",
      jobId: id,
      known: deps.jobs.list().map((j) => ({ jobId: j.id, status: j.status })),
      hint: "这个 jobId 不在登记表里：任务可能早就结束并过期了，或者 magpie 重启过。重新用 generate_image 画一次即可。",
    }
  }
  return runningAnswer(id, str(args?.model) || cfg.model, waitSeconds)
}

/** depsFor：把运行时依赖聚在一起，index.js 只用这一个入口。 */
export function depsFor({ config, jobs, log, fetchImpl, now }) {
  return {
    config,
    jobs,
    log,
    io: () => ({
      fetch: fetchImpl ?? globalThis.fetch,
      readFileBytes: (p) => fs.readFileSync(p),
      log,
      now: now ?? (() => Date.now()),
      timeoutMs: 0,
      signal: undefined,
    }),
  }
}
