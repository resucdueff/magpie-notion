# magpie-notion

版本：1.0.5

`magpie-notion` 是一个把 Notion AI 接入 Magpie / OpenCode 的非官方插件。它使用
Notion 网页客户端所调用的内部接口，不是 Notion 的公开 Integration API；Notion
更新网页端后，插件可能失效。

## 风险与账号建议

- 插件调用 Notion 网页端的非官方内部接口。创建对话线程时，它使用 `impit` 模拟
  Chrome 的 TLS/HTTP 指纹。
- 插件默认不限制同一账号的并发请求；如果 Magpie 中为 Notion 单独设置了并发，
  则以该设置为准。
- 上述做法可能违反 Notion 服务条款，并导致账号被限制或封禁。请不要使用重要的
  工作账号，或任何不能承受异常风险的账号。
- 每段对话都会在 Notion AI 聊天记录中留下一个线程。系统提示发生变化或插件进程
  重启后，后续对话可能会新建线程，而不是继续原来的线程。

插件图标使用 Notion 官方黑白 N 方块标志，源文件保存在 `notion.svg`，
并内嵌到包元数据里。名称与标志属于 Notion；本项目是非官方插件。

## 安装

```sh
magpie plugin add github:resucdueff/magpie-notion
magpie plugin login notion
```

Magpie 添加插件时会安装运行依赖。运行时 provider id 仍是 `notion`；插件列表中
显示的名称是 `magpie-notion`。

## 登录

登录只有一个输入框：粘贴你自己的 Notion `token_v2`。

- 可以只粘贴 `token_v2` 的值。
- 也可以误贴整段含 `token_v2=` 的 Cookie；插件只提取 `token_v2`，不会使用其中
  的其他 Cookie。
- 空内容、找不到 `token_v2`、带换行的输入都会被拒绝。
- 登录失败时提示：`请粘贴 Notion 的 token_v2。`
- 不打开网页，也不轮询浏览器。

登录不需要填写工作区 UUID。插件会调用 `getSpaces` 自动发现账号可用的工作区，
再通过模型目录确认当前工作区。`token_v2` 只交给宿主自己的认证存储保存，不要
写进源码、命令参数、日志或提交记录。

### 获取 `token_v2`

`token_v2` 是 Notion 网页登录后保存在你自己浏览器里的会话值。只使用你自己的账号。

1. 用浏览器打开 https://www.notion.so 并登录，进入任意工作区。
2. 打开开发者工具。Windows 和 Linux 按 F12，macOS 按 Option-Command-I。
3. 选择「应用」或 Application，左侧展开 Cookie，点选 `https://www.notion.so`。
4. 找到名称正好是 `token_v2` 的一行，只复制它的值；不要复制名称，也不要复制整段 Cookie。
5. 回到 Magpie 的 Notion 登录页，把值粘贴进「粘贴 token_v2」。

如果没有「应用」面板，可以打开「网络」或 Network，刷新页面，点开任意一个发往
`www.notion.so` 的请求，在请求头 Cookie 中找到 `token_v2=`，复制等号后面、下一个
分号前面的内容。

这个值等同于登录状态。只粘贴到自己的 Magpie，不要发到聊天、工单或 Git 仓库。
失效后按同样的步骤重新复制。

复制时要整段选中。以 `v03:` 开头的值中间有好几段，用点号分开；少了最后一段时 Notion 会直接拒绝。会话被拒绝后，插件只能显示内置的一个占位模型，用量也是空的。请重新复制完整的 `token_v2`，不要把这个值发到聊天里。

每个账号同时发出的请求不限制。如果在 Magpie 里给 Notion 单独设了并发，以那个设置为准。

## 工具调用

插件不执行客户端附带的工具。Codex 等代理每次请求都会带上工具定义；这些定义会被去掉，对话仍按纯文本发给 Notion，并返回文字回答。

已经发生过的工具调用和工具结果会折成文字留在上下文里，Notion 不会再次执行它们。图片仍然拒绝。因此 Notion 模型可以正常对话，但不能替 Codex 运行 shell、改文件或调用其他工具。

## 长上下文

插件内部使用 **40,000 token** 的保守安全窗口。它使用随依赖安装的纯 JavaScript
`gpt-tokenizer`（`cl100k_base` 词表）在本地计算 token，不调用网络 API，也不会在
运行时下载词表。这只是适配器的安全阈值，不是 Notion 官方公布的限制；Notion 的私有
tokenizer 与 `cl100k_base` 可能有差异，因此 40K 比实测约 51K 的边界低约 11K，而不是
把 40K 当成官方上限。

插件不发布 `limit.context`。Magpie / OpenCode 的宿主 token 估算可能与 `cl100k_base`
不同，若把 40K 作为宿主预检上限，正常请求可能在到达插件前就被误判超限。上下文仍由
插件按 cl100k 在本地检查；真正超过 40K 时会在调用 Notion 前明确返回
`context_length_exceeded`。

历史较长时，插件会完整保留 system/developer 指令和最新一条 user 消息，从新到旧
整条装入近期消息，省略标记本身也计入 token 预算。完整历史首次超过窗口后会改用有界
近期历史新建线程，后续轮次优先续写该线程；每个远端线程累计
`initialPlan.tokens + user/assistant tokens + 256 token 余量`，到 40,000 token 前
主动重新生成有界上下文并 rollover，不先发送一个已知超限的请求。另设 2 MB UTF-8
输入上限，只用于防止异常大请求消耗资源，不作为正常上下文判断。

system/developer 指令单独超过 token 上限、最新 user 单独超过 token 上限，或两者
分别未超限但合在一起超限时，请求都会在调用 Notion 前返回
`context_length_exceeded`，错误信息会分别说明原因；请缩短对应内容或新开会话。
