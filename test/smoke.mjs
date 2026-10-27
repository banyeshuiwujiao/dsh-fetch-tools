/**
 * dsh-fetch-tools 自测 —— 打桩 fetch，不发真请求。
 *
 *   node test/smoke.mjs
 *
 * 测的是「工具参数 → HTTP 请求 → 输出文本」这一层。改代码的人最常在这里出错：
 * URL 拼装漏参数、method 没大写、select 路径取不到、savePath 没落盘、
 * 非 2xx 抛出的错误里丢了状态码与原始响应。
 *
 * fetch 用 globalThis.fetch 打桩：插件直接调用全局 fetch，不走任何封装，
 * 所以替换全局即可，无需网络、无需端口。
 */

import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { createFetchJsonTool, name, inject } from '../index.mjs'

let passed = 0
async function check(label, fn) {
  await fn()
  passed++
  console.log(`  ok  ${label}`)
}

/** 打桩 fetch：记录请求，返回给定的响应。 */
function stubFetch(response) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText ?? '',
      text: async () => response.body ?? '',
    }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

console.log('插件契约')

await check('name 与 inject 符合 DSH 插件约定', () => {
  assert.equal(name, 'dsh-fetch-tools')
  assert.deepEqual(inject, ['tools'])
})

await check('fetch_json 工具的名字与参数 schema 齐备', () => {
  const json = createFetchJsonTool()
  assert.equal(json.name, 'fetch_json')
  assert.equal(json.parameters.type, 'object')
  assert.ok(json.parameters.properties.url, 'fetch_json 缺 url 参数')
  assert.ok(json.parameters.properties.select, 'fetch_json 缺 select 参数')
  assert.ok(json.parameters.properties.savePath, 'fetch_json 缺 savePath 参数')
})

console.log('fetch_json：请求构造')

await check('query 参数被拼进 URL，method 归一为���写', async () => {
  const { calls, restore } = stubFetch({ status: 200, body: '{"ok":true}' })
  try {
    const tool = createFetchJsonTool()
    await tool.execute({ url: 'https://api.example.com/v1/items', method: 'post', params: { q: 'x', page: 2 } })
    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.match(call.url, /q=x/)
    assert.match(call.url, /page=2/)
    assert.equal(call.init.method, 'POST', 'method 没被大写')
    assert.match(call.init.headers.Accept, /application\/json/)
  } finally { restore() }
})

await check('对象 body 被 JSON 序列化并补 Content-Type', async () => {
  const { calls, restore } = stubFetch({ status: 200, body: '{}' })
  try {
    const tool = createFetchJsonTool()
    await tool.execute({ url: 'https://api.example.com/x', body: { a: 1 } })
    assert.equal(calls[0].init.body, '{"a":1}', '对象 body 没被 JSON 序列化')
    assert.match(calls[0].init.headers['Content-Type'], /application\/json/, '对象 body 缺 Content-Type')
  } finally { restore() }
})

await check('字符串 body 原样透传', async () => {
  const { calls, restore } = stubFetch({ status: 200, body: '{}' })
  try {
    const tool = createFetchJsonTool()
    await tool.execute({ url: 'https://api.example.com/x', body: 'raw text' })
    assert.equal(calls[0].init.body, 'raw text', '字符串 body 被改动了')
  } finally { restore() }
})

await check('自定义请求头会带上', async () => {
  const { calls, restore } = stubFetch({ status: 200, body: '{}' })
  try {
    const tool = createFetchJsonTool()
    await tool.execute({ url: 'https://x.test', headers: { 'X-Test': '1' } })
    assert.equal(calls[0].init.headers['X-Test'], '1')
  } finally { restore() }
})

console.log('fetch_json：输出与筛选')

await check('select 只输出目标分支', async () => {
  const { restore } = stubFetch({ status: 200, body: JSON.stringify({ data: { endpoints: ['a', 'b'] }, other: 1 }) })
  try {
    const tool = createFetchJsonTool()
    const out = await tool.execute({ url: 'https://x.test', select: 'data.endpoints' })
    assert.ok(out.text.includes('"a"'), 'select 没取到目标分支')
    assert.ok(!out.text.includes('"other"'), 'select 后仍混进了其它分支')
    assert.equal(out.status, 200)
  } finally { restore() }
})

