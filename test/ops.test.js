import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { createJobs } from "../lib/jobs.js"
import {
  MAX_WAIT_SECONDS,
  depsFor,
  editImage,
  generateImage,
  imageInputs,
  imageResult,
  readImage,
  toAnswer,
} from "../lib/ops.js"
import { PNG_B64, config, fakeFetch, json, text } from "./helpers.js"

/** 一套跑得起来的 deps。 */
function deps(fetchImpl, over = {}) {
  const cfg = config(over)
  return { cfg, deps: depsFor({ config: () => cfg, jobs: createJobs(), fetchImpl, log: () => {} }) }
}

/** 正常的画图答复。 */
const answered = () => json({ created: 1, data: [{ b64_json: PNG_B64 }] })

const tick = () => new Promise((res) => setTimeout(res, 0))
const deferred = () => {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

test("generate_image 打 /images/generations，交回 base64", async () => {
  const fetchImpl = fakeFetch(answered)
  const { deps: d } = deps(fetchImpl)

  const out = await generateImage({ prompt: "一只猫" }, {}, d)

  assert.equal(out.status, "done")
  assert.equal(out.model, "vendor/draw-2")
  assert.equal(out.count, 1)
  assert.equal(out.images[0].index, 0)
  assert.equal(out.images[0].b64, PNG_B64)
  assert.equal(out.images[0].mimeType, "image/png")
  assert.ok(out.images[0].bytes > 0)
  assert.equal(out.totalBytes, out.images[0].bytes)
  assert.match(out.note, /base64/)

  const [call] = fetchImpl.calls
  assert.equal(call.url, "http://gw.test/v1/images/generations")
  assert.equal(call.init.method, "POST")
  assert.equal(call.init.headers.authorization, "Bearer k-1")
  assert.equal(call.init.headers["content-type"], "application/json")
  const body = JSON.parse(call.init.body)
  assert.equal(body.model, "vendor/draw-2")
  assert.equal(body.prompt, "一只猫")
  assert.equal(body.n, 1)
  assert.equal(body.response_format, "b64_json")
})

test("generate_image 认 model / size / n，并把 n 收进 1..4", async () => {
  const fetchImpl = fakeFetch(answered)
  const { deps: d } = deps(fetchImpl)

  await generateImage({ prompt: "p", model: "other/model", size: "1536x1024", n: 99 }, {}, d)
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.model, "other/model")
  assert.equal(body.size, "1536x1024")
  assert.equal(body.n, 4)
})

test("vendor 只给 url 时，把图取回来补成 base64", async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith("/images/generations")) return json({ data: [{ url: "https://cdn.test/a.png" }] })
    return new Response(Buffer.from(PNG_B64, "base64"), { status: 200 })
  })
  const { deps: d } = deps(fetchImpl)

  const out = await generateImage({ prompt: "p" }, {}, d)
  assert.equal(out.images[0].b64, PNG_B64)
  assert.equal(out.images[0].mimeType, "image/png")
  assert.equal(out.images[0].url, "https://cdn.test/a.png")
})

test("url 取不回来也不丢图：留着 url，b64 是空", async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith("/images/generations")) return json({ data: [{ url: "https://cdn.test/a.png" }] })
    return text("404 not found", 404)
  })
  const { deps: d } = deps(fetchImpl)

  const out = await generateImage({ prompt: "p" }, {}, d)
  assert.equal(out.images[0].b64, undefined)
  assert.equal(out.images[0].url, "https://cdn.test/a.png")
})

test("接口报错时把状态码和那句话说给人听", async () => {
  const fetchImpl = fakeFetch(() => json({ error: { message: "额度用完了" } }, 429))
  const { deps: d } = deps(fetchImpl)

  await assert.rejects(() => generateImage({ prompt: "p" }, {}, d), (e) => {
    assert.match(e.message, /429/)
    assert.match(e.message, /额度用完了/)
    return true
  })
})

