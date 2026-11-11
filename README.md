# dsh-qwenwork-connect

把千问办公（QwenWork）接进 DeepSeek Harness。走官方的模型网关，所以工具调用、
图片输入、usage 都是通的；这一点和 ACP 会话桥那类方案不一样，后者只能一问一答。

## 和 ACP 方案的区别

|  | ACP 会话桥 | 本插件 |
|---|---|---|
| 上游 | `wss://qwenwork.cn/api/chat-ws` | `gateway.qwenwork.cn` 的 chat/completions |
| 鉴权 | 页面 JWT（`aud=user`） | 桌面端 token（`aud=oauth_app`）+ WASM 签名 |
| 工具调用 | 没有 | `tools` 透传，返回 `tool_calls` |
| 图片 | 没有 | `image_url` |
| 多轮 | 每轮新开会话，单条 32KB 上限 | 标准多轮 |
| 登录 | 抄浏览器 cookie | device flow，不需要桌面客户端 |

## 安装

```bash
dsh plugin --profile web add github:AaIchhe/dsh-qwenwork-connect
```

还没发 npm，所以用 github 源装；出包之后可以直接 `add dsh-qwenwork-connect`。
装完重启 DSH，模型选择器里会多出 `qwenwork` 下三个模型。

## 登录

第一次用需要一份凭据：

```bash
npx dsh-qwenwork-connect login
```

终端会打印一个 `gateway.qwenwork.cn/device/selectAccounts` 的链接。用已经登录
千问办公的浏览器打开，先选账号，再选团队——**要选有企业套餐的团队**。个人
团队也能登进去，只是扣的是个人额度。

确认之后终端显示账号，凭据写到 `~/.dsh/qwenwork-desktop.json`（权限 600）。

插件里也有对应的路由，设置卡片的按钮还没接，先用 CLI：

```
POST /plugins/dsh-qwenwork-connect/login/start
GET  /plugins/dsh-qwenwork-connect/login/status
```

## 三个坑

**machine_id 必须一致。** 签名头里的 `Cosy-MachineId` 要等于登录时用的那个，
插件存在 `~/.dsh/qwenwork-machine-id`。删掉这个文件就等于要重新登录。

**Cosy-User 必须是真实 user_id。** 填占位值网关恒定回
`403 User identity could not be verified`，不会告诉你哪里错了。

**企业团队要手动选。** device flow 页面会列出你所有组织，没席位的标着
"组织暂无可用席位"。选错了不会报错，只是跑到个人额度上。

## 模型与费率

| id | 名称 | 倍率 |
|---|---|---|
| `pro` | 高级 | 1.0 |
| `flash` | 标准（Qwen3.8-Flash） | 0.1 |
| `qwen3.8-max-preview` | Qwen3.8-Max | 1.1 |

默认是 `pro`。日常任务建议切 `flash`，差十倍消耗。

## 凭据与安全

- token 只落在本机 `~/.dsh/qwenwork-desktop.json`，600；
- 状态路由只回账号、套餐、积分摘要，不回 token，也不回 refresh_token；
- 凭据里带 `refresh_token`，快到期时自动换，换完写回同一个文件；
- `research/wasm.bin` 是从官方客户端产物里提取的签名组件，随包分发；想换成
  自己的副本，设 `QWENWORK_WASM_PATH`。

## 已知限制

- 思考链关不掉。网关侧强制思考，`enable_thinking:false`、
  `reasoning_effort:"none"` 这类字段都不生效，只会在输出里多出 reasoning 通道。
- 模型目录是静态的。`/api/v2/model/list` 需要签名，目前没接。
- 设置卡片暂时没有登录按钮，v0.2 补。

## 来源

签名、回环 shim 和 provider 装配来自
[gaoqiaoliangjie666/dsh-qwen-connect](https://github.com/gaoqiaoliangjie666/dsh-qwen-connect)（MIT），
[xiao-hans/dsh-qwen-connect](https://github.com/xiao-hans/dsh-qwen-connect) 接着维护并补了
企业 VPC 与 DSH 0.2.x 兼容。本仓库重写了凭据层（文件优先，不再依赖 Windows
DPAPI），并加入 device flow 登录。原始版权声明见 LICENSE。

## License

MIT
