# 普通分组改为共用 AI 节点

> 2026-11-06 后续决定：用户明确选择全部使用兼容入口并接受 AI 出口可能变化。现有十六条节点均已由 `/proxyip-only=` 改为 `/proxyip=`，线上订阅和本机已同步。独立 AI fallback 保留。下文严格路径为历史记录；当前结果见[全部兼容入口记录](all-compatible-2026-11-06.md)。

按用户最新要求，2026-11-05 15:42:34 UTC 完成 Cloudflare worker 订阅发布，15:43:25 UTC 核验本机订阅刷新结果：

- 原十条普通节点（新加坡五条、洛杉矶五条）从私有 `ADD.txt` 移除；原名单已在同一私有 KV 备份七天并逐字节回读核对。
- 保留原十六条 `洛杉矶NN · AI` 严格节点，传输、凭据、回源路径和名称均保持原样，名称不显示 IP。
- 普通故障转移、负载均衡、自动选择均完整共用这十六条节点；Claude、ChatGPT 继续各自独立 fallback，AI 规则、DNS 和 UDP/443 REJECT 不变。
- 普通组改用 HTTPS Cloudflare 204 探活；所有严格节点都经过真实 HEAD 204 验证，此请求不会被 Worker 本地合成。两个 AI 组继续使用各自 API 探活。

托管策略通过 [PR #71](https://github.com/sssstwee/xiaomao-ai-proxy/pull/71) 合并，主分支提交 `9050fbf3200ad3b362aa473bfd9afb167b7818c4`。仅修改三份已有策略、测试和说明文件；没有部署 Worker 或构建客户端。公开源、转换器缓存和真实鉴权订阅均已核对。真实订阅仅在内存和子进程 stdin 中处理。

实际完整订阅包含十六条节点，五个节点组成员完全一致，Mihomo 完整配置校验通过。发布后在隔离核心中再次逐节点验证：Cloudflare HEAD 204、Anthropic HEAD 401/405、OpenAI HEAD 401 对应 URL 的健康状态均为 16/16；这些结果不代表账号登录、模型调用或普通网站完整兼容。Python 策略测试 11/11、本仓库 Node 回归 66/66 通过。

操作时用户当前启用的是 Voyra；本次只刷新 Cloudflare worker 的已保存订阅。已核验 Voyra 的运行配置字节未变、默认仍为负载均衡、rule 模式和 TUN 开启。共享普通探活地址也单独验证了当前六条 Voyra 节点均返回 HEAD 204，Voyra 组成员不变。

严格节点此前访问 Google、YouTube 和部分公共资源有 TLS 失败，共用节点并未修复这些限制，也不承诺持续不超过 250ms。本次用户新决定取代此前普通池 5＋5 和双池隔离要求。旧维护脚本的普通池数量保护仍会阻止其发布，未安装或启动定时任务。

证据：

- `tmp/shared-ai-head-preflight-2026-11-05.json`：十六条严格节点和六条 Voyra 节点的真实 HEAD 204。
- `tmp/shared-ai-preflight-verification-2026-11-05.json`：发布前完整配置与 48 项 URL 专属健康检查。
- `tmp/shared-ai-publication-2026-11-05.json`：私有名单、缓存备份和发布回读核验。
- `tmp/shared-ai-published-verification-2026-11-05.json`：真实发布订阅及发布后的 48 项检查。
- `tmp/shared-ai-client-verification-2026-11-05.json`：本机订阅成员及当前 Voyra 配置保持原样的核验。

回滚时先恢复策略，再使用私有报告中的原名单备份键恢复并回读核对；严格 Worker 无须回退。报告不含订阅 URL、凭据或真实节点身份。
