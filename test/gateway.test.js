import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"

import {
  DEFAULT_GATEWAY,
  VENDOR_B64,
  callerKey,
  configDir,
  drawOnce,
  gatewayCandidates,
  imagesOf,
  preferredModel,
  resolveGateway,
} from "../lib/gateway.js"
import { PNG_B64, answered, fakeFetch, json, text, tmpConfig } from "./helpers.js"

/* ---------- 配置目录 ---------- */

test("配置目录跟着 XDG_CONFIG_HOME 走，没有就用 HOME/.config/magpie", () => {
  assert.equal(configDir({ XDG_CONFIG_HOME: "/xdg" }), "/xdg/magpie")
  assert.equal(configDir({ HOME: "/home/somebody" }), "/home/somebody/.config/magpie")
})

/* ---------- 网关地址 ---------- */

test("候选网关：显式给的 → 本次 magpie 的 MAGPIE_ADDR → 默认端口", () => {
  assert.deepEqual(gatewayCandidates({}), [DEFAULT_GATEWAY])
  assert.deepEqual(gatewayCandidates({ MAGPIE_ADDR: "127.0.0.1:3499" }), ["http://127.0.0.1:3499", DEFAULT_GATEWAY])
  assert.deepEqual(gatewayCandidates({ MAGPIE_IMAGE_EDIT_GATEWAY: "http://other:1", MAGPIE_ADDR: "127.0.0.1:3499" }), [
    "http://other:1",
    "http://127.0.0.1:3499",
    DEFAULT_GATEWAY,
  ])
})

test("重复和写坏的地址不会混进候选（末尾斜杠也认）", () => {
  assert.deepEqual(gatewayCandidates({ MAGPIE_IMAGE_EDIT_GATEWAY: "http://a:1/" }), ["http://a:1", DEFAULT_GATEWAY])
  assert.deepEqual(gatewayCandidates({ MAGPIE_ADDR: "不是地址" }), [DEFAULT_GATEWAY])
  assert.deepEqual(gatewayCandidates({ MAGPIE_GATEWAY: "http://a:1", MAGPIE_ADDR: "http://a:1" }), ["http://a:1", DEFAULT_GATEWAY])
})

/* ---------- key 和模型 ---------- */

test("网关要 key 时用 magpie 自己的 caller key：环境变量优先", () => {
  const cfg = tmpConfig({ callerKeys: [{ name: "web", secret: "from-file" }] })
  assert.equal(callerKey({ ...cfg.env, MAGPIE_API_KEY: "from-env" }), "from-env")
  assert.equal(callerKey(cfg.env), "from-file")
  cfg.cleanup()
})

test("caller key：没名字的也能用，没文件就当没有（桌面版不要 key）", () => {
  assert.equal(callerKey(tmpConfig({ callerKeys: [{ secret: "s" }] }).env), "s")
  assert.equal(callerKey(tmpConfig().env), "")
  const broken = tmpConfig()
  broken.write("caller-keys.json", "不是 JSON")
  assert.equal(callerKey(broken.env), "")
  broken.cleanup()
})

test("默认模型取「设置 › 模型 › 生图」里挑的那个", () => {
  assert.equal(preferredModel(tmpConfig({ settings: { imageGen: "vendor/draw-2" } }).env), "vendor/draw-2")
  // off 表示没开生图，等于没挑
  assert.equal(preferredModel(tmpConfig({ settings: { imageGen: "off" } }).env), "")
  assert.equal(preferredModel(tmpConfig({ settings: {} }).env), "")
  assert.equal(preferredModel(tmpConfig().env), "")
})

/* ---------- 找网关 ---------- */

test("找网关：跳过答不上的，用第一个答得上的", async () => {
  const fetch = fakeFetch((url) => (url.startsWith("http://a:1") ? text("nope", 500) : json({ data: [] })))
  const base = await resolveGateway({ env: { MAGPIE_IMAGE_EDIT_GATEWAY: "http://a:1", MAGPIE_GATEWAY: "http://b:1" }, fetch })
  assert.equal(base, "http://b:1")
  assert.equal(fetch.calls.length, 2)
})

test("找网关：一个都不答就用首选地址，让生图时的错原样露出来", async () => {
  const fetch = fakeFetch(() => {
    throw new Error("连不上")
  })
  assert.equal(await resolveGateway({ env: {}, fetch }), DEFAULT_GATEWAY)
  assert.equal(await resolveGateway({ env: { MAGPIE_IMAGE_EDIT_GATEWAY: "http://a:1" }, fetch }), "http://a:1")
})


