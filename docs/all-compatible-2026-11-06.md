# 全部节点改用兼容入口（2026-11-06）

用户明确选择“全部使用兼容入口，优先访问兼容性，接受 AI 出口可能变化”。这取代此前全部使用严格洛杉矶回源的决定；Claude、ChatGPT 继续各自独立 fallback。

## 故障与修复

十六条严格 `/proxyip-only=` 节点中，Google / YouTube 首页仅洛杉矶03成功，其余返回 TLS 握手失败；Cloudflare 和两家 AI API 认证层均可达。普通组改用 Google 探活只能避开失败节点，不能恢复其普通浏览能力。

同一批回源仅改为既有 `/proxyip=` 路径后，十六条的 Google / YouTube 首页均为 HTTP 200，页面内容匹配。复用了 Worker 已有兼容实现，没有修改或重新部署 Worker。

后续隔离 TLS 对照进一步确认：回源01对 Google SNI 在 TLS 1.2、1.3 下均于 ServerHello 和证书之前返回 fatal handshake_failure（告警40）；同一回源对 OpenAI、Cloudflare SNI 的 TLS 1.3 握手及证书验证成功。回源03的 Google TLS 1.3 也成功。最符合证据的是回源的目标域名接入/转发能力差异；缺少回源日志，不能仅凭告警40断言其内部白名单或“只支持 Cloudflare 站点”。严格实现直接向回源端口写入原始业务数据，没有 SOCKS5 / HTTP CONNECT 的目标协商。

## 发布范围

- 原私有名单先在同一 KV 备份七天，逐字节回读核对后，仅把十六条 URI 的路径选择器从 `proxyip-only` 改为 `proxyip`；写后再次回读，并验证真实鉴权订阅。
- 节点数仍为十六；名称、回源地址、凭据、TLS、SNI、Host、WebSocket 参数均保留。不新增重复入口。
- Claude、ChatGPT 的独立 fallback、原有成员、DNS 及 UDP/443 REJECT 保留。
- 本机已保存订阅与运行配置同步更新，默认仍为负载均衡、rule 模式、TUN 开启。本机三个普通组保留 Google HTTPS 204 探活；线上共享模板的探活地址没有修改。
- Clash Verge 界面重新触发分组测速，十六条均显示延迟；主内核按 Google 探测 URL 的 `extra.alive` 为 16/16。
- 当前主内核的 Google 首页连续六次请求、搜索及 YouTube 首页均成功；两家 API 的连接采样分别命中 Claude / ChatGPT 专用组，样本未见 DIRECT。

提交前本地验证：Node 回归 72/72 通过，Wrangler dry-run 通过。该验证没有再次部署 Worker，也没有改变线上名单。

## 范围说明

兼容路径允许 Worker 选择到业务目标的直连或回源路径，不再保证所有目标固定由指定洛杉矶回源出站。这里的直连发生于 Cloudflare Worker；客户端仍经代理访问。禁止 UDP/443 客户端直连的保护规则保留。

两家 API 的 401 仅证明 TLS/HTTP 到达认证层，不代表账号登录、模型、上传或语音可用。YouTube 仅验证首页，没有测试视频播放。单次测速也不承诺后续延迟。

旧维护脚本面向严格洛杉矶及历史双池模式，不应直接用于当前发布；未安装或启用定时维护。

本地证据位于被忽略的 `tmp/`：`all-compatible-publication-2026-11-06.json`、`all-compatible-client-2026-11-06.json`、`all-compatible-live-health-2026-11-06.json`、`route-compatibility-compatible-2026-11-06.json`。名单备份键仅保存在本地发布报告；不记录订阅地址或节点凭据。

合并前补齐真实 gRPC 服务方法路径：严格入口接受 gRPC 请求的 `/Tun`、`/TunMulti` 后缀，WebSocket / XHTTP 仍拒绝这些额外后缀；新增回归先复现四项失败，修复后完整 72 项通过。该修复仅入库，没有发布到现有 Worker。
