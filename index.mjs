/**
 * dsh-fetch-tools
 * ---------------
 * DeepSeek Harness (DSH) 一等公民网络请求工具：`fetch_json`。
 *
 * 解决痛点：
 * 1. 结构化 API 调用（如 OpenRouter / Hugging Face / GitHub REST API）无需沉沦到
 *    PowerShell（`Invoke-RestMethod`）编写转义与格式化脚本。
 * 2. 避免大 JSON/长文本撑爆上下文：支持 `select` 属性路径截取分支，以及 `savePath`
 *    直接落盘保存，真正实现零上下文污染。
 * 3. 面对现代动态数据源，以最小网络与 Token 成本获取权威结构化数据。
 *
 * @module dsh-fetch-tools
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MAX_CHARS = 40000
const DEFAULT_USER_AGENT = 'dsh-fetch-tools/1.0 (+https://github.com/deepseek-ai)'

function clip(text, max = DEFAULT_MAX_CHARS) {
  const value = String(text === undefined || text === null ? '' : text)
  const limit = Number(max) > 0 ? Number(max) : DEFAULT_MAX_CHARS
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n\n... [已截断，共 ${value.length} 字符；可传 savePath 直接落盘查看完整内容] ...`
}

/** 简易且安全的嵌套属性提取器（支持 a.b.c 及 a[0].b 及 a.0.b） */
function getByPath(obj, pathStr) {
  if (!obj || typeof obj !== 'object' || !pathStr || typeof pathStr !== 'string') return obj
  const normalized = pathStr.replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '')
  const parts = normalized.split('.')
  let current = obj
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    current = current[part]
  }
  return current
}

function buildUrl(rawUrl, params) {
  const parsed = new URL(rawUrl)
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        parsed.searchParams.set(key, String(value))
      }
    }
  }
  return parsed.toString()
}

/**
 * fetch_json 工具规格
 */
