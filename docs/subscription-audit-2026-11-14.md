# 双订阅分流核查与 edgetunnel 集体掉线排查（2026-11-14）

## 方法

- 分流：取 Clash Verge 中两份订阅当前缓存的完整配置，用本机 `verge-mihomo` v1.19.33 起独立实例（无 TUN、独立端口），节点替换为本地 SOCKS 接收端，对约 200 个域名发起 CONNECT，读取内核 `match … using …` 日志。结果是内核真实首条命中，不是自写匹配器。测试 DNS 改为 223.5.5.5，只影响 GEOIP 类规则的解析，不改变域名规则顺序。
- 掉线：Cloudflare GraphQL 读取 Worker `gjtq-vpn-entry` 近 7 天按小时/分钟、colo、状态的调用统计（只读）；从家宽绑定 `en0` 绕过本机 TUN，对 16 个入口 IP 做 TCP/TLS/WebSocket 101/colo 探测（`tools/probe-cf-entries.mjs`）。

## 分流结论

两份订阅的核心 AI 分流正确：Claude / OpenAI / Gemini / Grok / Copilot / Perplexity / Cursor / Meta 等全部走美国组，DeepSeek、Kimi、豆包、通义、元宝、文心、智谱、讯飞、MiniMax、Coze.cn、Trae.cn 等国内 AI 全部 DIRECT，未发现国内 AI 被代理或海外 AI 直连。

| 问题 | 订阅 | 影响 | 处理 |
|---|---|---|---|
| category-ai-!cn 未收录的海外 AI（character.ai、Replicate、Runway、Ideogram、v0、Bolt、Lovable、Genspark、Phind、Together、Fireworks、DeepInfra、Suno、LMArena、You.com、Hailuo 国际版等）及 `m.stripe.network`、`cdn.segment.com` 落入 `MATCH,JMS` | JMS | `JMS Auto` 可能选到日本/荷兰 s4、s5，与“海外 AI 统一美国出口”不符 | 已加入 `jms-ai-shared`，复测全部命中 AI-US；需合并并刷新模板后生效 |
| Sentry、Statsig、Turnstile、Stripe、Intercom、Segment 等共享依赖在 `openai-bootstrap` 内，Claude 页面也会走 `ChatGPT 专用` | edgetunnel | 两个 fallback 成员同序，平时同选 01，仅在两组探活结果不同时出口分离 | 托管模板仓库维护，暂未修改 |
| Google 账号/OAuth/gstatic 走 `默认代理`（url-test），Gemini 本体走 `故障转移` | edgetunnel | 登录与 Gemini 可能不同出口，均为美国 | 同上 |
| `api.moonshot.ai` 国际平台走代理，JMS 为直连 | edgetunnel | 均可用，策略不一致 | 记录 |
| ChatGPT 语音网段 402 条（2026-10-27），JMS 为 540 条（2026-11-12）；全部规则集停在 2026-11-06 | edgetunnel | `Subscription resources` 工作流在 11-07 发布 Geo Release 时失败后被手动停用，`resources/` 不再每日更新 | 需重新启用或手动同步 |
| `klingai.com` 两份都直连（上游 category-ai-cn 收录） | 两者 | 若可灵国际版限制中国 IP 会失败，未实测 | 记录 |

## edgetunnel 集体掉线

### 证据

1. 16 个节点共用一个 Worker、一个 SNI，入口 IP 中 14 个位于 `104.17.128.0/19`。家宽实测：这 14 个全部落在 **SJC**，仅 `103.31.4.1`、`162.159.224.1` 落在 DEN。出口回源已分散到 7 家服务商，入口没有分散。
2. Worker 7 天统计中出现 9,917 次 `loadShed`，其中 9,749 次在 SJC，DEN 仅 91 次（0.6%）。SJC 的 loadShed 请求墙钟时长 p50 126 秒、p99 1,878 秒：被 Cloudflare 中途终止的是已建立的长连接，不是新连接被拒。
3. SJC 每小时稳定被终止 100–230 个连接，与流量大小无关。11-12 白天 05:00–13:00 低流量时段约一半连接被终止，分钟级为每 ~3 分钟一批、每批约一半中止。代码异常、CPU/内存超限状态均为 0，各部署版本都有 loadShed，与某次代码改动无关。
4. 家宽下 16 个入口 TCP/TLS/WS 101 全部正常（TCP 约 175–230 ms），入口本身可达。

### 判断

同一 colo 的连接被 Cloudflare 同时终止，所有落在该 colo 的节点会一起失效，fallback / url-test 无处可切。这与“集体掉线”一致，是有数据支持的主因。白天低流量时段（通常在外使用数据网络）终止比例最高，会让数据网络下更明显。

尚未验证：手机数据网络下各入口落到哪个 colo、两个 DEN 入口是否可用。运营商线路差异仍可能叠加，需要在数据网络下复测。

### 建议（历史）

