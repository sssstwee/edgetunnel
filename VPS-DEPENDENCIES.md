# CF 主订阅与 Voyra 的依赖

## 当前链路

CF 主订阅：客户端 → EdgeTunnel Worker → Cloudflare 私有转换 Worker → 自有 GitHub 托管模板 / 资源。节点配置来自原 Cloudflare KV，模板最后可用快照保存在转换服务的专用 KV。没有新的 VPS 或固定费用服务。

CF 代理数据：客户端 → Cloudflare Worker → 目标 / 原有 ProxyIP 回源。现有十个 ProxyIP 与 Voyra 地址不同，没有配置 Voyra SOCKS5 链式出口。第三方回源的可用性和地理位置仍会影响访问；Clash 的 AI fallback 只保证探活与回退顺序，不能使出口 IP 永久固定。

| 服务 | CF 主订阅是否依赖 Voyra VPS | 维护位置 |
| --- | --- | --- |
| 节点列表、订阅鉴权 | 否 | 原 Worker 与 Cloudflare KV，订阅 URL 保留 |
| Clash / Mihomo 转换与托管模板合并 | 否 | 独立的 `native-converter/` Worker，`@subconverter/core` 0.4.0（GPL-3.0） |
| 模板缓存与故障回退 | 否 | Cloudflare KV，300 秒检查，保留最后可用版本 |
| Claude / ChatGPT 分组、分流与 DNS | 否 | `sssstwee/xiaomao-ai-proxy` 的统一模板 |
| 规则集、图标、Voice JSON、CIDR、Geo 数据 | 否 | 本仓库 `resources/` 与 Releases，GitHub Actions 每日同步 |
| 套餐用量面板 | 否 | Cloudflare Analytics / Billing API |
| 原 CF 静态配置 / 用量辅助 Worker | 否 | Cloudflare / GitHub；当前配置没有引用旧静态规则模板 |
| 旧登录兼容接口 | 不在当前 CF 订阅链路内 | 原 Cloudflare Worker / D1 / KV；旧 VPS 推送任务不参与当前 CF 下发 |
| Voyra 订阅与两个镜像入口 | 是，按用户选择暂时保留 | 原 VPS 与 `voyra-sub` / `voyra-sub-mirror` |
| Voyra 原生 Xray / AnyTLS / HY2 / WARP 节点 | 是，按用户选择暂时保留 | 原 VPS；Workers 的节点格式转换不等于托管这些协议的服务器 |

## 切换与回退

SUBAPI 填写当前 Worker 自身的 HTTPS 域名，SUBCONFIG 沿用自有 `acl4ssr.ini`。内置转换与公开的任意 URL 转换服务分离：用户仍需原订阅凭据才能获取节点，没有新增匿名转换接口。

部署时保留现有变量、密钥、KV、CPU 限制和域名。后台设置先安全备份，只改变 SUBAPI；原节点和其顺序、组测速、探活状态码、传输参数与订阅链接保持原值。回退时恢复先前私有 SUBAPI，原 VPS 转换服务可继续工作。勿将私密后端路径和订阅链接写入仓库。

验证包括：Node 单元测试、真实十节点生成前后逐字段对比、Mihomo 校验、线上订阅下载，以及暂时停止 VPS 转换服务时重新下载 CF 订阅。Voyra 原始订阅和节点服务在验证期间保留。

后续停用 VPS 时再切换旧 Voyra 入口；当前迁移不更改该入口返回的节点。客户端需更新一次 CF 订阅取得新的输出，此后仍按客户端自己的订阅 / 规则更新周期获取配置。
