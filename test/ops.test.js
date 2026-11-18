import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, test } from "node:test"

import { createJobs } from "../lib/jobs.js"
import { depsFor, editImage, generateImage, imageResult, readImage, toAnswer } from "../lib/ops.js"
import { PNG_B64, answered, bytes, fakeFetch, json, text, tmpConfig } from "./helpers.js"

/**
 * make：一套「装了插件、magpie 里已经配好」的环境。
 * 假网关同时管 /v1/models 和 /v1/images/generations，全都记账。
 */
function make({ settings, callerKeys, models = [], generations, waitSeconds, log } = {}) {
  const cfg = tmpConfig({ settings, callerKeys })
  const fetch = fakeFetch((url, init) => {
    if (url.endsWith("/v1/models")) return json({ data: models })
    if (generations) return generations(url, init)
    return answered()
  })
  const deps = depsFor({ jobs: createJobs(), fetchImpl: fetch, env: cfg.env, log: log ?? (() => {}), waitSeconds })
  return { cfg: track(cfg), fetch, deps }
}

/** 发往画图接口的那几次调用（跳过找网关、列模型的探活）。 */
const draws = (fetch) => fetch.calls.filter((c) => c.url.endsWith("/v1/images/generations"))

/* ---------- 开箱即用 ---------- */

test("装好就能用：模型取自「设置 › 模型 › 生图」，回的是 base64", async () => {
  const { cfg, fetch, deps } = make({ settings: { imageGen: "vendor/draw-2" } })

  const out = await generateImage({ prompt: "一只猫" }, {}, deps)

  assert.equal(out.status, "done")
  assert.equal(out.model, "vendor/draw-2")
  assert.equal(out.count, 1)
  assert.equal(out.images[0].b64, PNG_B64)
  assert.equal(out.images[0].mimeType, "image/png")
  assert.ok(out.images[0].bytes > 0)
  assert.ok(out.totalBytes >= out.images[0].bytes)
  assert.match(out.note, /base64/)

  const body = JSON.parse(draws(fetch)[0].init.body)
  assert.equal(body.model, "vendor/draw-2")
  assert.equal(body.prompt, "一只猫")
  // 要的是 base64，不是 URL
  assert.equal(body.response_format, "b64" + "_json")
})

test("设置里没挑模型：退到网关列出的第一个能画图的模型", async () => {
  const models = [
    { id: "vendor/chat", kind: "text" },
    { id: "vendor/draw", kind: "image" },
  ]
  const { cfg, fetch, deps } = make({ settings: {}, models })

  const out = await generateImage({ prompt: "p" }, {}, deps)
  assert.equal(out.model, "vendor/draw")

  // 列模型时要带 X-Magpie-Drawers，否则网关不给生图模型
  const listed = fetch.calls.filter((c) => c.url.endsWith("/v1/models") && c.init.headers["x-magpie-drawers"] === "1")
  assert.equal(listed.length, 1)
})

test("调用方点名的模型优先于设置", async () => {
  const { cfg, fetch, deps } = make({ settings: { imageGen: "vendor/draw-2" } })

  await generateImage({ prompt: "p", model: "vendor/other" }, {}, deps)
  assert.equal(JSON.parse(draws(fetch)[0].init.body).model, "vendor/other")
})

test("一个能画图的模型都没有：直接说去设置里选，而不是发一个空请求", async () => {
  const { cfg, fetch, deps } = make({ settings: {}, models: [] })

  await assert.rejects(() => generateImage({ prompt: "p" }, {}, deps), /设置 › 模型 › 生图/)
  assert.equal(draws(fetch).length, 0)
})

/* ---------- 图生图 ---------- */

test("图生图：参考图变成 data URL 放进 images，跟文生图走同一个接口", async () => {
  const { cfg, fetch, deps } = make({ settings: { imageGen: "vendor/draw-2" } })

  const out = await editImage({ prompt: "换成夜景", images: [PNG_B64] }, {}, deps)

  assert.equal(out.status, "done")
  const body = JSON.parse(draws(fetch)[0].init.body)
  assert.equal(body.prompt, "换成夜景")
  assert.deepEqual(body.images, ["data:image/png;base64," + PNG_B64])
})

