# 决策日志（DECISIONS）

<!-- APPEND-ONLY LOG: 新条目插入到此行之后 -->
## DEC-012 · 至少保留一个可用模型的守卫放服务端；刷新走 directory.replace
- 日期：2026-11-17
- 背景：把某站点的 provider 清空后，该站点分组在选择器里不可选，用户唯一
  恢复路径是手改 patch.yml——破坏半径远超「一个开关」应有的水平。
- 决策：守卫在 `models-route.js`（409），不依赖卡片自觉；绕过 UI 直接
  POST 同样被拦。写成功后调用 `registerConfigurableProviders` 句柄的
  `replace(同一份条目)` 触发 `llm/adapters-updated`——`emitAdaptersUpdated`
  是 LlmRuntime 私有方法，replace 是插件能公开触达该事件的唯一路径。
- 验证：`toggle-route-test.mjs` 17 项断言（含 409、幂等不写盘、replace 计数）。

## DEC-011 · 数据形状是「停用列表」，不是「启用列表」
- 日期：2026-11-17
- 背景：模型目录 5 分钟从上游刷新一次，会新增/下架模型。
- 决策：Config 里记 `disabledModels: { cn: [...], intl: [...] }`。新模型
  默认可用（启用列表会让它们凭空消失）；下架模型无需迁移（读取时按当前
  目录过滤）；空列表 = 全部启用 = 稳定缺省，老用户 patch.yml 无此字段
  行为完全不变。最后一个 key 移除后整个字段从 patch.yml 消失，只留真正
  生效的差异。

## DEC-010 · 模型开关持久化在插件 Config 的 volatile 字段，不自建文件
- 日期：2026-11-17
- 背景：可选方案是像凭据那样自管一个 JSON 文件；但 DSH 的 configuration.md
  明确：插件配置变更后要经 configEditor 写 profile。
- 决策：`Config.disabledModels` 以 `.volatile()` 声明，写入走
  `ctx.get('configEditor').edit(ctx.fiber.entry, ...)`。收益：写盘与其它
  profile 变更串行化、候选值经 schema 校验、被上层覆盖的字段会被拒绝；
  volatile 语义让切换**不重启插件**（shim 监听、登录态、进行中的对话全部
  原地保留）。读取统一走 `model-preferences.js`，兼容 volatile 引用、
  普通对象与缺省值三种来源。
- 验证：真实 schemastery 3.19 下 `Config['~standard'].validate` 产出
  volatile 引用且 `.get()` 返回原值；e2e 中 updateVolatile 模拟 loader
  提交后 `listModels` 立即反映新状态。


## DEC-009 · 登录状态机按站点独立，退出只作废本站在途轮询
- 日期：2026-11-17
- 背景：两站账号不互通，用户可能在 .cn 授权页未走完时去点国际版的登录。
- 决策：`login-route.js` 用 `Map<siteId, {state, epoch}>` 维护每站点独立的
  登录状态与代际号；`logout` 回调只 `reset(siteId)`，另一站的在途轮询不受
  影响。同站点重复 start 直接复用 pending 的 URL，不重开 device flow。
- 验证：`login-isolation.mjs`——intl pending 时 start cn，intl 状态不变；
  logout intl 后 intl 回 idle、cn 仍 pending。

## DEC-008 · 每站点独立 shim 实例与目录缓存
- 日期：2026-11-17
- 背景：一个 shim 只服务一个站点（模型 key、网关、签名站点参数都不同）。
- 决策：`ensureChatShim({siteId})` 按站点各起一个环回监听（各自端口），
  `createCatalogStore({siteId})` 每站一份缓存；`index.js` 的
  `wireSite(ctx, siteId)` 把目录刷新、shim、provider 注册收敛为一站一套，
  单站装配失败不影响另一站。
- 验证：真实 peer 依赖下 `apply()` 后两站 shim 分别监听
  127.0.0.1:56310 / 56311，`listModels` 各返回本站目录。

## DEC-007 · 设备标识跨站点共享
- 日期：2026-11-17
- 背景：`~/.dsh/qwenwork-machine-id` 标识的是设备，不是账号。
- 决策：两站共用同一 machine id 文件；只有凭据文件按站点分开。

## DEC-006 · 未知站点 id：运行时静默回落 cn，CLI 直接报错
- 日期：2026-11-17
- 背景：前端 URL 带脏参数不应让请求整体失败；但 CLI 打错 `--site` 若静默
  回落会把凭据写进 .cn 文件，污染另一站的登录态。
- 决策：`siteOf()` 对未知 id 回落 `cn`；`bin/login.mjs` 校验失败退出码 1
  并打印可用站点。

## DEC-005 · 端点解析优先凭据自身的 siteId，禁止跨站静默回落
- 日期：2026-11-17
- 背景：实测 .cn 的 token 打 .ai 网关返回 401 INVALID_TOKEN（账号不互通）。
  若端点解析把 intl 凭据静默打到 cn 网关（或反之），故障会被伪装成
  「登录过期」，用户重登也治不好。
- 决策：`resolveGatewayEndpoint(credential, siteId)` 顺序为
  VPC iss origin → 凭据 siteId 的网关 → 缺省网关；凭据 siteId 与请求
  siteId 不一致时以凭据为准。

## DEC-004 · 国际版模型 billingRate 为 null，不显示倍率徽章
- 日期：2026-11-17
- 背景：intl 未登录视角的 `model/list` 返回 `price_factor: 0`，这是占位值
  而不是「免费」。
- 决策：内置目录 `billingRate: null`；`formatRate`/卡片 `ModelRow` 对
  null 渲染空文本（曾会渲染成 `nullx`，一并修复）。

## DEC-003 · 站点用 `?site=` 查询参数传递，cn 省略参数
- 日期：2026-11-17
- 背景：老前端与探针都请求无参数的 `/status`；为它新开一条 intl 专属路由
  会让 URL 约定分裂成两套。
- 决策：`/plugins/dsh-qwenwork-connect/status?site=intl`，cn 不带参数即
  缺省；`status-paths.js` 是 host 与 client 两侧的唯一定义（client 半
  内联同值，因 `__ModuleLoader__` 模块不能 import host）。

## DEC-002 · 凭据按站点分文件存放
- 日期：2026-11-17
- 背景：两站账号体系独立（DEC-005 的实测依据）。共用一个文件会让后登录的
  站点静默覆盖前一个站点的登录态。
- 决策：cn → `~/.dsh/qwenwork-desktop.json`（原文件，老用户无感），
  intl → `~/.dsh/qwenwork-global.json`；环境变量覆盖分别为
  `QWENWORK_CREDENTIAL_FILE` / `QWENWORK_INTL_CREDENTIAL_FILE`；
  凭据 meta 内写 `siteId` 供端点解析回查。

## DEC-001 · 双站点 = 两个并行 provider，而不是一个 provider 切域名
- 日期：2026-11-17
- 背景：需求是给插件接入国际站（qwenwork.ai），协议与 .cn 完全同构但
  网关、client id、deeplink、版本号、模型 key 全部不同，且账号不互通。
- 决策：注册 `qwenwork` + `qwenwork-intl` 两个 provider，各自独立登录、
  目录、凭据、shim；站点差异全部收敛在 `lib/sites.js` 预设表，其余模块
  只读预设，新增第三站点时只需加一行预设 + 一行 provider id。
- 验证：真实 peer 依赖下 `adapter.listModels('qwenwork')` 返回 13 个
  .cn 模型（已登录），`listModels('qwenwork-intl')` 返回 3 个内置目录。
