import assert from "node:assert/strict"
import { test } from "node:test"

import {
  b64ToDataUrl,
  buildEditFields,
  buildGenerateBody,
  classifyImageSource,
  errorMessage,
  extraFields,
  parseImagesResponse,
  sniffMime,
} from "../lib/images-api.js"
import { PNG_B64 } from "./helpers.js"

const JPEG_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzM//2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=="

test("sniffMime 认得 png/jpeg，认不出就给空", () => {
  assert.equal(sniffMime(PNG_B64), "image/png")
  assert.equal(sniffMime(JPEG_B64), "image/jpeg")
  assert.equal(sniffMime("aGVsbG8="), "")
  assert.equal(sniffMime(""), "")
  assert.equal(sniffMime(undefined), "")
})

test("classifyImageSource 分清 data URL、URL、file://、路径和裸 base64", () => {
  assert.equal(classifyImageSource("data:image/png;base64,AAAA").kind, "data")
  assert.equal(classifyImageSource("https://x.test/a.png").kind, "url")
  assert.equal(classifyImageSource("http://x.test/a.png").kind, "url")
  assert.equal(classifyImageSource("file:///tmp/a.png").kind, "file")
  assert.equal(classifyImageSource("/tmp/a.png").kind, "path")
  assert.equal(classifyImageSource("./shot.png").kind, "path")
  assert.equal(classifyImageSource("C:\\tmp\\a.png").kind, "path")
  assert.equal(classifyImageSource(PNG_B64).kind, "base64")
  assert.equal(classifyImageSource("   ").kind, "empty")
  assert.equal(classifyImageSource(null).kind, "empty")
  // 短字符串既不像 base64 也不像图片，当路径处理，让读盘去报错
  assert.equal(classifyImageSource("abc").kind, "path")
})

test("b64ToDataUrl 认得出 mime 就用它，认不出当 png", () => {
  assert.equal(b64ToDataUrl(PNG_B64), `data:image/png;base64,${PNG_B64}`)
  assert.equal(b64ToDataUrl("aGVsbG8="), "data:image/png;base64,aGVsbG8=")
  assert.equal(b64ToDataUrl("aGVs bG8="), "data:image/png;base64,aGVsbG8=")
  assert.equal(b64ToDataUrl(""), "")
})

test("extraFields 只留能安全透传的标量", () => {
  assert.deepEqual(extraFields({ a: 1, b: "2", c: true, d: { x: 1 }, e: [1], f: null }), {
    a: 1,
    b: "2",
    c: true,
  })
  assert.deepEqual(extraFields(undefined), {})
  assert.deepEqual(extraFields([1, 2]), {})
})

test("buildGenerateBody 只写调用方真给了的字段", () => {
  const body = buildGenerateBody({ responseFormat: "b64_json" }, { model: "m", prompt: "一只猫", n: 1 })
  assert.deepEqual(body, { model: "m", prompt: "一只猫", n: 1, response_format: "b64_json" })
})

test("buildGenerateBody 映射字段名，并把 extra 垫在下面", () => {
  const body = buildGenerateBody(
    { responseFormat: "b64_json" },
    {
      model: "m",
      prompt: "p",
      n: 2,
      size: "1024x1024",
      quality: "high",
      background: "transparent",
      outputFormat: "webp",
      extra: { steps: 30, model: "偷偷改的", prompt: "偷偷改的" },
    },
  )
  assert.equal(body.size, "1024x1024")
  assert.equal(body.quality, "high")
  assert.equal(body.background, "transparent")
  assert.equal(body.output_format, "webp")
  assert.equal(body.steps, 30)
  // extra 不能盖掉我们自己的字段
  assert.equal(body.model, "m")
  assert.equal(body.prompt, "p")
})

test("buildGenerateBody 在不要 response_format 时不带这个字段", () => {
  const body = buildGenerateBody({ responseFormat: "" }, { model: "m", prompt: "p", n: 1 })
  assert.equal("response_format" in body, false)
})

test("buildEditFields 的 n 是字符串，图片走文件字段", () => {
  const fields = buildEditFields({ responseFormat: "b64_json" }, { model: "m", prompt: "p", n: 3, size: "512x512" })
  assert.deepEqual(fields, {
    model: "m",
    prompt: "p",
    n: "3",
    size: "512x512",
    response_format: "b64_json",
  })
})

test("parseImagesResponse 收下 base64、只给 url 的、以及 mime_type", () => {
  const out = parseImagesResponse({
    created: 1700000000,
    model: "m",
    data: [
      { b64_json: PNG_B64, revised_prompt: "改了" },
      { url: "https://x.test/a.png" },
      { b64_json: ` ${JPEG_B64}\n` },
      { mime_type: "image/webp", b64_json: "AAAA" },
      null,
      "junk",
      {},
    ],
  })
  assert.equal(out.created, 1700000000)
  assert.equal(out.model, "m")
  assert.equal(out.images.length, 4)
  assert.equal(out.images[0].b64, PNG_B64)
  assert.equal(out.images[0].mimeType, "image/png")
  assert.equal(out.images[0].revisedPrompt, "改了")
  assert.equal(out.images[1].url, "https://x.test/a.png")
  assert.equal(out.images[1].b64, "")
  // 带空白的 base64 会被抹平，mime 照样认得出
  assert.equal(out.images[2].b64, JPEG_B64)
  assert.equal(out.images[2].mimeType, "image/jpeg")
  // 明说 mime_type 的就用它
  assert.equal(out.images[3].mimeType, "image/webp")
})

test("parseImagesResponse 对空答复不炸", () => {
  assert.deepEqual(parseImagesResponse({}), { created: 0, model: "", text: "", images: [] })
  assert.deepEqual(parseImagesResponse(null), { created: 0, model: "", text: "", images: [] })
  assert.equal(parseImagesResponse({ text: "不行" }).text, "不行")
})

test("errorMessage 从各种错误体里挑出一句人话", () => {
  assert.equal(errorMessage('{"error":{"message":"额度用完了"}}', 429), "额度用完了")
  assert.equal(errorMessage('{"message":"模型不存在"}', 404), "模型不存在")
  assert.equal(errorMessage("upstream said no", 502), "upstream said no")
  assert.equal(errorMessage({ error: { message: "挂了" } }, 500), "挂了")
  assert.equal(errorMessage({ message: "挂了" }, 500), "挂了")
  assert.equal(errorMessage("", 503), "HTTP 503")
  assert.equal(errorMessage("   ", 503), "HTTP 503")
  assert.equal(errorMessage({}, 418), "HTTP 418")
})

test("errorMessage 把过长的错误截断", () => {
  const long = "x".repeat(2000)
  const msg = errorMessage(long, 500)
  assert.equal(msg.length, 801)
  assert.ok(msg.endsWith("…"))
})
