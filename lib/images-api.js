// 只做数据变换的那一层：不碰网络、不碰磁盘，全是可以直接单测的纯函数。
//
// 线上协议按 OpenAI 的图片接口来：生成走 JSON，编辑走 multipart（OpenAI
// 只认 multipart，magpie 网关两种都认），回来的图要 b64_json。

/** 认一下 base64 里装的是什么图，认不出留空。 */
export function sniffMime(b64) {
  if (typeof b64 !== "string" || b64.length < 8) return ""
  const head = Buffer.from(b64.slice(0, 24), "base64")
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png"
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg"
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp"
  if (head.length >= 6 && head.toString("latin1", 0, 3) === "GIF") return "image/gif"
  return ""
}

const B64 = /^[A-Za-z0-9+/=\r\n]+$/
const DATA_URL = /^data:([^;,]*)?(;[^,]*)?,/i

/**
 * classifyImageSource：判断调用方给的一串东西是什么。
 * data URL / http(s) URL / file:// / 本地路径 / 裸 base64。
 */
export function classifyImageSource(src) {
  if (typeof src !== "string") return { kind: "empty" }
  const s = src.trim()
  if (!s) return { kind: "empty" }
  if (DATA_URL.test(s)) return { kind: "data" }
  if (/^https?:\/\//i.test(s)) return { kind: "url" }
  if (/^file:\/\//i.test(s)) return { kind: "file" }
  // base64 的字母表里也有 /，所以不能靠「有没有 /」区分，得看它解出来是不是图。
  // 只有整串都在 base64 字母表里才值得试着解（路径里一定带 . : \ 之类）。
  if (B64.test(s) && sniffMime(s)) return { kind: "base64" }
  // 像路径的样子：/ . ~ 开头、盘符开头，或带图片后缀
  if (/^[/~.]/.test(s) || /^[A-Za-z]:[\\/]/.test(s)) return { kind: "path" }
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(s)) return { kind: "path" }
  // 又长又干净的一串：当 base64
  if (s.length >= 64 && B64.test(s)) return { kind: "base64" }
  return { kind: "path" }
}

/** b64ToDataUrl：裸 base64 补成 data URL（mime 认不出就当 png）。 */
export function b64ToDataUrl(b64, mime) {
  const s = String(b64 ?? "").replace(/\s+/g, "")
  if (!s) return ""
  return `data:${mime || sniffMime(s) || "image/png"};base64,${s}`
}

/** 尺寸大小的说法原样透传，不认识的由 vendor 去报错。 */
function field(v) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  if (typeof v === "string" && v.trim()) return v.trim()
  return ""
}

/** 调用方给的额外字段：只留能安全透传的标量。 */
export function extraFields(extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return {}
  const out = {}
  for (const [k, v] of Object.entries(extra)) {
    if (!k || k.length > 64) continue
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v
  }
  return out
}

/**
 * buildGenerateBody：/images/generations 的 JSON 体。
 * 只写调用方真给了的字段，剩下的交给 vendor 的默认值。
 */
export function buildGenerateBody(cfg, p) {
  const body = { model: p.model, prompt: p.prompt, n: p.n }
  for (const k of ["size", "quality", "background", "outputFormat"]) {
    const v = field(p[k])
    if (v) body[k === "outputFormat" ? "output_format" : k] = v
  }
  if (cfg.responseFormat) body.response_format = cfg.responseFormat
  return { ...extraFields(p.extra), ...body }
}

/**
 * buildEditFields：/images/edits 的 multipart 文本字段。
 * 图片文件由调用方按 files 追加（见 editFiles）。
 */
export function buildEditFields(cfg, p) {
  const out = { model: p.model, prompt: p.prompt, n: String(p.n) }
  for (const k of ["size", "quality", "background", "outputFormat"]) {
    const v = field(p[k])
    if (v) out[k === "outputFormat" ? "output_format" : k] = v
  }
  if (cfg.responseFormat) out.response_format = cfg.responseFormat
  return { ...extraFields(p.extra), ...out }
}

/** multipart 里图片的字段名：OpenAI 用 image[]，magpie 两种都认。 */
export const EDIT_FILE_FIELD = "image[]"

/** parseImagesResponse：把 vendor 的答复变成统一的 {created, model, images}。 */
export function parseImagesResponse(json) {
  const data = json && Array.isArray(json.data) ? json.data : []
  const images = []
  for (const e of data) {
    if (!e || typeof e !== "object") continue
    const b64 = typeof e.b64_json === "string" ? e.b64_json.replace(/\s+/g, "") : ""
    const url = typeof e.url === "string" ? e.url.trim() : ""
    if (!b64 && !url) continue
    images.push({
      b64,
      url,
      mimeType: typeof e.mime_type === "string" ? e.mime_type : sniffMime(b64),
      revisedPrompt: typeof e.revised_prompt === "string" ? e.revised_prompt : "",
    })
  }
  return {
    created: typeof json?.created === "number" ? json.created : 0,
    model: typeof json?.model === "string" ? json.model : "",
    text: typeof json?.text === "string" ? json.text : "",
    images,
  }
}

/** errorMessage：从 OpenAI 风格或纯文本的错误体里挑出一句能看懂的话。 */
export function errorMessage(body, status) {
  let detail = ""
  if (typeof body === "string") {
    const s = body.trim()
    if (s) {
      try {
        const j = JSON.parse(s)
        detail = typeof j?.error?.message === "string" ? j.error.message : typeof j?.message === "string" ? j.message : s
      } catch {
        detail = s
      }
    }
  } else if (body && typeof body === "object") {
    detail = typeof body.error?.message === "string" ? body.error.message : typeof body.message === "string" ? body.message : ""
  }
  detail = String(detail).replace(/\s+/g, " ").trim()
  if (detail.length > 800) detail = detail.slice(0, 800) + "…"
  return detail || `HTTP ${status}`
}