test("参考图也可以是 data URL 或本机文件", async () => {
  const refDir = fs.mkdtempSync(path.join(os.tmpdir(), "mie-ref-"))
  const file = path.join(refDir, "ref.png")
  fs.writeFileSync(file, Buffer.from(PNG_B64, "base64"))

  const { fetch, deps } = make({ settings: { imageGen: "vendor/draw-2" } })
  try {
    const dataURL = "data:image/jpeg;base64," + PNG_B64
    await editImage({ prompt: "p", images: [dataURL, file] }, {}, deps)
    const body = JSON.parse(draws(fetch)[0].init.body)
    // data URL 原样带过去；本机文件读出来按内容认成 png
    assert.deepEqual(body.images, [dataURL, "data:image/png;base64," + PNG_B64])
  } finally {
    fs.rmSync(refDir, { recursive: true, force: true })
  }
})

test("参考图里的 http 地址会先取回来再交给网关", async () => {
  const fetchImpl = fakeFetch((url, init) => {
    if (url.endsWith("/v1/models")) return json({ data: [] })
    if (url === "http://pic.test/a.jpg") return bytes(Buffer.from(PNG_B64, "base64"))
    return answered()
  })
  const cfg = track(tmpConfig({ settings: { imageGen: "vendor/draw-2" } }))
  const deps = depsFor({ jobs: createJobs(), fetchImpl, env: cfg.env, log: () => {} })

  await editImage({ prompt: "p", images: ["http://pic.test/a.jpg"] }, {}, deps)
  const body = JSON.parse(draws(fetchImpl)[0].init.body)
  assert.deepEqual(body.images, ["data:image/png;base64," + PNG_B64])
})

test("没给参考图 / 没给 prompt：当场说清楚", async () => {
  const { cfg, deps } = make({ settings: { imageGen: "vendor/draw-2" } })

  await assert.rejects(() => editImage({ prompt: "p" }, {}, deps), /需要 images/)
  await assert.rejects(() => generateImage({}, {}, deps), /prompt 不能为空/)
  await assert.rejects(() => editImage({ prompt: "p", images: [] }, {}, deps), /需要 images/)
})

/* ---------- 多张、失败 ---------- */

test("n 张拆成多次请求；有一张失败，剩下的照样交出去", async () => {
  let seen = 0
  const { cfg, deps } = make({
    settings: { imageGen: "vendor/draw-2" },
    generations: () => (++seen === 1 ? answered() : text("upstream busy", 503)),
  })

  const out = await generateImage({ prompt: "p", n: 2 }, {}, deps)
  assert.equal(out.status, "done")
  assert.equal(out.count, 1)
})

test("全失败就报第一个错（不要让调用方以为有图）", async () => {
  const { cfg, deps } = make({
    settings: { imageGen: "vendor/draw-2" },
    generations: () => text("upstream busy", 503),
  })

  await assert.rejects(() => generateImage({ prompt: "p", n: 2 }, {}, deps), /upstream busy/)
})

/* ---------- 慢图 ---------- */

test("画得比工具调用久：先给 jobId，画好了用 image_result 要", async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const { cfg, deps } = make({
    settings: { imageGen: "vendor/draw-2" },
    generations: async () => {
      await gate
      return answered()
    },
    waitSeconds: 1,
  })

  const first = await generateImage({ prompt: "p" }, {}, deps)
  assert.equal(first.status, "running")
  assert.match(first.jobId, /^img_/)
  assert.equal(first.waitedSeconds, 1)
  assert.match(first.hint, /image_result/)

  release()
  const got = await imageResult({ jobId: first.jobId, waitSeconds: 5 }, {}, deps)
  assert.equal(got.status, "done")
  assert.equal(got.images[0].b64, PNG_B64)
})

