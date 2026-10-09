# 协议验证记录与架构

验证日期：2026-10-09；初版探测使用 macOS 系统 OpenSSH；0.2.0 已替换为 JavaScript SSH，并在 Bun 1.4、清空 PATH 的环境中验证。

## 现场发现

| 项目 | 结果 |
| --- | --- |
| SSH DNS 与握手 | 成功 |
| 无认证 `none` | `Permission denied (publickey,keyboard-interactive)` |
| 临时生成 Ed25519 公钥 | 可以进入匿名服务，不需要 HF 账号 |
| 无 PTY | `Requires an active PTY` |
| 真 PTY + 终端能力应答 | 正常进入界面 |
| 默认模型 | `Qwen/Qwen3.8-27B @anonymous` |
| `/help` | `unknown command /help, try /model` |
| `/model` | `anonymous chats use Qwen/Qwen3.8-27B, type /login to pick any model` |
| 普通聊天 | 请求固定测试短语并得到正确回复 |
| JSON 兼容层 | `read_file` 请求 → 带 ID 的模拟结果 → 正确复述测试包名 |
| 真实 HTTP 服务 | 模型目录、403 访问限制、SSE 工具调用与 `[DONE]` 均通过 |
| 官方 Magpie Bun 宿主 | 独立目录加载、匿名账号登记、模型枚举和真实 HF SSE 请求均通过 |
| 0.2.0 自动安装流程 | 无登录 RPC、PATH 为空，插件加载时自动登记匿名账号，真实 HF 请求通过 |
| 0.2.0 外部运行工具 | Python、OpenSSH、ssh-keygen、独立 Node.js 均不是插件运行依赖 |
| 原生工具调用 | 尚未发现接口或得到验证 |
| 完整模型目录 | 公开 HTTP `/v1/models` 返回 128 项；不等于 SSH 匿名可用列表 |

HF SSH 原生协议仍未得到证实。当前实现采用用户允许的实验性提示词兼容层，不声称原生 Tool Calling。

## 实现路径

1. Magpie/OpenCode 的 Provider `loader.fetch` 或独立 HTTP 服务接收 Chat Completions。
2. 校验请求；把消息历史、工具结果、JSON Schema 与工具选择序列化进提示词。
3. `ssh2` 在 Bun 内为每个请求建立独立 SSH 连接，申请远端 PTY。会话使用内存中的临时 ECDSA 密钥，无外部命令、系统 PTY 或私钥文件。首次信任并保存主机指纹，后续拒绝变化。
4. `@xterm/headless` 重建屏幕与应答能力查询，处理光标移动、局部重绘和拆分的 UTF-8/ANSI。
5. 从模型回复区域读取带随机分隔符的 JSON，要求结束标记、空闲输入框与稳定屏幕；不以单纯静默判定成功。
6. 校验函数名、参数 schema、工具选择和并行开关，再生成标准 Chat Completions / SSE。
7. 客户端执行工具后，在下个请求中携带完整历史与 `tool_call_id`；插件不执行工具。

## 0.3.0 匿名可靠性优化

- 复现：240 列终端下，包含多行代码的工具参数会被 HF Markdown 排版主动折行，导致 JSON 非法。Markdown 转义也可能改变引号和反斜杠。
- 调整：申请 8192 列、64 行虚拟终端，要求模型将完整 envelope 放入纯文本代码块，JSON 对象保持单行。4000 字符的 JSON 上限同时用于提示和解析校验，超出时返回 `reply_too_large`，不会裁剪参数。
- 读取终端自动折行时按 `isWrapped` 还原逻辑行，保留真实空格，去除中文宽字符在行尾产生的空白占位。
- 真实 AI SDK `ToolLoopAgent` 的 SSE 三轮流程通过：读取临时文件、精确复制到另一个临时文件、返回 `COPY_OK`。包含中文、缩进、引号、反斜杠、Markdown 特殊字符的 663 字符内容逐字一致。该测试仅操作自己创建的临时目录，不接触用户项目文件。
- 默认最多保留 8 个请求，包含当前执行项。过载时在打开 SSE 前返回 HTTP 503；取消等待项不执行，超时后释放队列。JSON/SSE 共用错误结构。
- 长历史探测发现输入框会截断超长粘贴；8000 字符的尾部完整，8001 字符丢失最后一个字符；7000 个中文字符的尾部完整，限制不是 UTF-8 字节数。输入上限改为 8000 字符，包含协议指令和工具定义（本地按 UTF-16 长度保守计数）。超限在连接前返回 `context_length_exceeded`，避免模型只读到历史开头而遗漏最新要求。此前的 60000 字符本地上限不能保证完整传入上游。
- 6428 字符的真实历史请求正确复述开头的 `EARLY_CONTEXT_9286` 和最后一条消息的 `LATEST_CONTEXT_3175`，耗时约 40 秒。
- 工具 Schema 编译后释放全局缓存引用，避免多轮请求累积 Schema 或重复 `$id` 导致误报。
- 仅在发送提示词之前，针对暂时网络故障重连一次。开始粘贴后、主机指纹不符、模型格式失败时不自动重试。
- 模型目录刷新失败后保留缓存，30 秒内避免反复访问失败的上游。目录单独标注 SSH 计费状态，不从 HTTP 供应商报价推断 SSH 费用。

HF 模型的思考时间计入请求超时。一次真实流程通过不代表任意长文件或所有 Agent 均稳定；完整 Magpie 网关、Windows 实机及登录仍未验证。

Magpie 安装插件时负责准备 Bun 与 npm 依赖，其宿主不运行依赖安装脚本。`ssh2` 的原生加速为可选项；本插件在禁用安装脚本、没有原生加速的环境中运行。加载时通过 Magpie 提供的 `client.auth.set` 自动登记匿名账号，保留已有供应商账号。插件只读取文档规定的 `plugin-auth.json` 判断账号是否存在，所有凭证写入通过宿主完成。

测试发现 `ssh2` 1.17 的 Ed25519 key generator 会错误剥除公钥的有效零前缀，偶尔生成无法解析的密钥。0.2.0 使用 ECDSA P-256 避开该路径。

未验证的能力不会从上游 HTTP 模型目录自动继承。目录保留所有模型，额外说明 SSH 访问情况；活动路由池仅启用已验证匿名默认模型。

## 接下来值得讨论

- HF 浏览器登录和 SSH 会话授权如何关联，授权是否可持久化。
- 登录后 `/model` 的完整菜单与公开目录是否一致，模型切换与 provider 后缀是否受支持。
- 真实 Agent 长上下文、长参数、文件编辑时的终端截断和 JSON 换行问题。
- 是否存在 HF 官方稳定结构化协议；若有，应优先替换终端模拟层。
- 使用完整 Magpie 应用 / 网关验证协议转换、模型刷新、取消和真实 Agent 工具执行循环。

参考：

- [Magpie 插件开发文档](https://usemagpie.ai/docs/zh/plugins)
- [Hugging Face 公开模型目录](https://router.huggingface.co/v1/models)
- [社区终端适配项目](https://github.com/dailyoozoo/hf-ssh-chat)（用于了解终端能力协商；未复制其代码）
