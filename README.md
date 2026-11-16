# dsh-qwenwork-connect

将千问办公（QwenWork）接入 DeepSeek Harness（DSH）的模型 Provider 插件。

本插件直连千问办公官方模型网关，同时支持**国内版（.cn）**与**国际版（.ai）**两个站点，原生支持 **工具调用（Tool Calls）**、**图片输入**、**多轮上下文** 与 **实时用量统计**。

| 站点 | 网关 | provider id | 模型选择器分组 |
| --- | --- | --- | --- |
| 国内版 `.cn` | `gateway.qwenwork.cn` | `qwenwork` | QwenWork |
| 国际版 `.ai` | `gateway.qwenwork.ai` | `qwenwork-intl` | QwenWork Global |

> **开源声明**：本项目基于 `gaoqiaoliangjie666/dsh-qwen-connect`、`xiao-hans/dsh-qwen-connect` 与 `REALOIYO/dsh-qwenwork-connector` 二次开发，非官方项目，与千问办公官方无关。上游版权声明完整保留在 `LICENSE` 与 `THIRD-PARTY-NOTICES.md` 中；原作者如认为本仓库的二次分发不妥，请提 Issue 联系下架。详见文末[二次开源与致谢](#二次开源与致谢)。

## 核心特性

- **双站点**：国内版（`qwenwork.cn`）与国际版（`qwenwork.ai`）**同时可用**，两站各自独立登录、独立模型目录、独立积分，互不干扰。账号不互通，因此凭据分文件存放。
- **模型开关**：设置卡片里每个模型都有启用/停用开关，停用即从模型选择器消失；按站点分别记忆，拨动**不重启插件**（进行中的对话不受影响）。
- **原生网关能力**：直连官方桌面端接口，完整透传 `tools` 与 `image_url`，Agent 循环与上下文管理完全交由 DSH 控制。
- **零外部二进制依赖**：在 `lib/cosy.js` 中基于 `node:crypto` 纯手写实现 COSY 信封签名与请求编码，无需额外引入 WASM 组件或 Windows DPAPI。
- **双端丝滑登录**：支持在 DSH 插件面板一键网页授权，也支持无头环境下的 CLI 命令行登录，Token 到期自动无感刷新。
- **实时模型与倍率同步**：自动拉取官方模型目录，在选择器中直观显示 `x1.00` / `x0.10` 等实时扣费倍率。

---

## 快速开始

### 1. 安装

```bash
dsh plugin --profile web add dsh-qwenwork-connect
```

安装后重启 DSH，模型选择器中即可看到 `qwenwork` 分组下的模型。

### 2. 登录授权

首次使用需要获取账号凭据，提供 **界面登录** 和 **命令行登录** 两种方式。两个站点**分别登录**：卡片顶部的「国内版 .cn / 国际版 .ai」切换器决定你正在给哪个站点登录。

**方式 A：DSH 界面登录（推荐）**

1. 打开 DSH 左侧「插件」→ 找到 `dsh-qwenwork-connect` 配置卡片，点击 **「登录」**。
2. 浏览器会打开千问办公授权页（卡片会每 2 秒自动轮询登录状态）。
3. **选对团队**：先选账号，再选**有企业套餐的团队**（无可用席位的组织会提示“组织暂无可用席位”）。如果选成个人团队不会报错，但会直接扣个人额度。
4. 授权确认后，卡片会自动刷新当前账号与剩余积分。

**方式 B：CLI 命令行登录（适合无桌面/远程环境）**

```bash
npx dsh-qwenwork-connect login
```

用已登录千问办公的浏览器打开终端打印的授权链接，完成账号与团队选择后，凭据会自动写入该站点的凭据文件（权限 `600`）：

```bash
npx dsh-qwenwork-connect login                  # 国内版 .cn → ~/.dsh/qwenwork-desktop.json
npx dsh-qwenwork-connect login --site intl      # 国际版 .ai → ~/.dsh/qwenwork-global.json
```

**退出登录**

* **界面操作**：在插件配置卡片的账号行右侧点击「退出登录」。
* **命令行操作**：

```bash
npx dsh-qwenwork-connect logout                 # 只退出国内版
npx dsh-qwenwork-connect logout --site intl     # 只退出国际版
```

*(注：退出登录只清理**该站点**的凭据文件，会保留设备标识 `~/.dsh/qwenwork-machine-id`，下次重登不会触发更换设备。)*

### 3. 模型选择与省流建议

* **日常建议切 `flash`**：插件默认选中 `pro` 模型，但日常任务强烈建议切换到 `flash`，两者积分消耗相差 **10 倍**（选择器中的 `x1.00` / `x0.10` 即为当前消耗倍率）。
* **国际版模型 key 不同**：国际版用 `qwork-auto`（Standard｜Qwen3.8-Flash）/ `qwork-advanced`（Pro）/ `qwork-ultimate`（Flagship），不是 .cn 的 `flash` / `pro`。两站的 key 不通用，插件已按站点各存一份目录，无需手动切换。
* **固定 1M 上下文**：请求固定按 1M 上下文声明，不设档位切换（官方模型均为 1M，且实测计费不按上下文长度分档）。
* **目录自动刷新**：模型列表、视觉支持与费率每 5 分钟从网关（`/algo/api/v2/model/list`）同步一次；首次拉取成功前使用内置默认目录兜底。

---

## 启用 / 停用模型

设置卡片（设置 → 插件 → 千问办公）展开后，「可选模型」区每行右侧有一个开关：

- **停用**后该模型从模型选择器消失；卡片仍会列出它（灰显），随时可再启用。
- 开关按站点独立记忆（先切到「国际版 .ai」再拨动，只影响国际版）。
- 每个站点**至少保留一个**可用模型，最后一个不允许关闭（服务端同样强制）。
- 停用不影响进行中的会话：若旧会话仍选中该模型，请求会得到明确提示而不是静默失败。
- 偏好持久化在 profile 配置的 `disabledModels` 字段（形如 `{ cn: [flash], intl: [qwork-ultimate] }`），可直接手改；新上架的模型默认可用，无需迁移。拨动开关**不会重启插件**（DSH volatile 配置），登录态与进行中的对话不受影响。

## 二次开源与致谢

本项目为社区二次开源作品，非千问办公官方实现。

**上游演进与致谢：**

* [`gaoqiaoliangjie666/dsh-qwen-connect`](https://github.com/gaoqiaoliangjie666/dsh-qwen-connect)：完成了原始架构设计、协议逆向与回环 shim。
* [`xiao-hans/dsh-qwen-connect`](https://github.com/xiao-hans/dsh-qwen-connect)：后续接力维护，补齐了企业 VPC 支持与 DSH 0.2.x 兼容性。
* [`REALOIYO/dsh-qwenwork-connector`](https://github.com/REALOIYO/dsh-qwenwork-connector)：提供了 Device Flow 登录流程与 Provider 基础结构。
* **本仓库改动**：重写了凭据存储层（改为纯文件优先，彻底移除 Windows DPAPI 依赖），并将原本的 WASM 签名组件替换为纯手写的 JavaScript COSY 信封实现。

感谢所有原作者与上游贡献者的付出！如果本项目对你有帮助，请优先前往上游仓库点 Star。

**版权与下架说明：**
上游项目的版权声明均已逐字保留：`LICENSE` 包含 `gaoqiaoliangjie666`、`xiao-hans` 与本仓库的版权行；`THIRD-PARTY-NOTICES.md` 收录了 `dsh-qwenwork-connector`、`dsh-magpie-connect`、`magpie` 与 `@magpie-community/opencode-qoder-auth` 的完整 MIT 协议文本。本仓库新增代码同样以 MIT 发布。

虽然上游均为 MIT 许可且本项目已按要求保留声明，但如果任何原作者认为本仓库的二次分发不妥，请直接在本仓库提交 Issue 说明，我们核实后会立即移除相关代码或归档删除整个仓库。

## License

MIT