await check('select 多字段返回以叶子名为键的对象', async () => {
  const body = JSON.stringify({ name: 'camofox', stargazers_count: 12002, language: 'JavaScript', other: 9 })
  const { restore } = stubFetch({ status: 200, body })
  try {
    const tool = createFetchJsonTool()
    const out = await tool.execute({ url: 'https://x.test', select: 'name,stargazers_count,language' })
    const json = JSON.parse(out.text.slice(out.text.indexOf('{')))
    assert.deepEqual(json, { name: 'camofox', stargazers_count: 12002, language: 'JavaScript' }, '多字段未正确聚合')
    assert.ok(!out.text.includes('"other"'), '多字段仍混进了未选分支')
    assert.ok(out.text.includes('[已筛选 3 个分支'), '输出头没标注字段数')
  } finally { restore() }
})

await check('select 多字段叶子键冲突时回退为完整路径', async () => {
  const body = JSON.stringify({ a: { id: 1 }, b: { id: 2 } })
  const { restore } = stubFetch({ status: 200, body })
  try {
    const tool = createFetchJsonTool()
    const out = await tool.execute({ url: 'https://x.test', select: 'a.id,b.id' })
    const json = JSON.parse(out.text.slice(out.text.indexOf('{')))
    assert.deepEqual(json, { id: 1, 'b.id': 2 }, '叶子键冲突未回退为完整路径')
  } finally { restore() }
})

await check('输出带状态头与格式化 JSON', async () => {
  const { restore } = stubFetch({ status: 200, body: '{"a":1}' })
  try {
    const tool = createFetchJsonTool()
    const out = await tool.execute({ url: 'https://x.test' })
    assert.ok(out.text.includes('[HTTP 200 OK'), '输出缺少状态头')
    assert.ok(out.text.includes('"a": 1'), '输出没有格式化 JSON')
  } finally { restore() }
})

await check('非 JSON 响应原样带出（不吞内容）', async () => {
  const { restore } = stubFetch({ status: 200, body: 'not json' })
  try {
    const tool = createFetchJsonTool()
    const out = await tool.execute({ url: 'https://x.test' })
    assert.ok(out.text.includes('not json'), '非 JSON 响应没原样带出')
  } finally { restore() }
})

console.log('fetch_json：savePath 落盘')

await check('savePath 按 cwd 解析并把原始响应落盘', async () => {
  // savePath 是相对 process.cwd() 解析的（工具约定），所以期望路径按 cwd 算。
  const rel = 'dsh-fetch-tools-smoke/payload.json'
  const dir = resolve(process.cwd(), 'dsh-fetch-tools-smoke')
  const target = resolve(process.cwd(), rel)
  rmSync(dir, { recursive: true, force: true })
  const { restore } = stubFetch({ status: 200, body: '{"saved":true}' })
  try {
    const tool = createFetchJsonTool()
    const out = await tool.execute({ url: 'https://x.test', savePath: rel })
    assert.equal(out.savedPath, target, 'savedPath 不是按 cwd 解析的绝对路径')
    assert.equal(readFileSync(target, 'utf8'), '{"saved":true}', '落盘内容与响应不一致')
    assert.ok(out.text.includes('已保存至文件'), '输出没告知已保存')
  } finally {
    restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log('错误处理')

await check('非 2xx 抛错且带上状态码、URL 与原始响应', async () => {
  const { restore } = stubFetch({ status: 404, statusText: 'Not Found', body: '{"detail":"missing"}' })
  try {
    const tool = createFetchJsonTool()
    await assert.rejects(
      () => tool.execute({ url: 'https://x.test' }),
      (err) => {
        assert.match(err.message, /HTTP 404/, '错误里缺状态码')
        assert.match(err.message, /missing/, '错误里缺原始响应内容')
        assert.match(err.message, /https:\/\/x\.test/, '错误里缺 URL')
        return true
      },
    )
  } finally { restore() }
})

await check('500 同样报出状态码', async () => {
  const { restore } = stubFetch({ status: 500, statusText: 'Server Error', body: 'boom' })
  try {
    const tool = createFetchJsonTool()
    await assert.rejects(() => tool.execute({ url: 'https://x.test' }), /HTTP 500/)
  } finally { restore() }
})

await check('网络异常被翻译成可读错误', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('boom') }
  try {
    const tool = createFetchJsonTool()
    await assert.rejects(() => tool.execute({ url: 'https://x.test' }), /网络请求失败/)
  } finally { globalThis.fetch = original }
})

await check('非法 URL 被拦下（不发出请求）', async () => {
  const tool = createFetchJsonTool()
  await assert.rejects(() => tool.execute({ url: 'not-a-url' }), /无效的请求 URL/)
})

console.log(`\n✅ ${passed} 个用例通过`)
