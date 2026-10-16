# opencode-notion-auth

用你自己的 Notion 网页会话，把工作区里 Notion AI 的模型接到 magpie / OpenCode 上，
并在 `magpie quota` 里看到订阅额度的使用情况。

走的是 Notion 网页内部客户端 API，不是公开 Integration API。非官方插件，
Notion 改版后可能失效；开发跟踪
[magpie-community/plugins#118](https://github.com/magpie-community/plugins/issues/118)。

## 安装

```sh
magpie plugin add https://github.com/resucdueff/magpie-notion
magpie plugin login notion
```

登录有两种方式，都不需要你填工作区 UUID：

- **直接用本机浏览器里已登录的 Notion 会话**（默认方式）。插件会按
  Chrome、Edge、Brave、Chromium、Firefox 的顺序去找本机的 cookie 库，
  先复制再打开，不会干扰正在运行的浏览器。Windows 用 profile 里
  `Local State` 的 DPAPI 密钥解密，macOS 走钥匙串，Linux 走 `secret-tool`；
  `v20`（app-bound）这类解不开的值会如实报错，不会瞎猜。库读不动时
  （浏览器占着文件，或值是 app-bound），再问正在运行的 Chromium：
  读它 profile 里的 `DevToolsActivePort`，用一次本地 WebSocket 只读地问它自己的
  cookie。走这条路要求浏览器是带调试端口启动的（`--remote-debugging-port`，
  `--remote-debugging-pipe` 不开放端口）。请求密集时，同一个浏览器最多每
  分钟问一次；一旦请求返回 401，这个复用立刻作废、下次重新读。
- **手动粘贴 Cookie 请求头**：给本插件读不了的浏览器用。填你本人 Notion
  网页会话的完整 Cookie 请求头，`spaceId`、activeUserId 都可留空。

工作区（`spaceId`）是自动发现的：先问会话有哪些 space，再逐个用
`getAvailableModels` 探测，第一个能答的就是当前工作区，那份模型表也就直接
用上了，并按会话缓存 30 分钟。你也可以显式填一个 UUID，插件会在发请求前
校验格式。

Cookie 只由宿主自己的 auth 存储保存（Magpie 的 `plugin-auth.json` 或
OpenCode 的 auth store）；本插件不外传、不续期——会话过期就在浏览器里重新登录
一次，插件下次会自动读到。

## 提供什么

- provider 名 `notion`；模型列表实时取自工作区的 `getAvailableModels`，
  没有写死的模型表，工作区看不到的模型也不会被放进来。
- `auth.usage`：`magpie quota` 显示订阅窗口用量与 premium 积分余额。
- 流式输出，SSE 与缓冲 JSON 两种上游形式都支持。

## 限制

- 需要真正的 Notion Business（或更高）工作区并且开通 Notion AI；
  没有 AI 计划、额度耗尽会报相应错误。
- 图片输入与客户端函数/工具调用被拒绝；Notion 自身的服务端工具可能仍然
  可用，因此不要把它当作隔离沙箱使用。
- 会话过期后请在浏览器里重新登录；插件不代你续期，但会重新读取本机会话。
- 上下文长度等限制未公开，按“未知”处理（显示为 0），不会编造数值。
- 每次推理总时长默认 5 分钟（`timeoutMs`）；从浏览器读到的会话默认复用
  60 秒（`browserReadMs`，设 0 表示每次都读）。

## 自检

```sh
node check.mjs
bun test
```
