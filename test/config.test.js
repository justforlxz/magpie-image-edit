import assert from "node:assert/strict"
import { test } from "node:test"

import {
  CONFIG_FILE,
  DEFAULTS,
  clampInt,
  clampNumber,
  configPath,
  mergeConfig,
  normalizeBaseUrl,
  readConfig,
  resolveConfig,
  shownConfig,
} from "../lib/config.js"

test("normalizeBaseUrl 把地址收到 /v1 为止", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:3425/v1"), "http://127.0.0.1:3425/v1")
  assert.equal(normalizeBaseUrl("http://127.0.0.1:3425/v1/"), "http://127.0.0.1:3425/v1")
  assert.equal(normalizeBaseUrl("  127.0.0.1:3425/v1  "), "http://127.0.0.1:3425/v1")
  assert.equal(normalizeBaseUrl("https://gw.test/v1?x=1"), "https://gw.test/v1")
  assert.equal(normalizeBaseUrl("http://gw.test/v1/images/generations"), "http://gw.test/v1")
  assert.equal(normalizeBaseUrl("http://gw.test/v1/images/edits/"), "http://gw.test/v1")
  assert.equal(normalizeBaseUrl(""), "")
  assert.equal(normalizeBaseUrl(null), "")
})

test("clampNumber / clampInt 收数，不是数就用 fallback", () => {
  assert.equal(clampNumber(5, 1, 1, 10), 5)
  assert.equal(clampNumber(0, 1, 1, 10), 1)
  assert.equal(clampNumber(99, 1, 1, 10), 10)
  assert.equal(clampNumber("7", 1, 1, 10), 7)
  assert.equal(clampNumber("abc", 3, 1, 10), 3)
  assert.equal(clampNumber(undefined, 3, 1, 10), 3)
  assert.equal(clampInt(2.6, 1, 1, 10), 3)
  assert.equal(clampInt("4.4", 1, 1, 10), 4)
})

test("readConfig 只认对象，坏 JSON 一律当没配置", () => {
  assert.deepEqual(readConfig('{"a":1}'), { a: 1 })
  assert.equal(readConfig("{"), null)
  assert.equal(readConfig("[1,2]"), null)
  assert.equal(readConfig("null"), null)
  assert.equal(readConfig(""), null)
  assert.equal(readConfig(undefined), null)
})

test("mergeConfig 环境变量盖过文件，文件盖过默认值", () => {
  const cfg = mergeConfig(
    { baseUrl: "http://file.test/v1", model: "file/model", apiKey: "file-key" },
    { MAGPIE_IMAGE_EDIT_MODEL: "env/model" },
  )
  assert.equal(cfg.baseUrl, "http://file.test/v1")
  assert.equal(cfg.model, "env/model")
  assert.equal(cfg.apiKey, "file-key")
})

test("mergeConfig 什么都没有时全用默认值", () => {
  const cfg = mergeConfig(null, {})
  assert.equal(cfg.baseUrl, "http://127.0.0.1:3425/v1")
  assert.equal(cfg.model, DEFAULTS.model)
  assert.equal(cfg.apiKey, "")
  assert.equal(cfg.waitSeconds, DEFAULTS.waitSeconds)
  assert.equal(cfg.responseFormat, "b64_json")
})

test("mergeConfig 认第二组环境变量名，并把 baseUrl 归一", () => {
  const cfg = mergeConfig({}, {
    MAGPIE_IMAGE_API_BASE: "gw.test:1234/v1/",
    MAGPIE_IMAGE_API_KEY: "k-2",
  })
  assert.equal(cfg.baseUrl, "http://gw.test:1234/v1")
  assert.equal(cfg.apiKey, "k-2")
})

test("mergeConfig 把秒数收进合理范围", () => {
  assert.equal(mergeConfig({ waitSeconds: 999 }, {}).waitSeconds, 50)
  assert.equal(mergeConfig({ waitSeconds: 0 }, {}).waitSeconds, 1)
  assert.equal(mergeConfig({ jobTimeoutSeconds: 1 }, {}).jobTimeoutSeconds, 10)
  assert.equal(mergeConfig({ jobTimeoutSeconds: 99999 }, {}).jobTimeoutSeconds, 3600)
})

test("mergeConfig 里 responseFormat 的空串表示「不要这个字段」", () => {
  // 文件里显式写 "" 就是「别发 response_format」，不能被默认值顶掉
  assert.equal(mergeConfig({ responseFormat: "" }, {}).responseFormat, "")
  // 环境变量给了值就盖过它
  assert.equal(
    mergeConfig({ responseFormat: "" }, { MAGPIE_IMAGE_EDIT_RESPONSE_FORMAT: "url" }).responseFormat,
    "url",
  )
  // 环境变量给空串等于没说
  assert.equal(mergeConfig({}, { MAGPIE_IMAGE_EDIT_RESPONSE_FORMAT: "  " }).responseFormat, "b64_json")
})

test("configPath 认 MAGPIE_IMAGE_EDIT_CONFIG，否则用设置目录", () => {
  assert.equal(configPath("/set", {}), `/set/${CONFIG_FILE}`)
  assert.equal(configPath("/set", { MAGPIE_IMAGE_EDIT_CONFIG: "/tmp/mine.json" }), "/tmp/mine.json")
  // 没给设置目录时落在 cwd（path.join 会把 "." 吃掉）
  assert.equal(configPath("", {}), CONFIG_FILE)
})

test("resolveConfig 读文件失败就当没配置，也绝不抛", () => {
  const cfg = resolveConfig({
    directory: "/set",
    env: {},
    readFile: () => {
      throw new Error("ENOENT")
    },
  })
  assert.equal(cfg.baseUrl, DEFAULTS.baseUrl)
  assert.equal(cfg.configFile, `/set/${CONFIG_FILE}`)
})

test("配置文件写坏了要报出来，别悄悄退回默认值", () => {
  assert.throws(
    () => resolveConfig({ directory: "/set", env: {}, readFile: () => "{ 这不是 JSON }" }),
    (e) => {
      assert.match(e.message, /\/set\/magpie-image-edit\.json/)
      assert.match(e.message, /JSON 对象/)
      return true
    },
  )
  // 空文件不算写坏：就是没配置
  const empty = resolveConfig({ directory: "/set", env: {}, readFile: () => "  " })
  assert.equal(empty.baseUrl, DEFAULTS.baseUrl)
})

test("resolveConfig 把文件里的值和环境变量合起来", () => {
  const cfg = resolveConfig({
    directory: "/set",
    env: { MAGPIE_IMAGE_EDIT_API_KEY: "env-key" },
    readFile: () => '{"baseUrl":"http://file.test:1/v1","model":"file/model","apiKey":"file-key"}',
  })
  assert.equal(cfg.baseUrl, "http://file.test:1/v1")
  assert.equal(cfg.model, "file/model")
  assert.equal(cfg.apiKey, "env-key")
})

test("shownConfig 只说 key 有没有", () => {
  assert.deepEqual(shownConfig({ baseUrl: "u", model: "m", apiKey: "secret", configFile: "/c" }), {
    baseUrl: "u",
    model: "m",
    apiKeySet: true,
    configFile: "/c",
  })
  assert.equal(shownConfig({ baseUrl: "u", model: "m", apiKey: "", configFile: "/c" }).apiKeySet, false)
})
