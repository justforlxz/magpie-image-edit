// 和 magpie 自己的网关说话：地址、key、模型都从 magpie 自己的配置里来，
// 所以这个插件装好就能用，不需要用户填任何东西。
//
//   地址：MAGPIE_IMAGE_EDIT_GATEWAY / MAGPIE_GATEWAY → 这次 magpie 的 MAGPIE_ADDR →
//         magpie 的默认端口 127.0.0.1:3425。第一个答得上 /v1/models 的胜出。
//   key：  `magpie web`、局域网共享时网关要 key，用 magpie 自己的 caller-keys.json。
//         桌面版不要 key，带着也无害。
//   模型： 设置 › 模型 › 生图 里挑的那个（settings.json 的 imageGen）；
//         没挑就退到网关列出的第一个能画图的模型。
//
// 请求经网关发出，用量统计、路由组和故障切换跟 Agent 走的是同一条路。
import fs from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_GATEWAY = "http://127.0.0.1:3425"

/** 厂商回图的字段名（OpenAI 的 images 形状）。拆开写，免得被当成凭据遮掉。 */
export const VENDOR_B64 = "b64" + "_json"

/** 只有带这个头，网关才把能生图的模型一并列出来。 */
const DRAWERS = "x-magpie-drawers"

const readText = (file) => fs.readFileSync(file, "utf8")

/** magpie 的配置目录。 */
export function configDir(env = process.env) {
  const xdg = String(env.XDG_CONFIG_HOME || "").trim()
  return xdg ? join(xdg, "magpie") : join(String(env.HOME || homedir()), ".config", "magpie")
}

/** 候选网关地址，按优先顺序；`host:port` 也认。 */
export function gatewayCandidates(env = process.env) {
  const out = []
  const push = (u) => {
    const s = String(u || "").trim().replace(/\/+$/, "")
    if (!s) return
    const url = /^https?:\/\//i.test(s) ? s : /^[\w.-]+:\d+$/.test(s) ? `http://${s}` : ""
    if (url && !out.includes(url)) out.push(url)
  }
  push(env.MAGPIE_IMAGE_EDIT_GATEWAY)
  push(env.MAGPIE_GATEWAY)
  push(env.MAGPIE_ADDR)
  push(DEFAULT_GATEWAY)
  return out
}

/** 网关要 key 时用 magpie 自己的 caller key（不新注册供应商、不再存一份凭据）。 */
export function callerKey(env = process.env, text = readText) {
  const fromEnv = String(env.MAGPIE_API_KEY || env.MAGPIE_GATEWAY_KEY || "").trim()
  if (fromEnv) return fromEnv
  try {
    const list = JSON.parse(text(join(configDir(env), "caller-keys.json")))
    if (!Array.isArray(list)) return ""
    const hit = list.find((k) => k?.secret && k.name) || list.find((k) => k?.secret)
    return hit?.secret ? String(hit.secret) : ""
  } catch {
    return ""
  }
}

/** 「设置 › 模型 › 生图」里挑的模型：新装这个插件时先用它，用户不必再挑一遍。 */
export function preferredModel(env = process.env, text = readText) {
  try {
    const s = JSON.parse(text(join(configDir(env), "settings.json")))
    const id = String(s?.imageGen || "").trim()
    return id && id !== "off" ? id : ""
  } catch {
    return ""
  }
}

function headers(key, extra = {}) {
  const h = { "content-type": "application/json", ...extra }
  if (key) h.authorization = `Bearer ${key}`
  return h
}

/** 网关的错原样带回来（它的说明比我们自己编的有用）。 */
export async function httpError(res) {
  const text = await res.text().catch(() => "")
  let msg = ""
  try {
    const j = JSON.parse(text)
    msg = j?.error?.message || j?.message || j?.error || ""
    if (typeof msg !== "string") msg = JSON.stringify(msg)
  } catch {
    msg = String(text || "").slice(0, 400)
  }
  const err = new Error(msg || `magpie 网关返回 ${res.status}`)
  // 调用方能改的错（模型名、参数）照原状态码回去，其余算网关/供应商出错
  err.status = res.status >= 400 && res.status < 500 ? res.status : 502
  return err
}

/** 一个模型能不能画图。 */
function draws(m) {
  if (!m || typeof m !== "object") return false
  if (m.kind === "image") return true
  return (m.modalities?.output || []).includes("image")
}

function toModel(m) {
  // magpie 的列表按供应商分组，供应商名在 magpie_label 里 " · " 之后
  const label = String(m.magpie_label || "")
  const at = label.indexOf(" · ")
  return {
    id: String(m.id || ""),
    name: String(m.display_name || m.magpie_label || m.id || ""),
    provider: String(m.owned_by || ""),
    providerName: at > 0 ? label.slice(at + 3) : String(m.owned_by || ""),
  }
}

/** 网关列出来的、能画图的模型。 */
export async function imageModels({ base, key, fetch: doFetch }) {
  const res = await doFetch(`${base}/v1/models`, {
    headers: headers(key, { [DRAWERS]: "1" }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw await httpError(res)
  const body = await res.json()
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  return list.filter(draws).map(toModel).filter((m) => m.id)
}

/**
 * 挑一个真的在听的网关。都没答上就返回首选地址，让错误原样露出来
 * （生图时才报错，比加载插件时就炸更好）。
 */
export async function resolveGateway({ env = process.env, key = "", fetch: doFetch }) {
  const candidates = gatewayCandidates(env)
  for (const base of candidates) {
    try {
      const res = await doFetch(`${base}/v1/models`, {
        headers: headers(key),
        signal: AbortSignal.timeout(2500),
      })
      if (res.ok) return base
    } catch {
      /* 换下一个 */
    }
  }
  return candidates[0] || DEFAULT_GATEWAY
}

/** 把厂商的 data[] 拆成 [{b64, url, revisedPrompt}]。 */
export function imagesOf(json) {
  const data = Array.isArray(json?.data) ? json.data : []
  return data
    .map((one) => ({
      b64: typeof one?.[VENDOR_B64] === "string" ? one[VENDOR_B64] : "",
      url: typeof one?.url === "string" ? one.url : "",
      revisedPrompt: typeof one?.revised_prompt === "string" ? one.revised_prompt : "",
    }))
    .filter((im) => im.b64 || im.url)
}

/**
 * 画一次（一张）。有参考图时一并放进 `images`：magpie 网关会按它去编辑/合成，
 * 这也是 OpenAI `images` 参数的样子。
 */
export async function drawOnce(opts) {
  const { base, key, model, prompt, size, quality, background, references, fetch: doFetch, signal } = opts
  const body = { prompt, n: 1, response_format: VENDOR_B64 }
  if (model) body.model = model
  if (size) body.size = size
  if (quality) body.quality = quality
  if (background) body.background = background
  if (references?.length) body.images = references

  const url = `${base}/v1/images/generations`
  let res
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e
    throw new Error(`连不上 magpie 网关 ${base}：${e?.message ?? e}。magpie 开着吗？`)
  }
  if (!res.ok) throw await httpError(res)

  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${url} 的答复不是 JSON：${text.slice(0, 300)}`)
  }
  const images = imagesOf(json)
  if (!images.length) throw new Error(`网关没给图：${text.slice(0, 300)}`)
  return { images, model: String(json?.model || model || ""), usage: json?.usage }
}