1. 在数据网络下复测：Mac 连手机热点后执行
   `node tools/probe-cf-entries.mjs <edgetunnel 订阅 yaml> --interface en0 --rounds 5 --extra 3 --json mobile.json`
   以 colo 列和成功率为准。
2. 按复测结果重排 `ADD.txt` 入口：优先可靠美国机房；HKG 入口会让部分 API 出口变香港，不采用。
3. fallback 首位已是 DEN 入口，可保持；`自动选择` 会偏向 SJC 低延迟入口，入口分散后自然缓解。

### 线上已做（2026-11-14 续）

只改 KV `ADD.txt`，**未重新部署 Worker 代码**。Worker `gjtq-vpn-entry` / 域名 `vpn.tastedistill.com` / KV `d6b2e1d8e54c40499d6b6fd7d0e93ca3`。

| 项 | 内容 |
|---|---|
| 入口 | 由约 14 SJC + 2 DEN → **8 DEN + 8 SJC**（家宽 `en0` 直连绑 IP + Worker SNI 的 `/cdn-cgi/trace` 核验） |
| DEN 入口段 | `103.31.4.x`、`162.159.224.x`；变更节点 03/05/07/11/13/15（01/09 原本已是 DEN） |
| 失效回源 | 04：`192.220.21.116`→`23.225.58.246`（CloudRadium / AS40065，LA）；11：`23.144.12.63`→`64.49.28.173`（TAIPEI101 / AS54286） |
| 未做 | 第三机房（LAX 入口候选家宽可用，但未硬凑）；**手机数据网络未连热点，未实测** |
| 私有备份 | 主仓 ignored：`tmp/entry-colo-20261114/`（`ADD-live-20261114-142451.txt` sha256 前缀 `6299ffc864cacea7`；新名单 `ADD-after-20261114.txt` 前缀 `20709e99be008da5`） |

对照：旧 04/11 回源 Google204 仍可能成功（兼容路径 `/proxyip=` direct-first），但 CF/Anthropic/OpenAI 失败；不能用 Google204 单独判定回源健康。

**回滚（仅 KV）：**

```bash
npx wrangler kv key put ADD.txt \
  --path tmp/entry-colo-20261114/ADD-live-20261114-142451.txt \
  --namespace-id d6b2e1d8e54c40499d6b6fd7d0e93ca3 --remote
```

**客户端：** Clash Verge 需手动刷新 “Cloudflare worker” 订阅（或等自动更新）后才会拿到新入口/回源。

**验收摘要（家宽）：** 实际订阅 16 节点与新名单一致；mihomo 配置校验通过；每节点 5 轮 Google204 + CF `loc=US` + Anthropic/OpenAI 401 认证体均通过（16/16）；DEN/SJC/新 04/11 约 3 分钟轮询+小下载稳定。出口目标 colo 与入口 colo 分开计量。`npm test` 116/116。

## 验证

- `npm test`：116/116 通过。
- mihomo 复测：上述 21 个原先漏网域名在新 JMS 模板下全部命中 `RuleSet(jms-ai-shared) → AI-US`；DeepSeek、Kimi、百度仍 DIRECT，未知域名仍 `JMS`。
- edgetunnel：已更新线上 KV `ADD.txt`（见上节）；未改 Worker 代码、未改托管模板仓库、未切换 Clash Verge 活跃客户端。

## 补充：Claude 全量请求核查（JMS）

清单来源：官方 Claude Code / Desktop 网络要求与 IP 段文档；Claude Code 2.1.325 与 Claude Desktop 安装包内的主机字符串；claude.ai 登录页实际加载的主机；本机内核实时连接表（`claude`、`Claude Helper` 进程）。共 141 个主机及 3 个 Anthropic IP。

修改前用线上配置实测：没有任何 Claude 主机走 DIRECT，但 23 个走 `默认代理`（可能从日本或荷兰出口），包括 `cdn.growthbook.io`（Claude Code 特性开关）、`api.datadoghq.com`、`bun.report`、`*.stripecdn.com`、`esm.sh`、`cdn.plot.ly`、`bedrock-mantle.*.api.aws`、`aws-external-anthropic.*.api.aws` 及 10 个官方 MCP 连接器主机。原生 `claude` / `Claude Helper` 进程会被进程规则兜住，浏览器和 npm 安装（`node` 进程）则不会。

新增 `jms-claude-deps` 紧跟 Claude 一方规则，先于所有直连规则，并补齐 Desktop 内置、编辑器扩展、Homebrew 三种 Claude Code 进程路径。修改后 140/144 走 `AI 美国`。剩余 `ghcr.io`、`graph.microsoft.com`、Vimeo、Loom 属通用服务，有意不改。约 200 个通用域名的分流结果零变化。

国内直连清单（category-ai-cn、private、Loyalsoldier direct）中与 Claude 相关的只有 Google Fonts 和 reCAPTCHA，两者均被更早的规则改为 `AI 美国`。TUN 仅接管 IPv4，IPv6 网络下的绕过风险见 `jms-config/README.md`。
