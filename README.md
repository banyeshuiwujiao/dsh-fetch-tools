# dsh-fetch-tools

DSH（DeepSeek Harness）的一等公民 HTTP 抓取工具：**`fetch_json`**。

直接走 `fetch`，不起子进程，零冷启动开销。

> 原始纯文本/源码抓取（Markdown、YAML、raw 文件等）已统一交由内置的
> **`web_fetch`** 工具负责（参数等价、零冷启动）。本插件因此只保留
> 结构化 API 抓取能力 `fetch_json`，避免与 `web_fetch` 重复。

## 工具

### `fetch_json`

HTTP JSON API 请求，返回结构化 JSON。

- `url` — 目标 HTTP/HTTPS URL（必填）
- `method` — `GET` / `POST` / `PUT` / `DELETE` / `PATCH`（默认 `GET`）
- `headers` — 自定义请求头
- `params` — URL Query 参数（自动编码拼接）
- `body` — 请求体；对象会被 JSON 序列化并自动补 `Content-Type: application/json`
- `select` — 只提取需要的子属性（如 `"data.endpoints"`），防止大响应吃爆上下文
- `savePath` — 把**原始响应**直接落盘
- `timeoutMs` — 超时（默认 30000）
- `maxChars` — 正文裁剪上限（默认 40000，超出时提示改用 `savePath`）

## 装到运行时

插件以 **junction** 接线（`node_modules/dsh-fetch-tools` 指回本目录），不是拷贝——
拷贝会漂移，改了代码不生效。

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-fetch-tools" `
  -Target "C:\Users\Admin\DeepSeek_Harness\dsh-client-config\plugins\dsh-fetch-tools"
```

本插件不 import 宿主包，所以不需要额外的 `node_modules` junction（与
`dsh-web-search-searxng` 不同——那个 import 了宿主提供的 `@deepseek-ai/dsh-web`）。

## 门禁

```powershell
npm test        # node test/smoke.mjs
```

16 个用例。`fetch` 用 `globalThis.fetch` 打桩：插件直接调用全局 fetch、不走任何
封装，所以替换全局即可，**无需网络、无需端口**。

测的是「工具参数 → HTTP 请求 → 输出文本」这一层，改代码的人最常在这里出错：

- query 参数拼进 URL、method 归一为大写
- 对象 body 被 JSON 序列化并补 Content-Type；字符串 body 原样透传
- 自定义请求头带上
- `select` 只输出目标分支，不混进其它分支
- 输出带状态头与格式化 JSON；非 JSON 响应原样带出（不吞内容）
- `savePath` 按 cwd 解析并把**原始响应**落盘
- 非 2xx 抛错且带上状态码、URL 与原始响应
- 网络异常被翻译成可读错误；非法 URL 在发出请求前被拦下

## 启用

`cordis.patch.yml` 里那行 insert 就是「启用」本身：只有当本包被列进 profile 的
`dsh.profile.bundles` 时才会应用，所以开关归插件清单，profile 侧不用再写条目。

## 关于 config

没有 config 是有意的：`apply(ctx, config)` 把 config 原样传给工具工厂，但两个工具体内
都没读过它——超时取的是模块常量 `DEFAULT_TIMEOUT_MS`(30000) 或每次调用的
`args.timeoutMs`。真要改默认超时，去改常量或让工具读 config，别在 profile 里加
不起作用的键。

## License

MIT
