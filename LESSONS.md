# 教训日志（LESSONS）

<!-- APPEND-ONLY LOG: 新条目插入到此行之后 -->

## LES-008 · 离屏渲染 harness 里 jsx 的第三参数是 key 不是 children
- 日期：2026-11-17
- 现象：卡片断言「国际版余额/退出按钮」FAIL，但 DOM 里其实渲染了文本
  `site-cn`——组件的 React key 被当成 children 打印了出来。
- 根因：测试 harness 把 `jsx(type, props, key)` 直接映射成
  `React.createElement(type, props, key)`；`createElement` 第三参数是
  children，不是 key。
- 教训：桥接自动 JSX 运行时时必须
  `createElement(type, {...props, key})`；断言 FAIL 先看渲染产物再怀疑
  被测代码。这是 harness 缺陷，不是插件缺陷。

## LES-007 · 卡片离线渲染检查需要 renderConfig 转发 initialState
- 日期：2026-11-17
- 现象：给 `QwenWorkPluginCard` 传 `initialState` 后卡片仍显示「加载中」，
  SSR 分支验证不到「已登录」UI。
- 根因：插槽 `renderConfig(slotProps)` 收到 props 却没往下转发，卡片里
  `props.initialState ?? null` 永远拿到 null。
- 教训：为离屏检查留的 props 通道必须端到端接通（slot → renderConfig →
  组件），并在注释里写明「仅测试注入，DSH 运行时不传」。

## LES-006 · intl 目录的 max_input_tokens=180000 不是上下文上限
- 日期：2026-11-16
- 现象：国际版 `model/list` 返回 `max_input_tokens: 180000`，若照抄会把
  1M 上下文的模型声明成 180k。
- 根因：同条目 `context_config` 的默认档是 `1M`；`max_input_tokens` 只是
  计费/采样侧字段。与 .cn 策略一致。
- 教训：两个字段并存时以 `context_config` 默认档为准，
  `MAX_INPUT_TOKENS = 1_000_000` 两站共用。

## LES-005 · /wallets 只存在于 .cn 网关，intl 返回 404
- 日期：2026-11-16
- 现象：同一请求在 `gateway.qwenwork.cn` 返回 401 INVALID_TOKEN（有接口），
  在 `gateway.qwenwork.ai` 返回 404（无接口）。
- 教训：积分分池展示必须按站点能力开关（`sites.js` 的 `wallets: true/
  false`），不能把 404 当「未登录」重试；intl 只显示 quota 总池。

## LES-004 · intl 未登录视角 price_factor=0 是占位值不是免费
- 日期：2026-11-16
- 现象：`model/list` 匿名返回的三个 `qwork-*` 模型 `price_factor` 恒为 0。
- 根因：.cn 登录后视角同位置是真实倍率；0 是未配置占位。
- 教训：展示字段区分「已知 0」与「未知」，未知用 null；把占位 0 显示成
  「免费/0x」属于编造事实。

## LES-003 · clientId 与 redirect_uri 必须成对来自同一站点预设
- 日期：2026-11-16
- 现象：在 `gateway.qwenwork.ai/device/selectAccounts` 用 .cn 的
  clientId 或 `qwenwork-cn://` deeplink，返回
  `400 INVALID_DEVICE_FLOW / query not_allowed`；猜参数全军覆没。
- 根因：网关按 (client_id, redirect_uri) 组合校验注册回调。
- 教训：跨站点参数永远成对取自 `sites.js` 预设，禁止混搭；新站点的这两个
  字段先对照官方 app bundle（asar 里 `CONFIGURED_OAUTH_CLIENT_ID`、
  `deeplinkScheme`）核实，再对活网关验证 302。

## LES-002 · .cn token 打 .ai 网关 401 INVALID_TOKEN：账号不互通
- 日期：2026-11-16
- 现象：同一 access token 在 .cn 网关 `account-context`/`quota` 全 200，
  在 .ai 网关全 401 INVALID_TOKEN。
- 教训：两站凭据绝不能共用一个文件；端点解析禁止跨站静默回落（会把
  「站点错配」伪装成「登录过期」，重登也治不好）。

## LES-001 · docs.qwenwork.ai 直连不稳，用 llms.txt 兜底
- 日期：2026-11-16
- 现象：`web_fetch`/curl 对 `docs.qwenwork.ai`、`qwenwork.ai`、
  `registry.npmjs.org` 间歇 `SSL_ERROR_SYSCALL`。
- 教训：文档抓 `https://docs.qwenwork.ai/llms.txt` 索引；npm 元数据走
  registry JSON API + 重试循环；大文件下载（dmg）用 `curl -C -` 断点续传。