test("image_result：不认识的 jobId 说 unknown，并说清怎么办", async () => {
  const { cfg, deps } = make({ settings: { imageGen: "vendor/draw-2" } })

  const out = await imageResult({ jobId: "img_不存在" }, {}, deps)
  assert.equal(out.status, "unknown")
  assert.match(out.hint, /重新用 generate_image/)
})

/* ---------- key 与答复 ---------- */

test("网关要 key 时用 magpie 自己的 caller key", async () => {
  const { cfg, fetch, deps } = make({
    settings: { imageGen: "vendor/draw-2" },
    callerKeys: [{ name: "web", secret: "sec-1" }],
  })

  await generateImage({ prompt: "p" }, {}, deps)
  assert.equal(draws(fetch)[0].init.headers.authorization, "Bearer sec-1")
})

test("网关只给 URL 的图：取回来补成 base64，别把画好的图弄丢", async () => {
  const fetchImpl = fakeFetch((url, init) => {
    if (url.endsWith("/v1/models")) return json({ data: [] })
    if (url.endsWith("/v1/images/generations")) return json({ data: [{ url: "http://pic.test/out.png" }] })
    return bytes(Buffer.from(PNG_B64, "base64"))
  })
  const cfg = track(tmpConfig({ settings: { imageGen: "vendor/draw-2" } }))
  const deps = depsFor({ jobs: createJobs(), fetchImpl, env: cfg.env, log: () => {} })

  const out = await generateImage({ prompt: "p" }, {}, deps)
  assert.equal(out.images[0].b64, PNG_B64)
  assert.equal(out.images[0].mimeType, "image/png")
  assert.equal(out.images[0].url, "http://pic.test/out.png")
})

test("取不回那张 URL 图：仍然交出 URL 和一条日志，不报错", async () => {
  const logs = []
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith("/v1/models")) return json({ data: [] })
    if (url.endsWith("/v1/images/generations")) return json({ data: [{ url: "http://pic.test/gone.png" }] })
    return text("gone", 404)
  })
  const cfg = track(tmpConfig({ settings: { imageGen: "vendor/draw-2" } }))
  const deps = depsFor({ jobs: createJobs(), fetchImpl, env: cfg.env, log: (lvl, msg) => logs.push(msg) })

  const out = await generateImage({ prompt: "p" }, {}, deps)
  assert.equal(out.images[0].b64, undefined)
  assert.equal(out.images[0].url, "http://pic.test/gone.png")
  assert.equal(logs.length, 1)
})

/* ---------- 小零件 ---------- */

test("readImage：认得出 png/jpeg，读不到就说读不到", async () => {
  const io = { fetch: () => { throw new Error("不该联网") }, readFileBytes: (p) => fs.readFileSync(p) }
  assert.equal((await readImage(PNG_B64, io)).mime, "image/png")
  assert.equal((await readImage("data:image/webp;base64," + PNG_B64, io)).mime, "image/webp")
  await assert.rejects(() => readImage("/没有这个文件.png", io), /读不到这张图/)
  await assert.rejects(() => readImage("  ", io), /有一项是空的/)
})

test("toAnswer：字节数、URL、改过的提示词都带上", () => {
  const out = toAnswer({
    model: "m",
    images: [
      { b64: PNG_B64, mimeType: "image/png" },
      { b64: "", url: "http://x/1.png", revisedPrompt: "改过了" },
    ],
  })
  assert.equal(out.count, 2)
  assert.ok(out.images[0].bytes > 0)
  assert.equal(out.images[1].b64, undefined)
  assert.equal(out.images[1].url, "http://x/1.png")
  assert.equal(out.images[1].revisedPrompt, "改过了")
})

/** 用完的临时配置目录，afterEach 里一起删掉。 */
const opened = []

function track(cfg) {
  opened.push(cfg)
  return cfg
}

afterEach(() => {
  for (const cfg of opened.splice(0)) {
    try {
      cfg.cleanup()
    } catch {
      /* 已经删过了 */
    }
  }
})
