import assert from "node:assert/strict"
import { test } from "node:test"

import { createJobs } from "../lib/jobs.js"

/** 一张能由用例自己放行的网：画完了才 resolve。 */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 让出一轮事件循环，好让任务内部那串 then 跑完。 */
const tick = () => new Promise((res) => setTimeout(res, 0))

test("画好了：wait 直接拿到结果", async () => {
  const jobs = createJobs()
  const run = jobs.start(async () => ({ images: [{ b64: "AAA" }] }))
  assert.equal(run.status, "running")

  const r = await jobs.wait(run.id, 1000)
  assert.equal(r.status, "done")
  assert.deepEqual(r.result, { images: [{ b64: "AAA" }] })
  assert.equal(r.error, "")
  assert.ok(r.endedAt >= r.startedAt)
})

test("画砸了：wait 把错误交出来", async () => {
  const jobs = createJobs()
  const run = jobs.start(async () => {
    throw new Error("  模型拒绝了这个提示词  ")
  })
  const r = await jobs.wait(run.id, 1000)
  assert.equal(r.status, "failed")
  assert.equal(r.error, "模型拒绝了这个提示词")
  assert.equal(r.result, null)
})

test("抛的不是 Error 也不漏，空原因有兜底", async () => {
  const jobs = createJobs()
  const a = jobs.start(() => {
    throw "boom"
  })
  assert.equal((await jobs.wait(a.id, 1000)).error, "boom")

  const b = jobs.start(() => {
    throw new Error("   ")
  })
  assert.equal((await jobs.wait(b.id, 1000)).error, "画图失败，没拿到原因")
})

test("还没画完：等够了就返回 running，不是失败", async () => {
  const jobs = createJobs()
  const d = deferred()
  const run = jobs.start(() => d.promise)

  const r = await jobs.wait(run.id, 20)
  assert.equal(r.status, "running")
  assert.equal(r.stoppedBy, "timeout")
  assert.equal(r.id, run.id)

  // 任务还在后台跑，画完了再来要就有图
  d.resolve({ images: [{ b64: "BBB" }] })
  await tick()
  const again = await jobs.wait(run.id, 1000)
  assert.equal(again.status, "done")
  assert.equal(again.result.images[0].b64, "BBB")
})

test("调用方中途不要了：wait 立刻回 running，任务继续跑", async () => {
  const jobs = createJobs()
  const d = deferred()
  const run = jobs.start(() => d.promise)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 5)

  const r = await jobs.wait(run.id, 5000, ac.signal)
  assert.equal(r.status, "running")
  assert.equal(r.stoppedBy, "aborted")

  d.resolve({ ok: true })
  await tick()
  assert.equal(jobs.get(run.id).status, "done")
})

test("一进来就已经中止的信号：不等", async () => {
  const jobs = createJobs()
  const run = jobs.start(() => new Promise(() => {}))
  const ac = new AbortController()
  ac.abort()

  const started = Date.now()
  const r = await jobs.wait(run.id, 5000, ac.signal)
  assert.equal(r.status, "running")
  assert.ok(Date.now() - started < 1000)
})

test("不认识的 jobId：说 unknown，不抛", async () => {
  const jobs = createJobs()
  assert.equal((await jobs.wait("nope", 100)).status, "unknown")
  assert.equal((await jobs.wait("", 100)).status, "unknown")
  assert.equal((await jobs.wait(undefined, 100)).status, "unknown")
})

test("已经结束的任务再 wait 不花时间", async () => {
  const jobs = createJobs()
  const run = jobs.start(async () => "x")
  await tick()
  const r = await jobs.wait(run.id, 5000)
  assert.equal(r.status, "done")
  assert.equal(r.waitedMs, 0)
})

test("登记表有上限，先丢已经结束的", async () => {
  const jobs = createJobs({ limit: 2 })
  const done = jobs.start(async () => "old")
  await tick()
  assert.equal(jobs.get(done.id).status, "done")

  const b = jobs.start(() => new Promise(() => {}))
  const c = jobs.start(() => new Promise(() => {}))
  assert.equal(jobs.size(), 2)
  // 结束过的先被丢，还在画的留着
  assert.equal(jobs.get(done.id), undefined)
  assert.ok(jobs.get(b.id))
  assert.ok(jobs.get(c.id))
})

test("没有 id 也能用：自己生成，且不重复", () => {
  const jobs = createJobs()
  const a = jobs.start(() => new Promise(() => {}))
  const b = jobs.start(() => new Promise(() => {}))
  assert.match(a.id, /^img_/)
  assert.notEqual(a.id, b.id)
})

test("list 新的在前", () => {
  const jobs = createJobs()
  const a = jobs.start(() => new Promise(() => {}))
  const b = jobs.start(() => new Promise(() => {}))
  assert.deepEqual(
    jobs.list().map((r) => r.id),
    [b.id, a.id],
  )
})

test("exec 收到的 signal 能中止请求", async () => {
  const jobs = createJobs()
  let seen
  const run = jobs.start(
    (signal) =>
      new Promise((res) => {
        seen = signal
        signal.addEventListener("abort", () => res("aborted"))
      }),
  )
  // start 把 exec 放到下一个微任务，先让出去
  await tick()
  assert.ok(seen instanceof AbortSignal)
  assert.equal(seen.aborted, false)
  // 任务自己不会被 wait 的超时中止：后台请求不该被工具的等待时间砍掉
  await jobs.wait(run.id, 10)
  assert.equal(seen.aborted, false)
})
