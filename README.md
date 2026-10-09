# Magpie SSH Chat · Hugging Face

通过 `ssh chat.hf.co` 在 Magpie 中使用 Hugging Face 匿名聊天，无需 HF 账号或 API Key。也可独立运行，为 OpenCode 等客户端提供 OpenAI 兼容的 Chat Completions 接口。

**当前为实验版。** 支持文本对话和实验性工具调用；目前仅可调用 `Qwen/Qwen3.8-27B`，尚未实现 HF 登录和模型切换。匿名额度由 HF 决定，无法查询，也未验证无限使用。

## 在 Magpie 中使用

在 Magpie 插件页添加仓库：

```text
github:mu-zi-lee/magpie-ssh-chat-hf-co
```

或通过命令安装：

```sh
magpie plugin add github:mu-zi-lee/magpie-ssh-chat-hf-co
```

安装后，插件会自动登记匿名账号。在模型选择器中选择 **Hugging Face SSH Chat (experimental)** 下的 `Qwen/Qwen3.8-27B` 即可使用，供应商 ID 为 `hf-ssh`。

Magpie 会准备运行时和依赖，无需额外安装 Python、OpenSSH 或 Node.js，也无需手动启动服务。运行 Magpie 的机器需能访问 `chat.hf.co:22` 和 [HF 模型目录](https://router.huggingface.co/v1/models)。SSH 连接直接发起，不经过 Magpie 的 HTTP 代理。

## 供其他客户端使用

独立服务需要 Bun 或 Node.js 20+。以 Bun 为例：

```sh
git clone https://github.com/mu-zi-lee/magpie-ssh-chat-hf-co.git
cd magpie-ssh-chat-hf-co
bun install --frozen-lockfile --ignore-scripts
bun scripts/serve.mjs
```

服务默认仅监听本机 `127.0.0.1:5695`，可用环境变量 `MAGPIE_HF_PORT` 修改端口。客户端填写：

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:5695/v1` |
| API Key | `anonymous`（占位值，本地服务不校验） |
| Model | `Qwen/Qwen3.8-27B` |

发送一次对话：

```sh
curl http://127.0.0.1:5695/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen3.8-27B","messages":[{"role":"user","content":"你好"}]}'
```

接口支持文本 `messages`、`tools`、`tool_choice`、`parallel_tool_calls` 和 `stream: true`。`GET /v1/models` 返回 HF 公开模型目录，其中 `ssh_available: true` 表示本插件可调用；其他模型返回 `403 hf_login_required`。目录中的价格、上下文长度和工具能力来自 HTTP 供应商，不代表 SSH 通道能力。

## 使用前须知

- **工具调用通过提示词实现。** 插件解析并校验模型生成的 JSON，再返回标准 `tool_calls`，工具由客户端执行。这不是 HF SSH 原生 Function Calling。
- **SSE 为缓冲输出。** 等待期间发送心跳，完整回复校验通过后才输出内容或工具调用，不会逐 token 推送。
- **上下文较小。** 完整提示词最多 8000 字符，包含历史、工具定义和协议指令；超限返回 `400 context_length_exceeded`。回复 JSON 最多 4000 字符，超限返回 `reply_too_large`。长对话需压缩历史，大文件需分步处理。
- **兼容范围有限。** 仅支持文本；`max_tokens` / `max_completion_tokens` 仅作为软目标，`temperature`、`top_p`、`seed` 和惩罚项不生效；`stop`、`response_format`、logprobs 和旧版 functions 协议不支持。
- **请求串行执行。** 默认最多容纳 8 个请求，包含正在执行的请求；队列满时返回 `503 ssh_queue_full`。开始发送后不会自动重试。
- **上游终端界面可能变化。** 格式错误或界面截断会导致请求失败。已验证 Magpie 官方插件宿主和独立 AI SDK 工具循环；完整 Magpie 应用 / 网关、OpenCode Agent 和 Windows 实机仍待验证。

对话、系统提示词、工具定义和工具结果都会发送给 `chat.hf.co`。插件使用内存中的临时匿名 SSH 密钥；首次连接保存服务器指纹，之后拒绝指纹变化，不读取个人 SSH 密钥或配置。

## 开发

```sh
bun install --frozen-lockfile --ignore-scripts
bun test  # 离线测试，不请求 HF
```

架构、验证记录和后续计划见 [协议文档](docs/PROTOCOL.md)。问题反馈请提交 [Issue](https://github.com/mu-zi-lee/magpie-ssh-chat-hf-co/issues)。

非官方社区插件，采用 [MIT License](LICENSE)。
