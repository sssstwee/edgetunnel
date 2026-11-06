# 普通与 AI 延迟对比及 HEAD 健康检查修复

用户观察普通组比 AI 组慢。本次直接使用当前 Clash Verge 主内核、统一延迟模式，以相同 URL 和预期状态分别抽测五个 AI 节点、五个洛杉矶普通节点、五个新加坡普通节点，每个地址两轮、并发二。

| 相同测速目标 | AI 中位数 | 洛杉矶普通中位数 | 新加坡普通中位数 |
| --- | ---: | ---: | ---: |
| Anthropic models（HEAD 405，配置允许 401/405） | 305ms | 320ms | 255ms |
| OpenAI models（HEAD 401） | 369ms | 371ms | 508ms |

这批样本中，洛杉矶普通节点与 AI 基本接近；新加坡普通节点存在明显长尾和超时，OpenAI 样本最高约 3840ms。不同时间、地址与小样本不能推出长期稳定速度。检查开始时默认代理为负载均衡，可能轮到慢连接；本次没有改写用户的模式选择。

## 已确认并修复的配置错误

旧普通组三个健康检查使用 `https://www.cloudflare.com/cdn-cgi/trace`，要求 200。实际 GET 返回 200，但 HEAD 返回 404；Mihomo v1.19.33 URLTest 使用 HEAD。其实现即使期待状态不符也可能返回数值 delay，但对应 URL 的 `extra.alive` 为 false、该 URL 的历史记录为零。这解释了“显示有延迟，组内却判失效”的矛盾。

此前只按 API 返回的 delay 统计“探活通过”不充分；旧的 164–236ms 是当时 HTTP 响应耗时，不能作为期望 HTTP 状态已匹配的证据，也不能代表持续访问速度。原 Google / YouTube GET、trace GET 地区核验的证据仍有效。

已通过 [PR #70](https://github.com/sssstwee/xiaomao-ai-proxy/pull/70) 将普通故障转移、负载均衡和自动选择恢复为真正支持 HEAD 的 `https://www.gstatic.com/generate_204`，要求 204。该域名不在 Worker 本地合成 204 的测速名单中。Cloudflare trace 的 GET 继续用于独立地区核验，不再作为自动健康检查。

发布前逐一确认十个普通节点的实际 HEAD 都为 204，并通过主内核 URLTest 后再次核对每个节点该 URL 的 `extra.alive=true`；Python 策略测试 11/11 通过。保留新加坡五条、洛杉矶五条，两个独立 AI fallback 各十六条，以及城市序号显示、DNS 和 UDP/443 REJECT。没有更换节点或修改其凭据/传输，也没有构建客户端包。

2026-11-05 14:47 UTC 已刷新 Clash Verge 的 Cloudflare worker 订阅，回读客户端配置确认三个普通组均采用 gstatic HEAD 204、各含新加坡五条和洛杉矶五条；Claude、ChatGPT 各十六条，默认选择仍为负载均衡，TUN 仍开启。刷新后再逐节点验证，十条对应 URL 的健康状态全部为真；本轮延迟为 165–303ms，其中七条不超过 250ms、三条超过。界面另一次批测也有更高的波动值，因此本次修复只纠正探活判定，不宣称十条持续满足 250ms。

## 证据

- `tmp/group-latency-comparison-2026-11-05.json`：同地址、同主内核的对比样本；trace 样本返回 404，不算成功健康检查。
- `tmp/head-status-check-2026-11-05.json`：HEAD 方法与实际 HTTP 状态。
- `tmp/ordinary-head-204-preflight-2026-11-05.json`：十条普通节点的真实 HEAD 204。
- `tmp/ordinary-head-health-verified-2026-11-05.json`：逐节点 URLTest 与 URL-specific 健康状态。
- `tmp/head-health-cache-publication-2026-11-05.json`：公开托管模板备份及原始字节回读验证。
- `tmp/head-health-actual-subscription-2026-11-05.json`：实际鉴权订阅取得修复后的模板。
- `tmp/head-health-client-config-2026-11-05.json`：刷新后客户端配置、5＋5 配额、AI 独立组、负载均衡及 TUN 状态。

源码核验：[Mihomo v1.19.33 URLTest](https://github.com/MetaCubeX/mihomo/blob/v1.19.33/adapter/adapter.go) 与 [延迟 API](https://github.com/MetaCubeX/mihomo/blob/v1.19.33/hub/route/proxies.go)。本报告不将 API 401/405 当作登录或模型调用验收。
