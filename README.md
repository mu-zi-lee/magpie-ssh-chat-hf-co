# Magpie SSH Chat · Hugging Face

将 `ssh chat.hf.co` 接入 Magpie / OpenCode，并提供本地 OpenAI 兼容 HTTP 接口。当前为 **macOS / Linux 实验版**。

已实测：匿名 SSH 聊天、实验性 JSON 工具调用闭环、动态完整模型目录。工具调用由提示词生成并经 JSON Schema 校验，**不是 HF SSH 原生 Function Calling**。插件不会执行工具；执行仍由 Agent 负责。

## 模型与访问范围

完整目录来自公开的 [HF 模型目录](https://router.huggingface.co/v1/models)，每 15 分钟按需刷新，失败时保留缓存。

2026-10-09 实测目录有 **128 个模型**，数量会变化。SSH `/model` 明确说明：匿名只能使用 `Qwen/Qwen3.8-27B`，其他模型需要 `/login`。本版尚未自动化 HF 登录与模型切换。

- `/v1/models` 返回完整目录，保留上游模型及供应商信息，并附加 `ssh_available`、`ssh_access`、`ssh_tool_calling`。
- Magpie 的活动模型池只包含匿名已验证可用的 Qwen。其他目录项目前不能通过本插件调用，返回 `403 hf_login_required`。
- 目录中的价格、上下文长度、`supports_tools` 是上游 HTTP 供应商信息，不能据此推断 SSH 通道能力或费用。
- 未验证无限额度；界面要求登录后才能切换模型，匿名限额由 HF 决定。

## 环境与安装

需要 Bun 或 Node.js 20+、Python 3、OpenSSH (`ssh` / `ssh-keygen`)。无原生 npm 扩展、无安装脚本。

```sh
cd /path/to/magpie-ssh-chat-hf-co
bun install --ignore-scripts
```

### 添加到 Magpie

```sh
magpie plugin add /absolute/path/to/magpie-ssh-chat-hf-co
magpie plugin login hf-ssh
# 本地账号标签填 anonymous，不需要 HF API Key
magpie provider test hf-ssh
```

供应商 ID 为 `hf-ssh`，模型 ID 为 `Qwen/Qwen3.8-27B`。已使用 Magpie 官方 `internal/plugin/host.js` 在独立目录验证加载、匿名账号登记、模型枚举和真实 SSE 请求；完整 Magpie 应用 / 网关与真实 Agent 尚未验收。修改后在 Magpie 中关闭再打开插件。

插件的选项可配置：

```json
{
  "python": "python3",
  "timeoutMs": 150000,
  "requestTimeoutMs": 210000,
  "maxPromptChars": 60000
}
```

默认并发为 1。每个请求创建独立 SSH 会话，并发送完整消息历史，避免不同对话共享状态。没有常驻 HTTP 服务要求，Magpie 直接调用插件的 `fetch`。

### 独立 OpenAI 兼容接口

```sh
npm run serve
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

## 验证

```sh
npm test                      # 离线测试，无 HF 请求
npm run probe -- --models     # 真实 SSH 探针，读取访问限制
npm run smoke                 # 真实两轮 JSON 工具调用；工具结果为测试数据
npm run smoke:http            # 启动临时 HTTP 服务并验证真实 SSE 工具调用，完成后自动退出
```

探针和 smoke 结果写入 `.local/`，不加入 Git。探针包含终端原始数据；请勿提交含个人对话的诊断文件。

## 当前限制

- HF 的终端界面不是稳定 API。UI 修改、模型不遵守格式、终端换行或截断会返回错误。
- 回复提示限定约 4000 字符，完整请求提示默认最多 60000 字符；适合短工具请求与小改动，长文件编辑尚未验证。不会自动截断历史。
- 暂不支持图片、音频、原生推理流、原生结构化输出或采样参数。`max_tokens`、`temperature`、`top_p`、`stop`、`response_format` 等返回 400，避免假装能够控制终端后端。需要这些字段的客户端应关闭对应配置。
- `tools` 的 JSON Schema 校验不验证自定义 `format`。不自动重试格式失败或限流请求。
- 上游 quota 不可见，插件显示“未知”；不进行多账号轮换或扩额。
- Windows 驱动、HF 登录、多模型切换、完整 Magpie 网关 / OpenCode Agent 测试尚待完成。

SSH 使用临时匿名密钥，不使用个人 SSH 配置、密钥或 agent。首次连接按 OpenSSH `accept-new` 保存主机密钥，后续拒绝密钥变化；这属于首次信任，不代表已独立验证服务器指纹。Magpie 的主机密钥与模型缓存保存于其配置目录中的 `hf-ssh-state/`；独立服务保存于 `.local/ssh/`。会话关闭时删除临时私钥。

对话、系统提示词、工具定义与工具结果都会发送给 `chat.hf.co`。依赖 Magpie 设置的 HTTP 代理仅影响目录请求；SSH 22 端口连接由系统 OpenSSH 直接发起。

协议验证与后续工作见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。本项目为非官方 MIT 社区插件。