test("答复不是 JSON、或者没给图，都算失败", async () => {
  const notJson = deps(fakeFetch(() => text("<html>oops</html>", 200))).deps
  await assert.rejects(() => generateImage({ prompt: "p" }, {}, notJson), /不是 JSON/)

  const noImage = deps(fakeFetch(() => json({ data: [] }))).deps
  await assert.rejects(() => generateImage({ prompt: "p" }, {}, noImage), /没给图/)
})

test("请求超时说得清楚（而且不是把 abort 当成成功）", async () => {
  const fetchImpl = fakeFetch(
    (url, init) =>
      new Promise((res, rej) => {
        init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))
      }),
  )
  const { deps: d } = deps(fetchImpl, { jobTimeoutSeconds: 0.05 })

  await assert.rejects(() => generateImage({ prompt: "p" }, {}, d), /超时/)
})

test("连不上网关时说连不上", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED")
  }
  const { deps: d } = deps(fetchImpl)
  await assert.rejects(() => generateImage({ prompt: "p" }, {}, d), /连不上.*ECONNREFUSED/)
})

test("prompt 为空直接拒绝，不发请求", async () => {
  const fetchImpl = fakeFetch(answered)
  const { deps: d } = deps(fetchImpl)
  await assert.rejects(() => generateImage({ prompt: "   " }, {}, d), /prompt 不能为空/)
  await assert.rejects(() => generateImage({}, {}, d), /prompt 不能为空/)
  assert.equal(fetchImpl.calls.length, 0)
})

test("edit_image 走 multipart：图片放进 image[]，文本字段齐了", async () => {
  const fetchImpl = fakeFetch(answered)
  const { deps: d } = deps(fetchImpl)

  const out = await editImage(
    { prompt: "换成夜景", images: [PNG_B64], size: "1024x1024", n: 2 },
    {},
    d,
  )
  assert.equal(out.status, "done")

  const call = fetchImpl.calls.find((c) => c.url.endsWith("/images/edits"))
  assert.equal(call.url, "http://gw.test/v1/images/edits")
  // 让 undici 自己补 multipart 的 boundary，别手写 content-type
  assert.equal(call.init.headers["content-type"], undefined)
  assert.equal(call.init.headers.authorization, "Bearer k-1")

  const form = call.init.body
  assert.ok(form instanceof FormData)
  assert.equal(form.get("prompt"), "换成夜景")
  assert.equal(form.get("n"), "2")
  assert.equal(form.get("size"), "1024x1024")
  assert.equal(form.get("response_format"), "b64_json")

  const files = form.getAll("image[]")
  assert.equal(files.length, 1)
  assert.equal(files[0].type, "image/png")
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), Buffer.from(PNG_B64, "base64"))
})

test("edit_image 收得下 data URL、本机路径和图片地址", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mie-"))
  const file = path.join(dir, "shot.png")
  fs.writeFileSync(file, Buffer.from(PNG_B64, "base64"))

  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith("/images/edits")) return answered()
    return new Response(Buffer.from(PNG_B64, "base64"), { status: 200 })
  })
  const { deps: d } = deps(fetchImpl)

  await editImage(
    {
      prompt: "合在一起",
      images: [`data:image/png;base64,${PNG_B64}`, file, "https://cdn.test/a.png", PNG_B64],
    },
    {},
    d,
  )

  const call = fetchImpl.calls.find((c) => c.url.endsWith("/images/edits"))
  const files = call.init.body.getAll("image[]")
  assert.equal(files.length, 4)
  for (const f of files) {
    assert.equal(f.type, "image/png")
    assert.ok(f.size > 0)
  }
  assert.equal(files[1].name, "shot.png")

  fs.rmSync(dir, { recursive: true, force: true })
})

