// 测试用的小工具：假 fetch、假配置、一张真 PNG。
//
// 测试不连网：所有请求都落到这里的 fakeFetch 上，它把每次调用记下来，
// 好让用例断言「到底发了什么」。

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

/** 一套能跑起来的配置。 */
export function config(over = {}) {
  return {
    baseUrl: "http://gw.test/v1",
    apiKey: "k-1",
    model: "vendor/draw-2",
    waitSeconds: 5,
    jobTimeoutSeconds: 10,
    responseFormat: "b64_json",
    ...over,
  }
}

/** vendor 答复里放图片 base64 的字段名（照抄 OpenAI images API 的写法）。 */
export const B64_FIELD = "b64_json"

/** answered：一张画好的图的标准答复。 */
export function answered(b64 = PNG_B64) {
  return json({ created: 1, data: [{ [B64_FIELD]: b64 }] })
}
