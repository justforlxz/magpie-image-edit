// 三个工具真正干活的地方：拼请求、等结果、把图变成 base64。
//
// 依赖全部走 deps 传进来（fetch/readText/env/jobs/now），所以这一层能用假网关单测，
// 不用真连网，也不用装 magpie。
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import { callerKey, drawOnce, imageModels, preferredModel, resolveGateway } from "./gateway.js"

/** 宿主给每个工具 55 秒，我们自己最多等这么久（留出传输和编码的余量）。 */
export const MAX_WAIT_SECONDS = 50

/** 单张图最多画多久（后台任务自己的上限，跟工具调用无关）。 */
const JOB_TIMEOUT_MS = 10 * 60e3

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

/** kindOf：判断一段图片输入是什么来源。 */
function kindOf(src) {
  const s = String(src || "").trim()
  if (!s) return "empty"
  if (/^data:/i.test(s)) return "data"
  if (/^file:\/\//i.test(s)) return "file"
  if (/^https?:\/\//i.test(s)) return "url"
  if (/^(\/|\.{1,2}\/|~\/)/.test(s)) return "path"
  return "base64"
}

/**
 * readImage：把调用方给的任一种图片输入，变成 {data, mime}。
 * file:// 和本地路径直接读盘，http(s) 先取回来，data URL / 裸 base64 就地解码。
 */
export async function readImage(src, io) {
  const kind = kindOf(src)
  if (kind === "empty") throw new Error("images 里有一项是空的")
  if (kind === "url") {
    const res = await io.fetch(src, { signal: io.signal })
    if (!res.ok) throw new Error(`取这张图失败：${src} 答复 ${res.status}`)
    const data = Buffer.from(await res.arrayBuffer())
    return { data, mime: sniffOr(data, PNG) }
  }
  if (kind === "file" || kind === "path") {
    const file = kind === "file" ? fileURLToPath(src) : src
    let data
    try {
      data = io.readFileBytes(file)
    } catch (e) {
      throw new Error(`读不到这张图：${file}（${e?.message ?? e}）`)
    }
    return { data, mime: sniffOr(data, PNG) }
  }
  if (kind === "data") {
    const comma = src.indexOf(",")
    const meta = src.slice(5, comma)
    const data = Buffer.from(src.slice(comma + 1), "base64")
    if (!data.length) throw new Error("这张图的 data URL 里没有内容")
    const mime = (meta.split(";")[0] || "").trim()
    return { data, mime: mime || sniffOr(data, PNG) }
  }
  const data = Buffer.from(src, "base64")
  if (!data.length) throw new Error("这段 base64 解出来是空的")
  return { data, mime: sniffOr(data, PNG) }
}

/** dataURL：网关要的是 data URL，它自己解 base64。 */
export function dataURL({ data, mime }) {
  return `data:${mime || PNG};base64,${data.toString("base64")}`
}

/** sniffOr：认得出就按内容说，认不出用给定的兜底。 */
function sniffOr(bytes, fallback) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return PNG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg"
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF") return "image/webp"
  if (bytes.length >= 6 && bytes.toString("latin1", 0, 3) === "GIF") return "image/gif"
  return fallback
}

/**
 * gatewayFor：问 magpie 自己的配置 —— 网关地址、key、默认模型。
 * 一次调用内只解析一次，60 秒内复用（用户刚在设置里换了模型也能很快跟上）。
 */
async function gatewayFor(deps) {
  const now = deps.now()
  if (deps.cache.base && now - deps.cache.at < 60e3) return deps.cache
  const key = callerKey(deps.env, deps.readText)
  const base = await resolveGateway({ env: deps.env, key, fetch: deps.fetch })
  deps.cache.base = base
  deps.cache.key = key
  deps.cache.model = preferredModel(deps.env, deps.readText)
  deps.cache.at = now
  return deps.cache
}

/** modelFor：参数点名的优先，其次设置里挑的，最后退到网关列出的第一个。 */
async function modelFor(args, g, deps) {
  const named = str(args?.model) || g.model
  if (named) return named
  const list = await imageModels({ base: g.base, key: g.key, fetch: deps.fetch })
  const first = list[0]?.id || ""
  if (!first) {
    throw new Error("magpie 里还没有能画图的模型：去 设置 › 模型 › 生图 选一个（或加一个生图供应商），再来。")
  }
  g.model = first
  return first
}

/** callImages：一次真实的画图请求（一张）。 */
async function callImages(opts, io) {
  const images = await drawOnce({
    ...opts,
    fetch: io.fetch,
    signal: anySignal([io.signal, AbortSignal.timeout(JOB_TIMEOUT_MS)]),
  })
  return { ...images, images: await inlineImages(images.images, io) }
}

/** inlineImages：网关只给了 URL 的图，取回来补成 base64（我们的契约是 base64）。 */
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

/**
 * draw：generate 和 edit 共用的流程（起后台任务 → 等一小会儿 → 交结果或 jobId）。
 * mode 只有 "generate" 和 "edit"，区别就是要不要参考图。
 */
async function draw(mode, args, ctx, deps) {
  const prompt = str(args?.prompt)
  if (!prompt) throw new Error("prompt 不能为空：说清楚要画什么，或要把它改成什么样")
  const n = clampInt(args?.n, 1, 1, 4)
  const waitSeconds = clampInt(args?.waitSeconds, deps.waitSeconds, 1, MAX_WAIT_SECONDS)

  const io = deps.io(ctx)
  const g = await gatewayFor(deps)
  const model = await modelFor(args, g, deps)

  let references = []
  if (mode === "edit") {
    const srcs = imageInputs(args)
    if (!srcs.length) {
      throw new Error("edit_image 需要 images：一张或几张参考图（base64、data URL、http(s) 地址或本机路径）")
    }
    if (srcs.length > 16) throw new Error("edit_image 最多 16 张参考图")
    references = (await Promise.all(srcs.map((s) => readImage(s, io)))).map(dataURL)
  }

  const one = {
    base: g.base,
    key: g.key,
    model,
    prompt,
    size: str(args?.size),
    quality: str(args?.quality),
    background: str(args?.background),
    references,
  }

  // 一张一个请求：不少中转会忽略 n，逐张请求才拿得到想要的张数；同时最多跑 4 路。
  const pictures = []
  const errors = []
  let next = 0
  const job = deps.jobs.start(async (signal) => {
    const lanes = Array.from({ length: Math.min(n, 4) }, async () => {
      while (next < n) {
        next += 1
        try {
          const one2 = await callImages(one, { ...io, signal })
          pictures.push(...one2.images)
        } catch (e) {
          errors.push(e instanceof Error ? e : new Error(String(e)))
        }
      }
    })
    await Promise.all(lanes)
    if (!pictures.length) throw errors[0] || new Error("画图失败")
    return { images: pictures, model }
  })
  return settle(job.id, model, waitSeconds, ctx, deps)
}

/** clampInt：整数夹在 [lo, hi] 里，非数字用兜底值。 */
function clampInt(v, fallback, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), lo), hi)
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
  return draw("generate", args, ctx, deps)
}

