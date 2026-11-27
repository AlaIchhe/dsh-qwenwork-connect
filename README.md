# dsh-qwenwork-connect

将千问办公（QwenWork）以**原生 DSH `LlmAdapter`** 方式接入 DeepSeek Harness（DSH）的模型提供方插件。

同时支持**国内版（`.cn`）**与**国际版（`.ai`）**两个站点，原生支持 **工具调用（Tool Calls）**、**图片输入（含自动卸载预算）**、**多轮上下文**、**实时用量统计** 与 **双站点独立模型开关**。

| 站点 | 网关 | provider id | 模型选择器分组 |
| --- | --- | --- | --- |
| 国内版 `.cn` | `gateway.qwenwork.cn` | `qwenwork` | QwenWork |
| 国际版 `.ai` | `gateway.qwenwork.ai` | `qwenwork-intl` | QwenWork Global |

> **开源声明**：本项目基于 `gaoqiaoliangjie666/dsh-qwen-connect`、`xiao-hans/dsh-qwen-connect` 与 `REALOIYO/dsh-qwenwork-connector` 二次开发，非官方项目，与千问办公官方无关。上游版权声明完整保留在 `LICENSE` 与 `THIRD-PARTY-NOTICES.md` 中；原作者如认为本仓库的二次分发不妥，请提 Issue 联系下架。

---

## v1.0.0 架构亮点

- **原生 `LlmAdapter`，彻底移除本地 HTTP 回环代理与 `pi-ai` 中间层**：直接将 DSH `GenerateOptions` 编码并 COSY 签名直连官方网关，将上游 SSE 直接转换为 DSH 原生 `StreamChunk` 与结构化 `LlmError`（保留 `providerRetryAfterMs`、`IMAGE_OFFLOAD_REQUIRED` 等语义）。
- **零外部二进制依赖**：基于 `node:crypto` 纯手写 COSY 信封签名与请求体编码，彻底移除历史遗留的 Windows DPAPI / 桌面客户端探测代码。
- **DSH 原生凭据存储 + 单飞并发刷新**：优先写入 `ctx.credentials`（`modifyRecord` 跨进程锁保护轮换 `refresh_token`），同时兼容无头 CLI 写入的本机文件凭据。
- **按站点隔离运行时（`SiteRuntime`）**：国内版与国际版各自独立管理凭据、目录缓存、积分水位基准、性能采样与可取消的 Device Flow 轮询，互不串扰。
- **TypeScript + 模块化 TSX 前端**：前后端共享唯一站点与路由契约，零重复常量；卡片与输入框积分读数共享客户端轮询存储。

---

## 快速开始

### 1. 安装

```bash
dsh plugin --profile web add dsh-qwenwork-connect
```

### 2. 登录授权

两个站点账号不互通，各自独立登录：

**方式 A：DSH 界面登录（推荐）**

1. 打开 DSH 左侧「插件」→ 找到 `dsh-qwenwork-connect` 配置卡片，选择「国内版 .cn」或「国际版 .ai」，点击 **「登录」**。
2. 浏览器会打开千问办公授权页，选择账号及对应的企业/个人团队完成授权。
3. 授权完成后卡片自动刷新账号与剩余积分。

**方式 B：CLI 命令行登录（无头/远程环境）**

```bash
npx dsh-qwenwork-connect login                  # 国内版 .cn
npx dsh-qwenwork-connect login --site intl      # 国际版 .ai
npx dsh-qwenwork-connect status                 # 查看当前账号与剩余积分
npx dsh-qwenwork-connect logout                 # 退出国内版
npx dsh-qwenwork-connect logout --site intl     # 退出国际版
```

---

## 插件配置（`cordis.patch.yml`）

大部分配置项均为 DSH `volatile` 字段，修改后**热更新生效、不重启插件**：

```yaml
- id: llm-qwenwork
  name: dsh-qwenwork-connect
  config:
    enabledSites: [cn, intl]
    disabledModels:
      cn: []
      intl: []
    trustedHosts: []          # 反向代理访问 DSH 时额外放行的 Host 域名
    timeouts:
      headerMs: 180000        # 响应头等待上限（毫秒）
      firstContentMs: 90000   # 200 后首帧等待上限（毫秒）
      idleMs: 300000          # 流内空闲看门狗（毫秒）
    vpc:
      caCertPath: ""          # 企业 VPC 自签根证书路径（推荐）
      insecureTls: false      # 仅在无法提供 CA 证书时显式开启
    stallGuard:
      enabled: true           # 「只说不做」自动续跑守卫开关
      maxContinues: 2         # 单轮最大自动续跑次数
    debugTrace:
      enabled: false          # 请求级异步 JSONL 诊断日志（默认关闭）
      logPath: ""             # 默认写入 ~/.dsh/logs/qwenwork-trace.log
```

---

## 本地开发与验证

```bash
npm install
npm run check   # 等价于 tsc --noEmit && node scripts/build.mjs && node --test tests/*.test.mjs
```

---

## 已知限制

- **`qwen4-max` 无前缀缓存命中**：上游网关将 `qwen4-max` 路由至 `qwork-claude-chat-mode-pool` 时，网关返回的 `cached_tokens` 恒为 `0`。插件如实透传上游返回的 `usage`。
- **上游强制开启思考**：千问办公网关对所有思考开关参数均忽略并强制返回 `reasoning_content`，因此本插件不向 DSH 声明虚假的推理档位选项。

## License

MIT
