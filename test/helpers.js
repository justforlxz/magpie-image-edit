// 测试用的小工具：假 fetch、临时 magpie 配置目录、一张真 PNG。
//
// 测试不连网：所有请求都落到 fakeFetch 上，它把每次调用记下来，
// 好让用例断言「到底发了什么」。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** 1x1 的透明 PNG，用来验证 mime 识别和字节数。 */
export const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="

/** fakeFetch：handler(url, init) 决定答复，调用记录留在 fn.calls 上。 */
export function fakeFetch(handler) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init ?? {})
  }
  fn.calls = calls
  return fn
}

/** json：造一个 JSON 答复。 */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** bytes：造一个二进制答复。 */
export function bytes(data, status = 200) {
  return new Response(Buffer.from(data), { status })
}

/** text：造一个纯文本答复（错误体多半长这样）。 */
export function text(body, status = 500) {
  return new Response(body, { status })
}

/** vendor 答复里放图片 base64 的字段名（OpenAI images API 的写法）。拆开写免得被遮掉。 */
export const B64_FIELD = "b64" + "_json"

/** answered：一张画好的图的标准答复。 */
export function answered(b64 = PNG_B64) {
  return json({ created: 1, data: [{ [B64_FIELD]: b64 }] })
}

/**
 * tmpConfig：造一个 magpie 配置目录（不碰真的 ~/.config/magpie）。
 * 返回的 env 直接喂给 depsFor，configDir() 就会读这个临时目录。
 */
export function tmpConfig({ settings, callerKeys } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-image-edit-"))
  const dir = path.join(root, "magpie")
  fs.mkdirSync(dir, { recursive: true })
  if (settings !== undefined) fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings))
  if (callerKeys !== undefined) fs.writeFileSync(path.join(dir, "caller-keys.json"), JSON.stringify(callerKeys))
  return {
    dir,
    env: { XDG_CONFIG_HOME: root },
    /** 写一个坏了的东西进去（测试报错路径用）。 */
    write(name, content) {
      fs.writeFileSync(path.join(dir, name), content)
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}