/* ---------- 答复 ---------- */

test("答复里只认真的图：base64 和 URL 都行，空的扔掉", () => {
  const images = imagesOf({
    data: [
      { [VENDOR_B64]: PNG_B64, revised_prompt: "改过了" },
      { url: "http://x/1.png" },
      { nope: 1 },
      null,
    ],
  })
  assert.equal(images.length, 2)
  assert.equal(images[0].b64, PNG_B64)
  assert.equal(images[0].revisedPrompt, "改过了")
  assert.equal(images[1].url, "http://x/1.png")
})

test("不是 images 形状就当没给图", () => {
  assert.deepEqual(imagesOf({}), [])
  assert.deepEqual(imagesOf(null), [])
})

/* ---------- 一次请求 ---------- */

test("drawOnce 发的是 magpie 网关的 /v1/images/generations，要 base64 回来", async () => {
  const fetch = fakeFetch(() => answered())
  const out = await drawOnce({
    base: "http://gw.test",
    key: "k-1",
    model: "vendor/draw-2",
    prompt: "一只猫",
    size: "1024x1024",
    quality: "high",
    background: "opaque",
    fetch,
  })

  assert.equal(out.images[0].b64, PNG_B64)
  assert.equal(out.model, "vendor/draw-2")

  const call = fetch.calls[0]
  assert.equal(call.url, "http://gw.test/v1/images/generations")
  assert.equal(call.init.method, "POST")
  assert.equal(call.init.headers.authorization, "Bearer k-1")
  const body = JSON.parse(call.init.body)
  assert.deepEqual(body, {
    prompt: "一只猫",
    n: 1,
    response_format: VENDOR_B64,
    model: "vendor/draw-2",
    size: "1024x1024",
    quality: "high",
    background: "opaque",
  })
})

test("有参考图就放进 images（图生图走同一个接口）", async () => {
  const fetch = fakeFetch(() => answered())
  await drawOnce({
    base: "http://gw.test",
    model: "m",
    prompt: "改成夜景",
    references: ["data:image/png;base64," + PNG_B64],
    fetch,
  })
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body).images, ["data:image/png;base64," + PNG_B64])
})

test("没 key 就不带 Authorization（桌面版网关不要 key）", async () => {
  const fetch = fakeFetch(() => answered())
  await drawOnce({ base: "http://gw.test", key: "", prompt: "p", fetch })
  assert.equal(fetch.calls[0].init.headers.authorization, undefined)
})

test("网关的报错原样带出来：4xx 照原样，5xx 算网关出错", async () => {
  const bad = fakeFetch(() => json({ error: { message: "model_not_found：没有这个模型" } }, 404))
  await assert.rejects(() => drawOnce({ base: "http://gw.test", prompt: "p", fetch: bad }), (e) => {
    assert.match(e.message, /model_not_found/)
    assert.equal(e.status, 404)
    return true
  })

  const down = fakeFetch(() => text("upstream exploded", 500))
  await assert.rejects(() => drawOnce({ base: "http://gw.test", prompt: "p", fetch: down }), (e) => {
    assert.match(e.message, /upstream exploded/)
    assert.equal(e.status, 502)
    return true
  })
})

test("连不上网关时说清楚是 magpie 的事", async () => {
  const fetch = fakeFetch(() => {
    throw new Error("ECONNREFUSED")
  })
  await assert.rejects(() => drawOnce({ base: "http://gw.test", prompt: "p", fetch }), /连不上 magpie 网关/)
})

test("答复不是 JSON、或者没图，都要说明白", async () => {
  await assert.rejects(
    () => drawOnce({ base: "http://gw.test", prompt: "p", fetch: fakeFetch(() => text("<html>", 200)) }),
    /不是 JSON/,
  )
  await assert.rejects(
    () => drawOnce({ base: "http://gw.test", prompt: "p", fetch: fakeFetch(() => json({ data: [] })) }),
    /没给图/,
  )
})

test("magpie 的配置目录拼得对（settings.json 与 caller-keys.json 同目录）", () => {
  const cfg = tmpConfig({ settings: { imageGen: "a/b" }, callerKeys: [{ name: "n", secret: "s" }] })
  assert.equal(preferredModel(cfg.env), "a/b")
  assert.equal(callerKey(cfg.env), "s")
  assert.equal(path.basename(cfg.dir), "magpie")
  cfg.cleanup()
})
