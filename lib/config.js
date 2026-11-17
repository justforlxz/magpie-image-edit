// 配置：magpie 设置目录里的 magpie-image-edit.json，环境变量覆盖它。
//
// 插件宿主以 magpie 的设置目录为 cwd（host.js: "directory": settings.Dir()），
// 所以 ctx.directory 就是那个目录；配置文件放在这里，插件更新不会覆盖它。
//
//   {
//     "baseUrl": "http://127.0.0.1:3425/v1",
//     "apiKey": "…",
//     "model": "gpt-image-1",
//     "waitSeconds": 40,
//     "jobTimeoutSeconds": 300,
//     "responseFormat": "b64_json"
//   }
import path from "node:path"

/** magpie 设置目录下的配置文件名。 */
export const CONFIG_FILE = "magpie-image-edit.json"

/** 没配置时用的一整套默认值。 */
export const DEFAULTS = Object.freeze({
  // 默认打 magpie 自己的图片接口：它已经把各家 vendor 的差异抹平了，
  // 用哪个图片模型由「设置 → 模型 → 图片生成」决定。
  baseUrl: "http://127.0.0.1:3425/v1",
  apiKey: "",
  model: "gpt-image-1",
  // 一次工具调用最多等多久（宿主给插件工具 55 秒，留出传输余量）。
  waitSeconds: 40,
  // 一张图在后台最多画多久；超过按失败处理。
  jobTimeoutSeconds: 300,
  // 想直接连 gpt-image-1 这类不认 response_format 的接口时，设成 ""。
  responseFormat: "b64_json",
})

/** 每个字段对应的环境变量，先找到的先用。 */
const ENV = {
  baseUrl: ["MAGPIE_IMAGE_EDIT_BASE_URL", "MAGPIE_IMAGE_API_BASE"],
  apiKey: ["MAGPIE_IMAGE_EDIT_API_KEY", "MAGPIE_IMAGE_API_KEY"],
  model: ["MAGPIE_IMAGE_EDIT_MODEL", "MAGPIE_IMAGE_MODEL"],
  responseFormat: ["MAGPIE_IMAGE_EDIT_RESPONSE_FORMAT"],
}

/**
 * normalizeBaseUrl：把用户给的地址归一成「指到 /v1 为止」。
 * 尾随斜杠、查询串、以及直接粘过来的 /images/generations 都会被去掉，
 * 没写 scheme 的补 http://。空串返回空串。
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== "string") return ""
  let s = raw.trim()
  if (!s) return ""
  s = s.replace(/[?#].*$/, "")
  s = s.replace(/\/+$/, "")
  s = s.replace(/\/images\/(generations|edits)$/i, "")
  s = s.replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(s)) s = "http://" + s
  return s
}

/** clampNumber：把 v 收进 [min, max]，不是有限数就用 fallback。 */
export function clampNumber(v, fallback, min, max) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** clampInt：同 clampNumber，取整。 */
export function clampInt(v, fallback, min, max) {
  return Math.round(clampNumber(v, fallback, min, max))
}

/** readConfig：容错地读一段 JSON 文本，读不出来返回 null，绝不抛。 */
export function readConfig(text) {
  if (typeof text !== "string" || !text.trim()) return null
  let v
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  return v
}

/** 空串和 undefined 都算「没说」。 */
function said(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : ""
}

/**
 * mergeConfig：文件里的值垫底，环境变量覆盖它，最后补默认值并归一。
 * 纯函数：只依赖传进来的两个对象。
 */
export function mergeConfig(file, env = {}) {
  const f = file && typeof file === "object" ? file : {}
  const pick = (key) => {
    for (const name of ENV[key] ?? []) {
      const v = said(env[name])
      if (v) return v
    }
    return said(f[key])
  }
  return {
    baseUrl: normalizeBaseUrl(pick("baseUrl")) || DEFAULTS.baseUrl,
    apiKey: pick("apiKey"),
    model: pick("model") || DEFAULTS.model,
    waitSeconds: clampNumber(f.waitSeconds, DEFAULTS.waitSeconds, 1, 50),
    jobTimeoutSeconds: clampNumber(f.jobTimeoutSeconds, DEFAULTS.jobTimeoutSeconds, 10, 3600),
    // "" 是「不要这个字段」的意思，所以这里不能用 said()
    responseFormat: pick("responseFormat") || (f.responseFormat === "" ? "" : DEFAULTS.responseFormat),
  }
}

/** 配置文件在哪：MAGPIE_IMAGE_EDIT_CONFIG 指定绝对路径，否则用设置目录。 */
export function configPath(directory, env = {}) {
  const named = said(env.MAGPIE_IMAGE_EDIT_CONFIG)
  if (named) return named
  return path.join(said(directory) || ".", CONFIG_FILE)
}

/**
 * resolveConfig：读配置文件再合并环境变量。
 * readFile 可注入（测试用）。读不到文件算「没配置」，但文件写坏了要报出来。
 */
export function resolveConfig({ directory = "", env = {}, readFile } = {}) {
  const file = configPath(directory, env)
  let text = ""
  if (typeof readFile === "function") {
    try {
      text = readFile(file) ?? ""
    } catch {
      text = ""
    }
  }
  const parsed = readConfig(text)
  // 文件读不到 = 没配置，用默认值；但写成坏 JSON 是笔误，不能当没看见
  if (parsed === null && String(text).trim()) {
    throw new Error(`${file} 不是合法的配置：要一个 JSON 对象，比如 {"baseUrl":"http://…/v1","apiKey":"…","model":"provider/model"}`)
  }
  return { ...mergeConfig(parsed, env), configFile: file }
}

/** shownConfig：能说给人听的那部分配置（key 只说有没有）。 */
export function shownConfig(cfg) {
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKeySet: Boolean(cfg.apiKey),
    configFile: cfg.configFile,
  }
}
