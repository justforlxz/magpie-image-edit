// 后台任务登记表。
//
// 为什么要有它：magpie 给每个插件工具 55 秒（host.js ToolTimeout），而画一张图
// 常常超过 55 秒。所以工具不把请求挂在宿主给的那 55 秒里，而是自己起一个后台
// 请求（用它自己的 AbortController，不接 ctx.abort），先等一小会儿：等到了就
// 直接给图，等不到就把 jobId 交回去，让调用方过一会儿再来 image_result 要。
//
// 登记表是内存里的，插件宿主重启（更新插件、重启 magpie）就没了，这也符合
// 「一张图最多画几分钟」的预期。

/** 读一个已经结束的任务，转成对外的形状。 */
function snapshot(run) {
  return {
    status: run.status,
    id: run.id,
    result: run.result ?? null,
    error: run.error || "",
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? 0,
  }
}

/**
 * createJobs：造一个任务表。
 * now/newId 可注入，好让单测不依赖真实时间和随机。
 */
export function createJobs({ now = () => Date.now(), limit = 32, newId } = {}) {
  const runs = new Map()
  let seq = 0
  const makeId = newId ?? (() => `img_${(++seq).toString(36)}_${now().toString(36)}`)

  // 超量时先丢最早的已结束任务；还超就丢最早的，running 的也一样丢。
  function evict() {
    if (runs.size <= limit) return
    for (const [k, r] of runs) {
      if (runs.size <= limit) return
      if (r.status !== "running") runs.delete(k)
    }
    for (const k of runs.keys()) {
      if (runs.size <= limit) return
      runs.delete(k)
    }
  }

  /**
   * start：起一个后台任务，立刻返回它的登记项（含 id）。
   * exec(signal) 负责真正干活；它 reject 就是任务失败，不会漏成 unhandled。
   */
  function start(exec) {
    const id = makeId()
    let settle
    const settled = new Promise((res) => {
      settle = res
    })
    const controller = new AbortController()
    const run = { id, status: "running", startedAt: now(), endedAt: 0, result: null, error: "", settled, controller }
    runs.set(id, run)
    evict()
    Promise.resolve()
      .then(() => exec(controller.signal))
      .then(
        (result) => {
          if (run.status !== "running") return
          run.status = "done"
          run.result = result
          run.endedAt = now()
          settle(run)
        },
        (e) => {
          if (run.status !== "running") return
          run.status = "failed"
          run.error = String(e?.message ?? e).trim() || "画图失败，没拿到原因"
          run.endedAt = now()
          settle(run)
        },
      )
    return run
  }

  /** get：按 id 取登记项（没有就是 undefined）。 */
  function get(id) {
    return typeof id === "string" && id ? runs.get(id) : undefined
  }

  /**
   * wait：最多等 ms 毫秒。signal 中止（宿主那 55 秒到点）时不等了。
   * 返回 {status: "done"|"failed"|"running"|"unknown", …}。
   */
  async function wait(id, ms, signal) {
    const run = get(id)
    if (!run) return { status: "unknown", id: String(id ?? ""), waitedMs: 0 }
    if (run.status !== "running") return { ...snapshot(run), waitedMs: 0 }

    const started = now()
    let timer
    const timedOut = new Promise((res) => {
      timer = setTimeout(() => res("timeout"), Math.max(0, ms))
      // 不让这个定时器把进程吊住
      if (typeof timer?.unref === "function") timer.unref()
    })
    const aborted = new Promise((res) => {
      if (!signal) return
      if (signal.aborted) res("aborted")
      else signal.addEventListener("abort", () => res("aborted"), { once: true })
    })
    const which = await Promise.race([run.settled, timedOut, aborted])
    clearTimeout(timer)
    return {
      ...snapshot(run),
      status: run.status === "running" ? "running" : run.status,
      waitedMs: Math.max(0, now() - started),
      stoppedBy: typeof which === "string" ? which : "",
      id,
    }
  }

  /** list：还留着的任务，新的在前。 */
  function list() {
    return [...runs.values()].reverse().map(snapshot)
  }

  return { start, get, wait, list, size: () => runs.size, limit }
}
