# Magpie SSH Chat · Hugging Face

将 `ssh chat.hf.co` 接入 Magpie / OpenCode，并提供本地 OpenAI 兼容 HTTP 接口。当前为 **0.2.0 实验版**，SSH、远端终端会话和匿名密钥均由 JavaScript 实现。

已实测：匿名 SSH 聊天、实验性 JSON 工具调用闭环、动态完整模型目录。工具调用由提示词生成并经 JSON Schema 校验，**不是 HF SSH 原生 Function Calling**。插件不会执行工具；执行仍由 Agent 负责。

## 模型与访问范围

完整目录来自公开的 [HF 模型目录](https://router.huggingface.co/v1/models)，每 15 分钟按需刷新，失败时保留缓存。

2026-10-09 实测目录有 **128 个模型**，数量会变化。SSH `/model` 明确说明：匿名只能使用 `Qwen/Qwen3.8-27B`，其他模型需要 `/login`。本版尚未自动化 HF 登录与模型切换。

- `/v1/models` 返回完整目录，保留上游模型及供应商信息，并附加 `ssh_available`、`ssh_access`、`ssh_tool_calling`。
- Magpie 的活动模型池只包含匿名已验证可用的 Qwen。其他目录项目前不能通过本插件调用，返回 `403 hf_login_required`。
- 目录中的价格、上下文长度、`supports_tools` 是上游 HTTP 供应商信息，不能据此推断 SSH 通道能力或费用。
- 未验证无限额度；界面要求登录后才能切换模型，匿名限额由 HF 决定。

## 安装到 Magpie

在 Magpie 的插件页添加以下仓库即可：

```text
github:mu-zi-lee/magpie-ssh-chat-hf-co
```

也可以使用一条命令：

```sh
magpie plugin add github:mu-zi-lee/magpie-ssh-chat-hf-co
```

Magpie 自动准备插件的 Bun 运行时并安装 JavaScript 依赖。插件在首次加载时自动登记匿名账号，首次请求时自动生成内存中的匿名 SSH 密钥、保存服务器指纹并建立连接。已有该供应商账号时保留原账号。

**不需要自行安装 Python、OpenSSH、Node.js、编译工具，不需要执行安装脚本、填 API Key、手动登录或启动 HTTP 服务。** 服务器仍需能访问 HF 模型目录和 `chat.hf.co:22`。

供应商 ID 为 `hf-ssh`，模型 ID 为 `Qwen/Qwen3.8-27B`。已使用 Magpie 官方 `internal/plugin/host.js` 在清空 PATH 的独立目录验证自动账号登记、模型枚举和真实 SSE 请求；完整 Magpie 应用 / 网关与真实 Agent 尚未验收。JavaScript SSH 不使用操作系统的 PTY 或系统命令，Windows 兼容性尚未实机验证。

插件的选项可配置：

```json
{
  "timeoutMs": 150000,
  "requestTimeoutMs": 210000,
  "maxPromptChars": 60000,
  "autoConnect": true
}
```

这些选项有默认值，无需配置。`autoConnect: false` 可关闭加载时的匿名账号登记。默认并发为 1。每个请求创建独立 SSH 会话，并发送完整消息历史，避免不同对话共享状态。Magpie 直接调用插件的 `fetch`。

### 独立 OpenAI 兼容接口

此模式供不通过 Magpie 的客户端使用，独立运行时才需要 Bun 或 Node.js 20+。它不是 Magpie 插件安装步骤。

```sh
bun install --ignore-scripts
bun scripts/serve.mjs
# 仅监听 127.0.0.1:5695；MAGPIE_HF_PORT 可修改端口
```

客户端配置：Base URL 为 `http://127.0.0.1:5695/v1`，API Key 填 `anonymous`，模型填 `Qwen/Qwen3.8-27B`。本地服务不校验 API Key。

```sh
curl http://127.0.0.1:5695/v1/models

curl http://127.0.0.1:5695/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen3.8-27B","messages":[{"role":"user","content":"你好"}]}'

curl -N http://127.0.0.1:5695/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen3.8-27B","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

支持 `messages` 中的 system/developer/user/assistant/tool、文本内容、`tools`、`tool_choice`、`parallel_tool_calls` 和 SSE。返回标准 `tool_calls`、调用 ID 及 `finish_reason`。

**SSE 是缓冲输出**：等待 SSH 生成时发送心跳，完整回复校验通过后输出内容或工具调用，并结束于 `[DONE]`。未完成或非法 JSON 不会交给工具执行端。

## 开发与可选验证

使用 Magpie 时无须执行以下步骤。本地开发者可以运行：

```sh
bun install --frozen-lockfile --ignore-scripts
bun test                      # 离线测试，无 HF 请求
bun scripts/probe.mjs --models # 真实 SSH 探针，读取访问限制
bun scripts/smoke.mjs          # 真实两轮 JSON 工具调用；工具结果为测试数据
bun scripts/smoke-http.mjs     # 验证真实 HTTP SSE，完成后自动退出
bun scripts/smoke-host.mjs /path/to/magpie/internal/plugin/host.js
# 官方宿主验证：PATH 为空、自动登记账号、不调用登录 RPC
```

探针和 smoke 结果写入 `.local/`，不加入 Git。探针包含终端原始数据；请勿提交含个人对话的诊断文件。

## 当前限制

- HF 的终端界面不是稳定 API。UI 修改、模型不遵守格式、终端换行或截断会返回错误。
- 回复提示限定约 4000 字符，完整请求提示默认最多 60000 字符；适合短工具请求与小改动，长文件编辑尚未验证。不会自动截断历史。
- 暂不支持图片、音频、原生推理流和原生结构化输出。客户端常附带的 `max_tokens` / `max_completion_tokens` 转为提示词里的软目标，不是硬性 token 上限；`temperature`、`top_p`、`seed` 和惩罚项不生效。响应头 `x-hf-ssh-soft-token-limit` 和 `x-hf-ssh-ignored-parameters` 明确说明这两种情况。`stop`、`response_format`、logprobs 和旧版 functions 协议仍返回 400。
- `tools` 的 JSON Schema 校验不验证自定义 `format`。不自动重试格式失败或限流请求。
- 上游 quota 不可见，插件显示“未知”；不进行多账号轮换或扩额。
- Windows 实机验证、HF 登录、多模型切换、完整 Magpie 网关 / OpenCode Agent 测试尚待完成。

SSH 使用内存中的临时匿名密钥，不使用个人 SSH 配置、密钥或 agent。首次连接自动保存 SHA-256 主机指纹，后续拒绝密钥变化；这属于首次信任，不代表已独立验证服务器指纹。Magpie 的主机指纹与模型缓存保存于其配置目录中的 `hf-ssh-state/`；独立服务保存于 `.local/ssh/`。临时私钥不会写入磁盘。

对话、系统提示词、工具定义与工具结果都会发送给 `chat.hf.co`。Magpie 设置的 HTTP 代理仅影响目录请求；SSH 22 端口连接由插件的 JavaScript SSH 客户端直接发起。

协议验证与后续工作见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。本项目为非官方 MIT 社区插件。