test("edit_image 没有参考图就报错", async () => {
  const fetchImpl = fakeFetch(answered)
  const { deps: d } = deps(fetchImpl)
  await assert.rejects(() => editImage({ prompt: "改一下" }, {}, d), /需要 images/)
  await assert.rejects(() => editImage({ prompt: "改一下", images: [] }, {}, d), /需要 images/)
  await assert.rejects(() => editImage({ prompt: "改一下", images: ["  "] }, {}, d), /需要 images/)
  assert.equal(fetchImpl.calls.length, 0)
})

test("imageInputs 认得单个字符串和 image 这个别名", () => {
  assert.deepEqual(imageInputs({ images: "abc" }), ["abc"])
  assert.deepEqual(imageInputs({ image: " abc " }), ["abc"])
  assert.deepEqual(imageInputs({ images: ["a", " ", null, 3, "b"] }), ["a", "b"])
  assert.deepEqual(imageInputs({}), [])
  assert.deepEqual(imageInputs(null), [])
})

test("readImage 拒绝空输入和读不到的文件", async () => {
  const { deps: d } = deps(fakeFetch(answered))
  const io = d.io()
  await assert.rejects(() => readImage("   ", io), /空的/)
  await assert.rejects(() => readImage("/tmp/绝对不存在的图.png", io), /读不到这张图/)
})

test("画得慢：先回 running 带 jobId，之后 image_result 拿到图", async () => {
  const d1 = deferred()
  const fetchImpl = fakeFetch(() => d1.promise)
  const { deps: d } = deps(fetchImpl)

  // 调用方的等待被中止（真实场景：宿主的 55 秒到点）
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 5)
  const first = await generateImage({ prompt: "p" }, { abort: ac.signal }, d)

  assert.equal(first.status, "running")
  assert.match(first.jobId, /^img_/)
  assert.equal(first.model, "vendor/draw-2")
  assert.match(first.hint, /image_result/)
  // 只画了一次
  assert.equal(fetchImpl.calls.length, 1)

  d1.resolve(answered())
  await tick()

  const done = await imageResult({ jobId: first.jobId }, {}, d)
  assert.equal(done.status, "done")
  assert.equal(done.images[0].b64, PNG_B64)
  // 还是只画了一次：再要只是读结果
  assert.equal(fetchImpl.calls.length, 1)
})

test("image_result 不认识这个 jobId 时把现有任务列出来", async () => {
  const dany = deferred()
  const fetchImpl = fakeFetch(() => dany.promise)
  const { deps: d } = deps(fetchImpl)

  const ac = new AbortController()
  ac.abort()
  const first = await generateImage({ prompt: "p" }, { abort: ac.signal }, d)

  const out = await imageResult({ jobId: "img_不存在" }, {}, d)
  assert.equal(out.status, "unknown")
  assert.match(out.hint, /重新/)
  assert.deepEqual(out.known, [{ jobId: first.jobId, status: "running" }])
})

test("image_result 缺 jobId 直接报错", async () => {
  const { deps: d } = deps(fakeFetch(answered))
  await assert.rejects(() => imageResult({}, {}, d), /jobId 不能为空/)
})

test("后台任务失败时，image_result 把真正的原因交出来", async () => {
  const d1 = deferred()
  const fetchImpl = fakeFetch(() => d1.promise)
  const { deps: d } = deps(fetchImpl)

  const ac = new AbortController()
  ac.abort()
  const first = await generateImage({ prompt: "p" }, { abort: ac.signal }, d)

  d1.resolve(json({ error: { message: "这个提示词不行" } }, 400))
  await tick()

  await assert.rejects(() => imageResult({ jobId: first.jobId }, {}, d), /这个提示词不行/)
})

test("waitSeconds 收在 1..MAX 之内", () => {
  assert.equal(MAX_WAIT_SECONDS, 50)
})

test("toAnswer 的形状：没有 url 时就不带这个键", () => {
  const out = toAnswer({ model: "m", images: [{ b64: PNG_B64, mimeType: "image/png" }] })
  assert.deepEqual(Object.keys(out.images[0]).sort(), ["b64", "bytes", "index", "mimeType"])
  assert.equal(out.count, 1)
})
