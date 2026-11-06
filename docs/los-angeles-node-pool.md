# 洛杉矶节点池与 AI 分流

2026-11-06 最新用户决定：全部十六条节点改用普通兼容 `/proxyip=` 入口，优先访问兼容性，接受 AI 出口可能变化。线上名单和本机已同步；节点数、名称、凭据、回源地址以及 Claude / ChatGPT 两个独立 fallback 保留。Google、YouTube 首页逐节点 16/16 成功。本机普通组保留 Google HTTPS 204 探活。兼容路径不再保证所有目标固定洛杉矶回源。详情见 [全部兼容入口记录](all-compatible-2026-11-06.md)。

旧的严格洛杉矶维护脚本与当前模式不兼容，不得直接用于发布；本次没有安装或启用定时维护。以下为历史配置。

## 历史：2026-11-05 共享严格节点

2026-11-05 最新用户决定：删除原十条普通节点，普通故障转移、负载均衡和自动选择共用现有十六条严格 AI 节点。两个 AI 专用 fallback 仍独立；名称保留城市序号，不显示 IP。普通组三个探活改用真实 HTTPS Cloudflare 204，两个 AI 组继续分别探测对应 API。Google / YouTube 及公共资源的已知严格路径兼容性限制仍存在。本段取代下文的普通池 5＋5 配额和双池要求；下文保留为历史。旧维护发布脚本要求普通池至少十条，目前会停止发布，应先按新模式调整再使用；没有安装或启用定时维护。

## 历史双池方案

AI 分流继续由 `sssstwee/xiaomao-ai-proxy` 的 `backend/edgetunnel-subscription/clash-base.yaml` 统一维护。Claude、ChatGPT 保留各自独立的严格洛杉矶 fallback；普通流量使用兼容路径，仍可选择负载均衡。通用 AI、Artifacts 字体/脚本和公共 CDN/遥测依赖及其 DNS 使用普通“故障转移”。`docs/hosted-ai-routing.patch` 是修复前的历史补丁，不应重新应用。

2026-11-05 实测发现，严格回源能访问两个 API 的认证层，却通常拒绝 Google、YouTube、Google 字体和部分公共 CDN 的 TLS 握手。因此名单必须同时发布两套节点：`洛杉矶NN · AI` 使用 `/proxyip-only=`，`新加坡NN · 普通` / `洛杉矶NN · 普通` 使用 `/proxyip=`。默认各十六条，共三十二条；普通与 AI 独立选点，不能把节点条数当作独立出口数量。普通组排除严格 AI 节点，两个 AI 组排除普通节点；普通路径不承诺所有目的地固定同一城市。严格核心 DNS 仅使用已测试可达的 Cloudflare DoH。

普通池按用户要求优先新加坡和洛杉矶、排除香港。用户随后要求普通池至少十条，洛杉矶、新加坡各至少五条，并将单次测速门槛调整为 ≤250ms、接受后续波动。发布同时检查每个地区的数量，不能再仅按旧 200ms 条件把名单裁成两条。原两条名单及八加八组合均为历史筛选结果。2026-11-05 从 65 个候选中筛出 64 个通过项，按三次真实 HTTPS Cloudflare trace 首字节耗时的中位数，各选两个地区中较快的八个，再按延迟升序排列。普通组自动探活使用支持 HEAD 的 Google generate_204 地址，预期 204，并核对对应 URL 的 extra.alive；trace 仅用 GET 核验地区。Google/YouTube 首页另行验证。额外通过非 Cloudflare 的 AWS 公网回显检查出口，拒绝香港或未知国家；本次样本为美国。trace/回源地区不代表非 Cloudflare 目标的固定出口。维护脚本保留已选普通名单，不将其重新替换成 AI 回源的复制品；发布要求每地至少五条已验证普通节点，不足时停止发布；普通节点需要重新排序时应重新完成地区及延迟筛选。

## 严格回源

`/proxyip-only=IPv4:port?ed=2560` 固定一个回源地址。连接失败或重拨时不拨业务目标、不使用默认反代、不展开 DNS/TXT 回源池。严格路径拒绝 UDP，包括 DNS/53；不会对测速站点本地合成成功响应。非法严格路径直接拒绝，不能落回普通路由。

