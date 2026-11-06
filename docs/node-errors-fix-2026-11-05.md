# 节点握手错误修复与地区优选（2026-11-05）

> 健康检查修正：后续查明 trace 的 GET 为 200、HEAD 为 404。历史 URLTest 返回数值不能证明期望状态匹配，早期仅按 delay 计数的“探活通过”结论不充分。现已改为实际 HEAD 204 并核对 `extra.alive`；见[同址延迟对比与 HEAD 修复](latency-comparison-and-head-health-fix-2026-11-05.md)。

> 最新修正：用户随后明确要求普通池至少十条、洛杉矶与新加坡各五条，并将门槛调整为单次 ≤250ms。已重新优选为五加五，十六条 AI 保留，总计二十六条。下文的两条普通节点是历史记录；当前结果见[250ms 五加五优选记录](ordinary-250ms-5x5-2026-11-05.md)。

## 最新结果（UTC+8 22:02）

用户选择按单次实测 ≤200ms 筛选，并明确接受后续延迟波动。最终普通池保留两条洛杉矶节点，主客户端曾分别测得 184ms、188ms（UTC+8 21:52 的实测记录）；之后复测已出现 200ms 以上，不能描述成当前或持续低于 200ms。新加坡本轮无达标主客户端样本，已从最终普通池移除；未加入香港节点。十六条严格洛杉矶 AI 节点保留，总计十八条。全部名称为回源 IP、地点和 AI/普通用途。

严格“连续三轮均 ≤200ms”曾筛出零条，因此没有把该未达标结果包装成成功。用户随后明确选择单次标准，最终发布依据为 `ordinary-200ms-ranked-2026-11-05.json` 和 `final-pool-published-2026-11-05.json`。后续各节中的十六条普通节点和八加八组合是过程记录。

UTC+8 22:04 最终真实订阅复验：十八节点、十六个严格洛杉矶 trace 出口、两个普通节点的 Google / YouTube 首页、配置及分流均通过，非 Cloudflare AWS 出口检查未见香港。客户端已刷新 Cloudflare 缓存至十八节点；用户当前选择 Voyra，已保留该选择，live TUN 开启。

## 故障原因

原十六条名单全部使用 `/proxyip-only=`。实测默认 Google 测速仅 1/16 成功；抽样严格节点能访问 Cloudflare trace 和两家 AI API 的认证层，却在 Google、YouTube、Google 字体、部分公共 CDN 和遥测主机上返回 TLS handshake failure。同一传输和回源改用原 `/proxyip=` 后，普通网站恢复。旧报告的 16/16 仅覆盖特定 trace/API，不能证明通用浏览能力。

## 已发布修复

- Worker 继续使用 `c1d0365d-a0cb-4757-84ce-15d8b52db058`，保留严格语义，不重置凭据或回退旧 Worker。
- 私有名单分为十六条 `AI-洛杉矶NN` 严格节点和十六条普通兼容节点。普通池优选阶段，严格 AI URI 逐字节一致；后续按用户要求改名时仅改变 URI 的名称 fragment，凭据、入口、传输和严格回源路径保持一致。
- Claude、ChatGPT 继续为两个独立 fallback，只包含严格节点。普通 fallback、负载均衡、自动选择排除严格节点。
- 公共字体、脚本、CDN、遥测依赖进入普通 fallback；其规则优先于核心 AI 规则，DNS 与路由一致。通用 AI（如 Gemini）继续走普通 fallback。
- 严格核心 DNS 使用经验证可达的 Cloudflare DoH，移除严格组内无法可靠访问的 Google DoH。
- 普通组用真实 Cloudflare trace（HTTP 200）检查实际回源；两个 AI 组继续使用各自 API 地址。探测超时为八秒。
- 全局 UDP/443 和各 AI UDP REJECT 保留，主 TUN 持续开启。

