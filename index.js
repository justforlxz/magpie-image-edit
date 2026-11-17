// magpie 插件入口：把「画图」和「改图」做成 MCP 工具。
//
// 宿主的约定（internal/plugin/host.js 的 toolsOf）：
//   导出一个异步函数，返回 { tool: { <name>: { description, args, execute } } }。
//   - name 要匹配 ^[A-Za-z0-9_-]{1,48}$；
//   - args 可以是普通 JSON Schema，宿主会拿它校验参数再调 execute；
//   - execute(args, ctx) 的返回值原样回到模型：字符串是文本，对象是 JSON。
//
// 这些工具由 magpie 的内置插件 "Plugin tools" 汇总成一个 MCP 服务
// （/mcp/magpie/tools，每个工具叫 <插件短名>_<工具名>），任何 agent 都能连。
//
// 为什么要后台任务：宿主给一个工具 55 秒，而画一张图常常更久。所以工具自己起
// 一个后台请求，只等一小会儿；没画完就把 jobId 交回去，让模型稍后用
// image_result 再要。见 lib/jobs.js。
import fs from "node:fs"

import { resolveConfig } from "./lib/config.js"
import { createJobs } from "./lib/jobs.js"
import { depsFor, editImage, generateImage, imageResult } from "./lib/ops.js"

/** 生成和编辑共用的参数。 */
const SHARED = {
  model: {
    type: "string",
    description: "要用的图片模型，默认用配置里的。magpie 网关的写法是 <provider>/<model>",
  },
  size: {
    type: "string",
    description: "图片尺寸，如 1024x1024、1536x1024（横）、1024x1536（竖）、auto。默认由模型决定",
  },
  quality: {
    type: "string",
    description: "画质，如 low、medium、high、auto。不填用模型的默认值",
  },
  background: {
    type: "string",
    enum: ["transparent", "opaque", "auto"],
    description: "背景：transparent 要透明底，opaque 不透明",
  },
  outputFormat: {
    type: "string",
    enum: ["png", "jpeg", "webp"],
    description: "出图格式，默认 png",
  },
  n: {
    type: "integer",
    minimum: 1,
    maximum: 4,
    description: "画几张，默认 1。每张都会各自变成 images 里的一项",
  },
  extra: {
    type: "object",
    description: "原样透传给接口的额外字段（标量），比如 vendor 自己的参数",
  },
  waitSeconds: {
    type: "integer",
    minimum: 1,
    maximum: 50,
    description: "这次调用最多等几秒（默认 40）。等不到就返回 jobId，用 image_result 再要",
  },
}

/** 一套完整的工具：给它们 deps 就能跑。 */
export function toolsOf(deps) {
  return {
    generate_image: {
      description:
        "画一张图（文生图）。成功时直接返回图片的 base64；图比一次工具调用久时返回 jobId，过一会儿用 image_result 要。",
      args: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "要画什么，越具体越好" },
          ...SHARED,
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      execute: (args, ctx) => generateImage(args, ctx, deps),
    },
    edit_image: {
      description:
        "按参考图改图（图生图）：给一张或几张图和一句说明，返回改好的图的 base64。图比一次工具调用久时返回 jobId。",
      args: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "要把它改成什么样" },
          images: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 16,
            description:
              "参考图，每项可以是 base64、data URL、http(s) 地址或本机文件路径。想拿上一次的结果再改，就把那个 b64 原样放进来",
          },
          ...SHARED,
        },
        required: ["prompt", "images"],
        additionalProperties: false,
      },
      execute: (args, ctx) => editImage(args, ctx, deps),
    },
    image_result: {
      description: "按 jobId 去要 generate_image / edit_image 还没画完的图。画好了返回 base64，没好继续返回 running。",
      args: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "generate_image 或 edit_image 返回的 jobId" },
          waitSeconds: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "最多等几秒（默认 40）",
          },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
      execute: (args, ctx) => imageResult(args, ctx, deps),
    },
  }
}

/**
 * ImageTools：magpie 调这个函数拿插件给的工具。
 * input.directory 是插件宿主的工作目录（magpie 的设置目录），配置文件放那里。
 */
export const ImageTools = async (input) => {
  const directory = typeof input?.directory === "string" ? input.directory : ""
  const jobs = createJobs()
  const deps = depsFor({
    config: () =>
      resolveConfig({
        directory,
        env: process.env,
        readFile: (file) => fs.readFileSync(file, "utf8"),
      }),
    jobs,
    log: (level, msg) => console.error(`[magpie-image-edit] ${level}: ${msg}`),
  })
  return { tool: toolsOf(deps) }
}
