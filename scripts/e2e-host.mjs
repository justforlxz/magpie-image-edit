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

const skip = (why) => {
  console.log(`跳过 e2e：${why}`)
  process.exit(0)
}
if (!fs.existsSync(hostFile)) skip(`${hostFile} 不存在（用 MAGPIE_DIR 指到 magpie 源码树）`)

// 假的 vendor：记下请求，回一张 1x1 PNG（OpenAI 的 images API 形状）
const seen = []
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body })
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }))
  })
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port

// 设置目录：配置文件放这里，指向上面那个假 vendor
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-image-edit-e2e-"))
fs.writeFileSync(
  path.join(directory, "magpie-image-edit.json"),
  JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k-e2e", model: "vendor/draw-2", waitSeconds: 20 }),
)

const proc = spawn("bun", [hostFile], { stdio: ["pipe", "pipe", "pipe"] })
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

try {
  const init = await rpc("init", {
    plugins: [{ spec: "magpie-image-edit", target: pluginDir }],
    directory,
    authPath: path.join(directory, "auth.json"),
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
  check(gen.status === "done" && gen.images?.[0]?.b64?.length > 0, "generate_image 一路打到接口并回 base64")
  check(seen.at(-1)?.url === "/v1/images/generations", "generate 走的是 /images/generations")
  check(seen.at(-1)?.auth === "Bearer k-e2e", "带上了配置文件里的 apiKey")

  const edit = payload(
    await rpc("tool", { spec: "magpie-image-edit", name: "edit_image", args: { prompt: "换成夜景", images: [PNG] }, ms: 30000 }),
  )
  check(edit.status === "done" && edit.images?.[0]?.b64?.length > 0, "edit_image 交得出改好的图")
  check(String(seen.at(-1)?.type).startsWith("multipart/form-data"), "edit 走 multipart")
  check(seen.at(-1)?.body.includes('name="image[]"'), "参考图放在 image[] 字段里")

  const unknown = payload(await rpc("tool", { spec: "magpie-image-edit", name: "image_result", args: { jobId: "img_不存在" }, ms: 5000 }))
  check(unknown.status === "unknown", "不认识的 jobId 说 unknown，而不是炸掉")
} catch (e) {
  check(false, `跑通了：${e?.message ?? e}`)
} finally {
  proc.kill("SIGKILL")
  server.close()
  fs.rmSync(directory, { recursive: true, force: true })
}

if (failures.length) {
  if (stderr.length) console.error(stderr.join("").slice(0, 2000))
  console.error(`\n${failures.length} 项没过`)
  process.exit(1)
}
console.log("\n宿主契约没变，工具都能用")