托管策略 [PR #67](https://github.com/sssstwee/xiaomao-ai-proxy/pull/67) 已合并为 `cdacf411209a0f918f48e1b41b681ba51edf961d`；普通探活调整 [PR #68](https://github.com/sssstwee/xiaomao-ai-proxy/pull/68) 已合并为 `d3eefc999d4a7e04568c3f952c1fa581c7a059a2`。只修改托管策略、测试和说明，没有构建客户端包。曾尝试刷新对应公开模板缓存，Cloudflare API 超时；该动作未计为成功。后续通过原有本地代理使用 Wrangler 刷新已核对 GitHub blob SHA 的对应公开模板缓存键，备份和原始字节回读通过。最终以真实鉴权订阅取得已发布模板为准，没有更换转换器或清空整个缓存。

命名 [PR #69](https://github.com/sssstwee/xiaomao-ai-proxy/pull/69) 已合并为 `00dec60fec15e8de48bdc0b180b29baa1166fd6c`。节点显示为 `回源IP 洛杉矶 · AI`、`回源IP 洛杉矶 · 普通` 或 `回源IP 新加坡 · 普通`。末尾用途用于避免同 IP 重名并维持分组隔离；分组过滤同时兼容更新前后标签。

## 普通节点优选

> 后续用户追加“测速 200ms 以内”要求。此前八加八名单仅是第一阶段；最终名单以用户后来选定的单次达标标准及私有发布报告为准，不再为凑足十六条保留超标节点。隔离内核的延迟与主客户端有差异，不将两种结果混用。

按用户要求优先新加坡和洛杉矶，排除香港。从既有公开 ProxyIP 来源筛出 65 个候选；64 个通过 Cloudflare 实际出口、Google / YouTube 首页和非 Cloudflare AWS 出口检查。每个通过项做三轮独立 HTTPS trace 请求，按首字节耗时中位数排序，各地区取较快的八个，再合并按延迟升序发布：

| 普通池 | 数量 |
| --- | ---: |
| 洛杉矶 | 8 |
| 新加坡 | 8 |
| 香港 | 0 |

本轮所选 HTTPS trace 首字节耗时中位数范围为 1414–2393ms，包含完整 HTTPS/代理建连，不是 ICMP ping，也不等于客户端显示的单次延迟。洛杉矶在本轮更快，排列在前。额外的 AWS 回显样本为美国 East Los Angeles，未出现香港；早期样本也曾为美国 San Jose。

普通兼容路径会根据目的地使用 Worker 直连或指定回源，trace/回源地区不能保证所有网站都从相同城市出站。地理判断依赖离线城市库，也不能保证以后每一刻不变化。

维护工具保留独立选出的普通名单，不再用 AI 回源的兼容副本覆盖它。发布门槛同时要求所有保留普通节点的 Google / YouTube 和地区检查通过，防止足够多的健康 AI 节点掩盖普通节点失败。

## 验证与证据

- Node 回归 65/65，Python 托管策略测试 11/11；Mihomo 配置校验通过。
- 原故障修复后的真实鉴权订阅已验证三十二节点、组成员隔离、九类 AI/资源规则、七类 DNS 策略。
- 客户端已刷新并应用 Cloudflare worker；原故障修复时三个 fallback 分别 16/16 探活成功，运行连接中两家 API 命中各自严格组，Google / YouTube 及公共资源命中普通组，样本未出现 DIRECT。
- Claude 未登录首页返回 403 验证页。两家 API 的 401 只证明认证层可达，没有代用户发送模型消息，也没有证明账号、完整登录或语音业务成功。

下列本地 JSON 位于被忽略的 `tmp/`，不含订阅凭据；公开 IP 与城市仅用于诊断：

- `route-compatibility-compare-2026-11-05.json`：相同传输的严格/兼容路径对照。
- `la-split-published-2026-11-05.json`：第一次两套名单发布及原十六节点备份验证。
- `ordinary-regions-ranked-2026-11-05.json`：65 候选、三轮延迟、地区和网站兼容结果。
- `ordinary-regions-published-2026-11-05.json`：普通地区优选发布和备份验证。
- `node-labels-published-2026-11-05.json`：仅修改名称的发布、凭据/传输不变断言及备份验证。
- `ordinary-200ms-ranked-2026-11-05.json`：按用户选择的单次 200ms 标准选出的两条主客户端记录，包含后续超标波动。
- `final-pool-published-2026-11-05.json`：最终十八节点、名单备份与回读校验。
- `final-client-state-2026-11-05.json`：Cloudflare 客户端缓存十八节点、当前 Voyra 选择和 live TUN。
- `la-split-actual-verification-2026-11-05.json`：最新真实订阅与逐节点复验。
- `la-split-live-verification-2026-11-05.json`：客户端组探活及实际路由采样。
- `la-split-maintenance-check-2026-11-05.json`：维护流程保留普通地区优选的只读复验。

修改前名单均先存入原私有 KV 的七天备份，回读通过后才写入。备份键仅记入私有本地发布报告。回滚只恢复相关名单/托管策略，不先回退严格路径 Worker。