普通 `/proxyip=` 继续保留旧行为。当前发布工具仅维护已验证的 VLESS over WebSocket 节点。带其他后缀、额外查询参数或混合选择器的严格路径不在支持范围。

本地名单且 `random=false` 时，缺失或空白 `ADD.txt` 返回 503，不会生成随机地区节点。

## 筛选和复验

`tools/maintain-la-nodes.mjs` 复用 Mihomo、Wrangler、GeoLite2 和现有内置转换器，无新增 NPM 依赖。公开源的 LAX 标签只作为候选线索，不能作为实际出口证明。

准入要求：

- 回源 IPv4 不同，离线城市库标记为 US / Los Angeles。
- 经该节点访问 Cloudflare trace，返回的实际公网出口也标记为 US / Los Angeles。
- Anthropic API 返回 401 且 JSON 错误类型为 `authentication_error`；OpenAI API 返回 401 且类型为 `invalid_request_error`。
- 对应普通路径必须实际打开 Google 和 YouTube 首页，检查 HTTP 200 和页面标题，不能以本地合成 204 代替。
- 严格路径测试通过后才可发布，至少十个不同回源，默认发布十六个。保留既有健康节点的先后顺序，并记录独立公网出口数量。

探测使用独立 Mihomo 进程，每个 HTTP 入站固定一个节点，配置只经 stdin 传入；不启用探测进程的 TUN，也不改主内核或关闭现有连接。四个候选并发，每个检查有超时。UUID、Host、SNI 只在内存中按 Worker 最终响应物化，KV 仍保存原占位模板。报告只保存公开 IP、城市、状态和时间。

只复验、不写线上名单：

```bash
node tools/maintain-la-nodes.mjs --database tmp/la-maintenance/GeoLite2-City.mmdb --refresh-database --report tmp/la-maintenance/latest.json
```

复验通过后更新私有名单：

```bash
node tools/maintain-la-nodes.mjs --database tmp/la-maintenance/GeoLite2-City.mmdb --refresh-database --publish --target 16 --report tmp/la-maintenance/latest.json
```

`--legacy-probe` 仅用于部署前诊断，不能与 `--publish` 合用。城市库不足一天不重复下载；更新失败可暂用七天以内的现有库，超过期限则停止。下载内容有大小限制，并经本地 MMDB 查询验证后才替换。

发布前重新读取名单，若探测期间被其他人改动则停止。更改前在同一私有 KV 保存七天有效的 `ADD.txt.la-backup.<时间戳>`，回读确认备份后才写入新名单，并再次回读核对；写入或回读失败时恢复原值并核对恢复结果。Wrangler 读取使用原始字节输出，避免 `--text` 日志附加换行影响比较。备份键和发布阶段提前记入不含凭据的报告；后续实际订阅验收失败仍需根据该备份显式回滚。名单未变时不重复写入。不足十个合格节点时返回非零、记录缺口并保留原名单，不跨地区补足。

## 定期维护

`docs/la-pool.launchd.plist.example` 提供每 30 分钟复验一次、目标十六个节点的 macOS LaunchAgent 模板，需将 `@NODE@`、`@NODE_DIR@`、`@ROOT@` 替换成安装路径后另行安装。模板文件本身不会启用定时任务。

定期维护要求本机在线、Node/Mihomo/mmdblookup 可用、Wrangler 登录有效。报告和日志位于被 Git 忽略的 `tmp/la-maintenance/`。若本机休眠、退出登录、凭据过期或候选池不足，维护不能保证按时完成。维护更新的是服务器订阅；客户端仍需刷新订阅才取得补充节点。

## 验证范围

401 仅证明 HTTPS 到达服务的认证层，不代表账号登录、模型调用、Claude Code/Codex 完整业务或语音验收。GeoLite2 城市记录有误差；同城不等于同一 IP。fallback 在健康状态变化时仍可换 IP，已有长连接不会自动迁移。单次验收和定期复验都不能承诺未来每一刻至少十个节点在线，也不能承诺避免账号风控。

公开模板可单独检查：

```bash
node tools/check-ai-routing.mjs /path/to/clash-base.yaml
```

检查覆盖八类 AI 规则、六类 DNS 策略与组引用图；AI 路径不能到达负载均衡，三个相关组必须为 fallback。
