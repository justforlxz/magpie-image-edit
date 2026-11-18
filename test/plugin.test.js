import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { ImageTools, toolsOf } from "../index.js"
import { createJobs } from "../lib/jobs.js"
import { depsFor } from "../lib/ops.js"
import { PNG_B64, answered, fakeFetch, tmpConfig } from "./helpers.js"

/** 宿主那边：工具名有硬性格式要求。 */
const NAME_RE = /^[A-Za-z0-9_-]{1,48}$/

const opened = []
const track = (cfg) => (opened.push(cfg), cfg)
afterEach(() => {
  for (const cfg of opened.splice(0)) {
    try {
      cfg.cleanup()
    } catch {
      /* 已经删过了 */
    }
  }
})

test("ImageTools 给出三个工具，名字都合规", async () => {
  const { tool } = await ImageTools()
  assert.deepEqual(Object.keys(tool).sort(), ["edit_image", "generate_image", "image_result"])
  for (const name of Object.keys(tool)) assert.match(name, NAME_RE)
})

test("每个工具都有说明、能校验的 args、能调用的 execute", async () => {
  const { tool } = await ImageTools()

  for (const [name, t] of Object.entries(tool)) {
    assert.equal(typeof t.execute, "function", `${name} 缺 execute`)
    assert.equal(typeof t.description, "string", `${name} 缺描述`)
    assert.ok(t.description.length > 10, `${name} 的描述太短`)

    const schema = t.args
    assert.equal(schema.type, "object", `${name} 的 args 不是 object`)
    assert.equal(schema.additionalProperties, false, `${name} 放开了额外字段`)
    assert.ok(schema.properties && Object.keys(schema.properties).length > 0)

    // required 必须是 properties 里真实存在的键，否则宿主一调就 400
    for (const key of schema.required ?? []) {
      assert.ok(key in schema.properties, `${name}.required 里的 ${key} 没有定义`)
    }
  }
})

test("参数说明写清楚了（模型看得懂才行）", async () => {
  const { tool } = await ImageTools()

  assert.deepEqual(tool.generate_image.args.required, ["prompt"])
  assert.deepEqual(tool.edit_image.args.required, ["prompt", "images"])
  assert.deepEqual(tool.image_result.args.required, ["jobId"])

  // images 是图生图的关键：必须说明能放什么
  assert.equal(tool.edit_image.args.properties.images.type, "array")
  assert.equal(tool.edit_image.args.properties.images.minItems, 1)
  assert.match(tool.edit_image.args.properties.images.description, /base64/)

  // waitSeconds 有上界，避免模型自己要等一辈子
  assert.equal(tool.generate_image.args.properties.waitSeconds.maximum, 50)
})

test("从 ImageTools 到真实请求：一整条链路走得通，用户什么都没配", async () => {
  const cfg = track(tmpConfig({ settings: { imageGen: "vendor/draw-2" } }))
  const fetchImpl = fakeFetch(() => answered())
  const deps = depsFor({ jobs: createJobs(), fetchImpl, env: cfg.env, log: () => {} })
  const { tool } = { tool: toolsOf(deps) }

  const out = await tool.generate_image.execute({ prompt: "一只猫" }, {})
  assert.equal(out.status, "done")
  assert.equal(out.images[0].b64, PNG_B64)

  const edit = await tool.edit_image.execute({ prompt: "改成夜景", images: [PNG_B64] }, {})
  assert.equal(edit.status, "done")
})

test("magpie 的配置写坏了也不影响插件加载：只是当作没挑模型", async () => {
  const cfg = track(tmpConfig())
  cfg.write("settings.json", "{ 这不是 JSON }")

  const fetchImpl = fakeFetch(() => answered())
  const deps = depsFor({ jobs: createJobs(), fetchImpl, env: cfg.env, log: () => {} })
  const { tool } = { tool: toolsOf(deps) }

  // 网关也没列出任何模型 → 明确要求去设置里选一个
  await assert.rejects(() => tool.generate_image.execute({ prompt: "p" }, {}), /设置 › 模型 › 生图/)
})

test("不给 input 也照样给出工具（宿主怎么调都不炸）", async () => {
  for (const input of [undefined, null, {}, { directory: 42 }]) {
    const out = await ImageTools(input)
    assert.equal(Object.keys(out.tool).length, 3)
  }
})
