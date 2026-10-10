# Magpie SSH Chat · Hugging Face

将 `ssh chat.hf.co` 接入 Magpie，也可独立运行，为 OpenCode 等客户端提供 OpenAI 兼容的 Chat Completions 接口。

**0.5.0 实验版，支持本机及 Cloudflare 临时远程登录。** 使用 HF 账号链接认证，支持 `Qwen/Qwen3.8-27B` 的文本对话和实验性工具调用，尚未实现模型切换。登录不代表免费或无限使用，额度和费用由 HF 决定。当前已验证公钥关联及跨连接登录；真实聊天测试遇到 HF 账号余额不足，登录后的完整工具循环仍待验证。

## 在 Magpie 中使用

在插件页添加仓库，或运行：

```sh
magpie plugin add github:mu-zi-lee/magpie-ssh-chat-hf-co
```

1. 在供应商 `hf-ssh` 中选择 **Hugging Face 浏览器登录（链接认证）**；Magpie 运行在服务器或另一台电脑时，可直接选择 **Hugging Face 远程登录（Cloudflare 临时通道）**。
2. 在打开的登录页点击 **复制公钥**，再点击 **打开 HF 添加页面**。登录账号，将公钥粘贴到 **SSH Keys** 的 Key 输入框，名称可填 `Magpie HF SSH`。
3. 添加成功后返回 Magpie。插件自动验证密钥，再保存登录配置。
4. 选择 **Hugging Face SSH Chat (experimental)** 下的 `Qwen/Qwen3.8-27B`。

自动验证会在本次登录期间重试暂时的 SSH 断连和超时，并始终使用同一把密钥。最终超时会显示最近的检测原因；若提示无法连接 `chat.hf.co:22`，请检查运行 Magpie 的机器能否直接访问该地址，SSH 不经过 Magpie 的 HTTP 代理。重新发起登录会生成新的公钥，需要添加新登录页上的公钥。

旧版的 `anonymous` 配置需要重新登录。认证通过 HF 官方的公钥关联页面完成；仅使用 SSH `/login` 设备码授权，实测不能保留到下一次连接。

默认 `loginAccess: "auto"`：SSH 环境或没有 DISPLAY/WAYLAND_DISPLAY 的 Linux 使用 Cloudflare 临时 HTTPS 登录页，其他环境使用本机页面。可通过登录方式选择远程或本机入口，也可设置 `loginAccess: "local"` 或 `"cloudflare"`。

Cloudflare 远程入口无需账号、域名或 root。插件优先使用已有 `cloudflared`，缺少时从官方发行页下载固定 **2026.10.0**，校验大小及 SHA-256 后缓存到 `stateDir/runtime/`。自动下载支持 Linux/macOS x64、arm64 及 Windows x64；macOS 解压需要 `tar`。可设置 `cloudflaredPath` 指定客户端，或用 `autoInstallCloudflared: false` 禁止自动下载。

临时地址形如 `https://随机名称.trycloudflare.com/ssh-key/…`，可在自己的电脑浏览器中打开。首次 DNS 生效可能需要稍等；登录成功、失败、取消或十分钟超时后关闭页面及通道。入口仅提供本次公钥页面，私钥保留在服务器。也可以从登录说明或终端复制完整公钥，直接到 HF 的 SSH Keys 页面添加。

Magpie 会准备运行时和依赖，无需额外安装 Python、OpenSSH 或 Node.js，也无需手动启动服务。运行机器需能访问 `chat.hf.co:22` 和 [HF 模型目录](https://router.huggingface.co/v1/models)。远程入口还需要访问 GitHub 发行文件及 Cloudflare。临时隧道仅转发登录页，SSH 连接不经过 Cloudflare 或 Magpie 的 HTTP 代理。

可通过插件选项强制使用远程登录，已有其他选项时请一并保留：

```sh
magpie plugin options github:mu-zi-lee/magpie-ssh-chat-hf-co '{"loginAccess":"cloudflare"}'
```

## 供其他客户端使用

独立服务需要 Bun 或 Node.js 20+。以 Bun 为例：

```sh
git clone https://github.com/mu-zi-lee/magpie-ssh-chat-hf-co.git
cd magpie-ssh-chat-hf-co
bun install --frozen-lockfile --ignore-scripts
bun scripts/login.mjs  # 打开输出的登录页，复制公钥并到 HF 添加
bun scripts/serve.mjs
```

可用 `bun scripts/login.mjs --cloudflare` 强制远程登录，或用 `--local` 强制本机页面。

服务默认仅监听本机 `127.0.0.1:5695`，可用环境变量 `MAGPIE_HF_PORT` 修改端口。客户端填写：

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:5695/v1` |
| API Key | `hf-ssh`（占位值，本地服务不校验） |
| Model | `Qwen/Qwen3.8-27B` |

发送一次对话：

```sh
curl http://127.0.0.1:5695/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen3.8-27B","messages":[{"role":"user","content":"你好"}]}'
```

支持文本 `messages`、`tools`、`tool_choice`、`parallel_tool_calls` 和 `stream: true`。`GET /v1/models` 返回 HF 公开目录，`ssh_available: true` 表示插件支持该模型，仍需有效登录；其他模型返回 `400 model_not_supported`。目录中的价格、上下文长度和工具能力来自 HTTP 供应商，不代表 SSH 通道能力。

## 使用前须知

- **工具调用通过提示词实现。** 插件校验模型生成的 JSON，再返回标准 `tool_calls`，工具由客户端执行。
- **SSE 为缓冲输出。** 等待期间发送心跳，完整回复校验后输出，不会逐 token 推送。
- **上下文较小。** 完整提示词最多 8000 字符，包含历史、工具定义和协议指令；回复 JSON 最多 4000 字符。长对话需压缩历史，大文件需分步处理。
- **接口兼容范围有限。** 仅支持文本；`max_tokens` / `max_completion_tokens` 是软目标，采样参数不生效；`stop`、`response_format`、logprobs 和旧版 functions 协议不支持。
- **请求串行执行。** 默认最多容纳 8 个请求；队列满时返回 `503 ssh_queue_full`。开始发送后不会自动重试。
- **上游终端界面可能变化。** 格式错误或截断会导致失败。未登录返回 `hf_login_required`；余额不足返回 `hf_insufficient_credits`（非流式 HTTP 402，流式为错误事件），不会继续等待到超时。

对话、系统提示词、工具定义和工具结果都会发送给 `chat.hf.co`。插件生成专用 SSH 密钥，不读取个人 SSH 密钥或配置；公钥关联 HF，私钥由 Magpie 保存在其凭证存储中，独立服务则保存在 `.local/ssh/auth.json`。不要提交或分享凭证文件。首次连接保存服务器指纹，之后拒绝指纹变化。

## 开发

```sh
bun install --frozen-lockfile --ignore-scripts
bun test  # 离线测试，不请求 HF
```

架构、验证记录和后续计划见 [协议文档](docs/PROTOCOL.md)。问题反馈请提交 [Issue](https://github.com/mu-zi-lee/magpie-ssh-chat-hf-co/issues)。

非官方社区插件，采用 [MIT License](LICENSE)。
