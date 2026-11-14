# dsh-qwenwork-connect

把千问办公（QwenWork）接进 DeepSeek Harness。走官方的模型网关，所以工具调用、
图片输入、usage 都是通的；这一点和 ACP 会话桥那类方案不一样，后者只能一问一答。

> **二次开源声明**：本项目基于
> [gaoqiaoliangjie666/dsh-qwen-connect](https://github.com/gaoqiaoliangjie666/dsh-qwen-connect)、
> [xiao-hans/dsh-qwen-connect](https://github.com/xiao-hans/dsh-qwen-connect) 与
> [REALOIYO/dsh-qwenwork-connector](https://github.com/REALOIYO/dsh-qwenwork-connector)
> 二次开发，不是官方项目，与千问办公官方无关。上游版权声明保留在
> [LICENSE](LICENSE) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；
> 原作者如认为本仓库的二次分发不妥，可以联系下架。详见下方「二次开源与致谢」。

## 和 ACP 方案的区别

|  | ACP 会话桥 | 本插件 |
|---|---|---|
| 上游 | `wss://qwenwork.cn/api/chat-ws` | `gateway.qwenwork.cn` 的 chat/completions |
| 鉴权 | 页面 JWT（`aud=user`） | 桌面端 token（`aud=oauth_app`）+ COSY 签名 |
| 工具调用 | 没有 | `tools` 透传，返回 `tool_calls` |
| 图片 | 没有 | `image_url` |
| 多轮 | 每轮新开会话，单条 32KB 上限 | 标准多轮 |
| 登录 | 抄浏览器 cookie | device flow，不需要桌面客户端 |

## 安装

```bash
dsh plugin --profile web add dsh-qwenwork-connect
```

装完重启 DSH，模型选择器里会多出 `qwenwork` 下的模型。签名与请求编码在
[lib/cosy.js](./lib/cosy.js) 手写实现，不需要额外的 WASM 组件或 `wasm.bin`。

发布走 GitHub Actions + npm trusted publishing，打 tag 就自动发，不需要 token，
也不需要 2FA：

```bash
npm version patch && git push --follow-tags
```

## 登录

第一次用需要一份凭据：

```bash
npx dsh-qwenwork-connect login
```

终端会打印一个 `gateway.qwenwork.cn/device/selectAccounts` 的链接。用已经登录
千问办公的浏览器打开，先选账号，再选团队——**要选有企业套餐的团队**。个人
团队也能登进去，只是扣的是个人额度。

确认之后终端显示账号，凭据写到 `~/.dsh/qwenwork-desktop.json`（权限 600）。

也可以在左侧「插件」→ `dsh-qwenwork-connect` 的配置卡片里点「登录」：卡片会打开同一个授权页，
并每 2 秒轮询一次结果，成功后自动刷新账号与积分。CLI 仍保留，适合没有浏览器
的环境。两条路由是同一套实现：

```
POST /plugins/dsh-qwenwork-connect/login/start
GET  /plugins/dsh-qwenwork-connect/login/status
POST /plugins/dsh-qwenwork-connect/logout
```

**退出登录**在同一张卡片的账号行右侧点「退出登录」，确认后删除
`~/.dsh/qwenwork-desktop.json`，状态立即回到未登录，可随时重新登录。命令行
等价操作是：

```bash
npx dsh-qwenwork-connect logout
```

退出只删凭据文件，保留 `~/.dsh/qwenwork-machine-id`——设备标识不变，重新登录
不会换设备。三条路由都只接受本机环回请求。

## 三个坑

**machine_id 必须一致。** 签名头里的 `Cosy-MachineId` 要等于登录时用的那个，
插件存在 `~/.dsh/qwenwork-machine-id`。删掉这个文件就等于要重新登录。

**Cosy-User 必须是真实 user_id。** 填占位值网关恒定回
`403 User identity could not be verified`，不会告诉你哪里错了。

**企业团队要手动选。** device flow 页面会列出你所有组织，没席位的标着
"组织暂无可用席位"。选错了不会报错，只是跑到个人额度上。

## 模型与费率

模型目录从网关实时拉取（`/algo/api/v2/model/list`，5 分钟 TTL），费率、视觉
以后端返回为准；选择器里的 `x1.00` / `x0.10` 就是当前倍率。请求固定按 1M
上下文声明，不提供档位切换（官方模型均为 1M；实测计费也不按档位分档）。首次
拉取成功前先显示内置目录，之后每次刷新用新目录覆盖。

默认是 `pro`。日常任务建议切 `flash`，差十倍消耗。

## 凭据与安全

- token 只落在本机 `~/.dsh/qwenwork-desktop.json`，600；
- 状态路由只回账号、套餐、积分摘要，不回 token，也不回 refresh_token；
- 凭据里带 `refresh_token`，快到期时自动换，换完写回同一个文件；
- COSY 信封签名在 [lib/cosy.js](./lib/cosy.js) 手写实现，只依赖 `node:crypto`，
  不需要额外二进制。

## 已知限制

- 思考固定开启，没有档位。网关侧强制思考，请求恒发 `parameters.enable_thinking:true`；
  上游目录的 `thinking_config` 为 `null`，没有声明任何 effort 档位，插件不提供
  开关，UI 也不显示推理等级。`enable_thinking:false`、`reasoning_effort:"none"`
  这类字段上游都不认。
- 单次请求的图片预算按网关实测收紧到 6 MB / 32 张；超出时交给宿主的
  `dsh-compaction-image-offload` 把最旧的图片标成已卸载后重试。宿主没启用
  这个插件时，图片密集的长会话仍会失败。

## 二次开源与致谢

本项目是二次开源作品，不是千问办公官方实现。

代码基础是
[gaoqiaoliangjie666/dsh-qwen-connect](https://github.com/gaoqiaoliangjie666/dsh-qwen-connect)
（原始设计、协议逆向与回环 shim）；
[xiao-hans/dsh-qwen-connect](https://github.com/xiao-hans/dsh-qwen-connect)
接着维护，补了企业 VPC 与 DSH 0.2.x 兼容。device flow 登录与 provider 结构基于
[REALOIYO/dsh-qwenwork-connector](https://github.com/REALOIYO/dsh-qwenwork-connector)。
本仓库在此基础上重写了凭据层（文件优先，不再依赖 Windows DPAPI），
并把 WASM 签名换成了手写 COSY 信封。

上游的版权声明逐字保留：`LICENSE` 保留 gaoqiaoliangjie666、xiao-hans 与本仓库
的版权行；`THIRD-PARTY-NOTICES.md` 收 dsh-qwenwork-connector、dsh-magpie-connect、
magpie 与 @magpie-community/opencode-qoder-auth 的 MIT 全文。本仓库新增代码
同样以 MIT 发布。

感谢原作者与所有上游贡献者。如果这些项目对你有用，请优先给上游点 Star。

**关于下架**：上游均为 MIT 许可，本项目已按许可保留版权声明；但如果你作为原作者
认为本仓库的二次分发不妥，请在本仓库开 Issue 说明，我们确认后会删除相关代码或
整个仓库。

## License

MIT。