/** editImage：图生图（给定参考图 + 改图说明）。 */
export function editImage(args, ctx, deps) {
  return draw("edit", args, ctx, deps)
}

/** imageResult：按 jobId 去要还在画的那张图。 */
export async function imageResult(args, ctx, deps) {
  const id = str(args?.jobId)
  if (!id) throw new Error("jobId 不能为空：用 generate_image 或 edit_image 返回的 jobId")
  const waitSeconds = clampInt(args?.waitSeconds, deps.waitSeconds, 1, MAX_WAIT_SECONDS)
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
  const g = deps.cache
  return runningAnswer(id, g.model || "", waitSeconds)
}

/**
 * depsFor：把运行时依赖聚在一起，index.js 只用这一个入口。
 * 只有 jobs 是状态，其余都是「怎么拿到东西」的函数，测试里换成假的即可。
 */
export function depsFor({ jobs, log, fetchImpl, readText, env, now, waitSeconds }) {
  return {
    jobs,
    log,
    fetch: fetchImpl ?? globalThis.fetch,
    readText: readText ?? ((file) => fs.readFileSync(file, "utf8")),
    env: env ?? process.env,
    now: now ?? (() => Date.now()),
    waitSeconds: waitSeconds ?? 40,
    cache: { at: 0, base: "", key: "", model: "" },
    io: (ctx) => ({
      fetch: fetchImpl ?? globalThis.fetch,
      readFileBytes: (p) => fs.readFileSync(p),
      log,
      signal: ctx?.abort,
    }),
  }
}