export function createFetchJsonTool(pluginOpts = {}) {
  return {
    name: 'fetch_json',
    description:
      '一等公民 HTTP JSON 请求工具 —— 直接请求任何 REST API 并返回结构化 JSON。' +
      '支持指定 HTTP 方法、自定义请求头、查询参数、请求体；' +
      '支持 select 参数仅提取所需子属性（如 "data.endpoints"），防止大响应吃爆上下文；' +
      '支持 savePath 直接将结果保存到本地文件。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标 HTTP/HTTPS URL。' },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          description: 'HTTP 方法，默认为 GET。',
        },
        params: {
          type: 'object',
          description: 'URL Query 查询参数键值对，会自动进行 URL 编码拼接到请求地址。',
        },
        headers: {
          type: 'object',
          description: '自定义 HTTP 请求头（键值对，如 Authorization、Accept 等）。',
        },
        body: {
          description: '请求体。若传入对象/数组会自动序列化为 JSON 并设置 Content-Type: application/json。',
        },
        select: {
          type: 'string',
          description: '可选：提取结果的嵌套属性路径（如 "data.endpoints" 或 "results.0"），只输出关心的数据，大幅节省 token。',
        },
        savePath: {
          type: 'string',
          description: '可选：将完整响应 JSON 直接保存到指定本地文件路径（绝对路径或相对于当前工作区），避免大 JSON 占用上下文。',
        },
        timeoutMs: {
          type: 'number',
          description: '请求超时时间（毫秒），默认为 30000。',
        },
        maxChars: {
          type: 'number',
          description: '返回给模型的最大文本字符数，默认 40000。',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          status: { type: 'number' },
          savedPath: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.text || '') }]
      },
    },
    presentCall(args) {
      const method = (args?.method || 'GET').toUpperCase()
      return { card: 'terminal', title: `fetch_json ${method} ${args?.url || ''}` }
    },
    presentResult(args, result) {
      try {
        const text = ((result && result.content) || [])
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        return {
          card: 'terminal',
          title: `fetch_json ${(args?.method || 'GET').toUpperCase()} ${args?.url || ''}`,
          output: text,
          exitCode: result && result.isError ? 1 : 0,
        }
      } catch {
        return undefined
      }
    },
    async execute(args, exec) {
      const startTime = Date.now()
      const method = (args.method || 'GET').toUpperCase()
      const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : DEFAULT_TIMEOUT_MS
      const maxChars = Number(args.maxChars) > 0 ? Number(args.maxChars) : DEFAULT_MAX_CHARS

      let targetUrl
      try {
        targetUrl = buildUrl(args.url, args.params)
      } catch (err) {
        throw new Error(`无效的请求 URL: ${args.url} (${err.message})`)
      }

      const headers = {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': DEFAULT_USER_AGENT,
        ...(args.headers || {}),
      }

      let reqBody = undefined
      if (args.body !== undefined && args.body !== null) {
        if (typeof args.body === 'object') {
          reqBody = JSON.stringify(args.body)
          if (!headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/json'
          }
        } else {
          reqBody = String(args.body)
        }
      }

      const signal = exec?.signal
        ? AbortSignal.any([exec.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)

      let res
      try {
        res = await fetch(targetUrl, {
          method,
          headers,
          body: reqBody,
          signal,
          redirect: 'follow',
        })
      } catch (err) {
        if (err.name === 'TimeoutError') {
          throw new Error(`fetch_json 请求超时 (${timeoutMs}ms): ${targetUrl}`)
        }
        throw new Error(`fetch_json 网络请求失败: ${err.message}`)
      }

      const elapsed = Date.now() - startTime
      const rawText = await res.text()
      let parsed = null
      let parseOk = false
      try {
        parsed = JSON.parse(rawText)
        parseOk = true
      } catch {
        // Non-JSON response
      }

      let savedFilePath = undefined
      if (args.savePath) {
        const fullSavePath = resolve(process.cwd(), args.savePath)
        mkdirSync(dirname(fullSavePath), { recursive: true })
        writeFileSync(fullSavePath, rawText, 'utf8')
        savedFilePath = fullSavePath
      }

      if (!res.ok) {
        const errorDetail = parsed ? JSON.stringify(parsed, null, 2) : clip(rawText, 2000)
        throw new Error(
          `fetch_json HTTP ${res.status} ${res.statusText} (${elapsed}ms)\n` +
            `URL: ${targetUrl}\n` +
            `响应内容:\n${errorDetail}` +
            (savedFilePath ? `\n(已保存原始响应至文件: ${savedFilePath})` : ''),
        )
      }

      let payloadToOutput = parsed
      if (parseOk && args.select) {
        payloadToOutput = getByPath(parsed, args.select)
      }

      const formattedJson = parseOk
        ? JSON.stringify(payloadToOutput, null, 2)
        : clip(rawText, maxChars)

      let outputHeader = `[HTTP ${res.status} OK | ${elapsed}ms | ${rawText.length} 字节]`
      if (savedFilePath) {
        outputHeader += `\n已保存至文件: ${savedFilePath}`
      }
      if (args.select) {
        outputHeader += `\n[已筛选分支: "${args.select}"]`
      }

      const outputText = `${outputHeader}\n\n${clip(formattedJson, maxChars)}`
      return {
        text: outputText,
        status: res.status,
        ...(savedFilePath ? { savedPath: savedFilePath } : {}),
      }
    },
  }
}

/**
 * 本插件提供 `fetch_json`（结构化 API 抓取 + select 分支抽取 + savePath 落盘）。
 */

export const name = 'dsh-fetch-tools'
export const inject = ['tools']

/** Cordis 插件入口 */
export function apply(ctx, config = {}) {
  const jsonTool = createFetchJsonTool(config)

  ctx.inject(['tools'], (scoped) => {
    const d1 = scoped.tools.register(jsonTool)
    ctx.on('dispose', () => {
      try {
        if (typeof d1 === 'function') d1()
      } catch {}
    })
  })
}
