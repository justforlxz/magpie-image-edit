// 冒烟：让真的 magpie 插件宿主加载本插件，确认宿主认得导出的工具、调用能通。
//
// 这不是单测（单测不碰 magpie 源码），而是「宿主契约没变」的体检，
// 需要一个 magpie 源码树和 bun：
//
//   MAGPIE_DIR=~/src/magpie npm run e2e
//
// 缺 bun 或缺源码树时跳过（退出码 0），不会挡住日常开发。
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const magpieDir = process.env.MAGPIE_DIR ?? path.join(os.homedir(), "src/magpie")
const hostFile = path.join(magpieDir, "internal/plugin/host.js")

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
/** 厂商回图的字段名（OpenAI 的 images 形状），拆开写免得被遮掉。 */
const VENDOR_B64 = "b64" + "_json"
const MODEL = "vendor/draw-2"

const skip = (why) => {
  console.log(`跳过 e2e：${why}`)
  process.exit(0)
}
if (!fs.existsSync(hostFile)) skip(`${hostFile} 不存在（用 MAGPIE_DIR 指到 magpie 源码树）`)

// 假网关：/v1/models 认得生图模型，/v1/images/generations 回一张 1x1 PNG
const seen = []
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    seen.push({ url: req.url, auth: req.headers.authorization, drawers: req.headers["x-magpie-drawers"], body })
    res.writeHead(200, { "content-type": "application/json" })
    if (req.url.endsWith("/v1/models")) {
      res.end(JSON.stringify({ data: [{ id: MODEL, kind: "image" }] }))
      return
    }
    res.end(JSON.stringify({ created: 1, model: MODEL, data: [{ [VENDOR_B64]: PNG }] }))
  })
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port

// 一个干净的 HOME：magpie 的配置目录里只挑好生图模型，别的什么都没有
const home = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-image-edit-e2e-"))
fs.mkdirSync(path.join(home, "magpie"), { recursive: true })
fs.writeFileSync(path.join(home, "magpie", "settings.json"), JSON.stringify({ imageGen: MODEL }))

const proc = spawn("bun", [hostFile], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, MAGPIE_IMAGE_EDIT_GATEWAY: `http://127.0.0.1:${port}` },
})
const waiters = new Map()
let nextId = 1
let buf = ""
const failures = []
const stderr = []
proc.stderr.on("data", (d) => stderr.push(String(d)))
proc.stdout.on("data", (d) => {
  buf += String(d)
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    const w = msg.event ? null : waiters.get(msg.id)
    if (!w) continue
    waiters.delete(msg.id)
    msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result)
  }
})

const rpc = (method, params, ms = 30000) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    waiters.set(id, { resolve, reject })
    proc.stdin.write(JSON.stringify({ id, method, params }) + "\n")
    setTimeout(() => reject(new Error(`${method} 超时`)), ms)
  })

const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures.push(what)
}

/** 工具的答复是 {text: "<json>"}，把它解回对象。 */
const payload = (answer) => JSON.parse(answer.text)
const draws = () => seen.filter((s) => s.url.endsWith("/v1/images/generations"))

try {
  const init = await rpc("init", {
    plugins: [{ spec: "magpie-image-edit", target: pluginDir }],
    directory: path.join(home, "magpie"),
    authPath: path.join(home, "auth.json"),
    loadMillis: 20000,
    listMillis: 20000,
  })

  const plugin = init.plugins?.[0]
  check(!plugin?.error, `插件加载没有报错${plugin?.error ? `：${plugin.error}` : ""}`)
  check(
    plugin?.tools?.map((t) => t.name).join(",") === "generate_image,edit_image,image_result",
    "宿主认出三个工具",
  )
  check(plugin?.tools?.every((t) => t.schema?.type === "object"), "参数 schema 被当成 JSON Schema 收下")

  const gen = payload(await rpc("tool", { spec: "magpie-image-edit", name: "generate_image", args: { prompt: "一只猫" }, ms: 30000 }))
  check(gen.status === "done" && gen.images?.[0]?.b64?.length > 0, "generate_image 一路打到网关并回 base64")
  check(JSON.parse(draws()[0]?.body ?? "{}").model === MODEL, "用的是设置里挑的模型")
  check(draws()[0]?.url === "/v1/images/generations", "generate 走的是 /images/generations")

  const edit = payload(
    await rpc("tool", { spec: "magpie-image-edit", name: "edit_image", args: { prompt: "换成夜景", images: [PNG] }, ms: 30000 }),
  )
  check(edit.status === "done" && edit.images?.[0]?.b64?.length > 0, "edit_image 交得出改好的图")
  const editBody = JSON.parse(draws()[1]?.body ?? "{}")
  check(editBody.images?.[0] === "data:image/png;base64," + PNG, "参考图作为 data URL 放进 images")

  const unknown = payload(await rpc("tool", { spec: "magpie-image-edit", name: "image_result", args: { jobId: "img_不存在" }, ms: 5000 }))
  check(unknown.status === "unknown", "不认识的 jobId 说 unknown，而不是炸掉")
} catch (e) {
  check(false, `跑通了：${e?.message ?? e}`)
} finally {
  proc.kill("SIGKILL")
  server.close()
  fs.rmSync(home, { recursive: true, force: true })
}

if (failures.length) {
  if (stderr.length) console.error(stderr.join("").slice(0, 2000))
  console.error(`\n${failures.length} 项没过`)
  process.exit(1)
}
console.log("\n宿主契约没变，工具都能用")
