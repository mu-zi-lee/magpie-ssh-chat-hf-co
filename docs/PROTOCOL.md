# 协议验证记录与架构

验证日期：2026-10-09；环境：macOS、Node.js 24、Bun 1.4、Python 3、系统 OpenSSH。

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
| 原生工具调用 | 尚未发现接口或得到验证 |
| 完整模型目录 | 公开 HTTP `/v1/models` 返回 128 项；不等于 SSH 匿名可用列表 |

HF SSH 原生协议仍未得到证实。当前实现采用用户允许的实验性提示词兼容层，不声称原生 Tool Calling。

## 实现路径

1. Magpie/OpenCode 的 Provider `loader.fetch` 或独立 HTTP 服务接收 Chat Completions。
2. 校验请求；把消息历史、工具结果、JSON Schema 与工具选择序列化进提示词。
3. 每个请求启动独立 Python stdlib PTY worker，由 OpenSSH 连接 HF。子进程参数采用 argv，不运行 shell 字符串。
4. `@xterm/headless` 重建屏幕与应答能力查询，处理光标移动、局部重绘和拆分的 UTF-8/ANSI。
5. 从模型回复区域读取带随机分隔符的 JSON，要求结束标记、空闲输入框与稳定屏幕；不以单纯静默判定成功。
6. 校验函数名、参数 schema、工具选择和并行开关，再生成标准 Chat Completions / SSE。
7. 客户端执行工具后，在下个请求中携带完整历史与 `tool_call_id`；插件不执行工具。

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
