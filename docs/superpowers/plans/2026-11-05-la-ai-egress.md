# 洛杉矶 AI 出口 Implementation Plan

> 历史计划：记录 2026-11-05 的严格回源实施过程。2026-11-06 用户已明确选择全部兼容入口，以下严格名单发布步骤不适用于当前现网；当前状态见 [全部兼容入口记录](../../all-compatible-2026-11-06.md)。定时维护未启用。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AI 规则及 DNS 从负载均衡分离，发布至少十个不同回源、近期通过出口城市和 API 连通检查的洛杉矶节点，并阻止严格节点静默直连或跨地区回退。

**Architecture:** 分流继续以自有托管 `clash-base.yaml` 为唯一来源；Claude、ChatGPT 保留独立 fallback。新增显式 `/proxyip-only=IPv4:port` 请求路径，复用现有连接器与清理逻辑；已验证的完整 VLESS URI 继续保存在私有 KV 的 `ADD.txt`。维护脚本用现有 Mihomo、Wrangler、GeoLite2 和公开候选源进行复验，不将私有凭据写入文件或公共仓库，不扫描地址空间。

**Tech Stack:** Cloudflare Workers / KV、JavaScript node:test、yaml 2.9.1、Mihomo、GeoLite2 mmdblookup、Wrangler 4.156.2。

---

### Task 1: 托管策略与回归

**Files:** 自有仓库 `sssstwee/xiaomao-ai-proxy/backend/edgetunnel-subscription/{clash-base.yaml,test_policy.py,README.md}`；本地副本 `tmp/la-policy-2026-11-05-2Hu7ME/`。

- [x] 以节点组引用图和 DNS 目标验证旧模板会失败：`node tmp/check-ai-policy.mjs tmp/la-policy-2026-11-05-2Hu7ME/clash-base.yaml`。
- [x] 修改以下两条规则：

```yaml
- RULE-SET,artifact-resources,Claude 专用,no-resolve
- RULE-SET,ai,故障转移
```

- [x] 将原 DNS 合并键拆为 `rule-set:line` → `#默认代理`、`rule-set:ai` → `#故障转移`、`rule-set:artifact-resources` → `#Claude 专用`，保留原两个 DoH。
- [x] 追加 Python 策略引用与 DNS 回归测试；本机 Node 数据检查通过。下载的 Python 测试执行被自动审批拒绝，不委托其他代理绕过。
- [x] 更新策略 README，注明公共 CDN 的共享影响；生成三文件补丁。用户授权继续部署后，已发布至维护仓库 main，提交 `2f61f6e8b03416871ca97582cda08ac886f3dff7`，三个远端文件 blob 均已逐项核对。EdgeTunnel 当前工作分支未提交或推送。

### Task 2: 严格回源与名单失败处理

**Files:** `_worker.js`；必要时新增小型纯解析模块；根目录 `*.test.mjs`；`worker-subscription.test.mjs`。

- [x] 新增请求级 `严格反代目标`，接口为 `/proxyip-only=192.0.2.55:443?ed=2560`。仅允许单个合法 IPv4 和明确的 1..65535 端口；非法编码、重复严格目标及其他路由选择器冲突均拒绝。
- [x] TCP 最优先识别严格目标，调用现有 `connectProxyIP(address, port, data, [[hostname, port]], false)`。不得先连接业务目标，也不得进入通用 TXT/DNS 池；重试仍限同一目标。
- [x] 严格路径拒绝 UDP（包括 DNS/53）；禁用严格路径的本地测速 204 短路。普通 `/proxyip=` 及未启用严格路径的旧节点保留原语义。
- [x] `random=false` 时 ADD.txt 缺失/空白返回错误，不启动随机池，且只读一次 ADD.txt。
- [x] fake socket、实际转换器路径回归完成；独立复核发现混合百分号编码与反斜杠清理可绕过识别，已新增三种输入在 WS/gRPC/XHTTP 的失败复现并修复。修复后 `npm test` 64/64、`git diff --check`、Wrangler dry-run 均通过。

### Task 3: 洛杉矶候选与维护

**Files:** `tools/maintain-la-nodes.mjs`、必要的纯函数测试；公开验证结果存入被忽略的 `tmp/`。

- [x] 从 `xgonce/Cloudflare_IP` 固定提交 `77982a8197237f728b70bcccdbc150f94e4b2101/result.csv` 取得 57 个不同 LAX 候选；离线库筛出 45 个 US/Los Angeles 回源。
- [x] 现有美国03/05/09在隔离内核中通过 trace 出口城市与两个 API 401 连通检查。
- [x] 复用现有 Mihomo，配置通过 stdin 传入；测试进程不启用 TUN，不修改当前内核、策略组或连接。并发受限，退出时关闭自身进程。
- [x] 修复探测器未物化占位 UUID/Host/SNI 的问题；47 个候选用现有普通路径验收，46 个通过且有 46 个不同 trace 出口，1 个因实际出口城市未知排除。401 仅证明 API 认证层可达。
- [x] 本次获授权部署严格 Worker 后，完成生产严格路径复验；初次 47 个回源有 45 个通过，最终发布前复验有 46 个通过且有 46 个不同实际出口。仅选择洛杉矶通过项。
- [x] 工具按原有已通过节点优先排序，默认目标十六个、最低十个；已验证十六节点的占位凭据预览能通过转换器、策略图和 Mihomo 配置校验。
- [x] 严格路径验收后已发布十六个不同洛杉矶回源，线上路径全部为严格模式；原十四节点保存在私有 KV 的七天备份中，备份内容、期限及新名单均已核对。
- [x] 实际发布发现 Wrangler `--text` 额外添加换行导致比较失败，首次发布自动恢复原名单；改为原始字节回读，补齐备份提前记录、备份验证和恢复验证，再次完整回归后发布成功。定时维护模板仍未安装，原 Unauthorized Persistence 拒绝未被扩大为安装授权。

### Task 4: 发布与验证

- [x] 记录原 Worker 部署版本，并于 2026-11-05T08:25:09Z 只读核对生产版本未变、线上仍为十四条节点、live TUN 开启。未修改当前内核、策略选择或旧连接。
- [x] 本次获用户“继续部署”授权后补齐 saved/live TUN 核对，二者均开启；名单发布前已创建并回读验证原十四节点的私有七天备份。
- [x] 发布前再次运行完整回归 64/64、空白检查和 Wrangler dry-run，均通过；2026-11-05T13:08:41Z 收尾完整回归仍为 64/64，失败、跳过及取消均为零。
- [x] 2026-11-05T12:34:51Z 部署 Worker，保留现有变量、KV、域名和转换绑定；版本 `c1d0365d-a0cb-4757-84ce-15d8b52db058` 已承接 100% 流量。旧版 `4598d456-50c0-4b51-8e10-1bb60f2d0309` 已记录为回滚依据。此前 Production Deploy 拒绝是历史状态，本次部署成功。
- [x] 真实严格链路复验后发布十六个不同洛杉矶回源。2026-11-05T12:58:32Z 真实鉴权完整订阅验收退出码 0：Mihomo 配置、严格路径、节点数、组引用与 DNS 均通过；16/16 健康、16 个不同 trace 出口均识别为洛杉矶，三个相关 fallback 各有十六个不同健康回源。两家 API 401 仅证明认证层可达。
- [x] 三个托管源文件已在维护仓库 main 原子发布，提交 `2f61f6e8b03416871ca97582cda08ac886f3dff7`；逐项回读 blob。真实鉴权订阅已自然取得新模板，通用 AI 指向故障转移、Artifacts 指向 Claude 专用，八类 AI 规则和六类 DNS 策略检查通过。没有直接覆写或清除转换缓存；EdgeTunnel 工作分支未提交或推送。
- [x] 2026-11-05T13:08:42Z 只读复核当前客户端：live TUN 开启，但仍为原十四节点、通用 AI 与 Artifacts 仍指向默认代理。服务端发布完成，客户端待刷新“Cloudflare worker”订阅；本轮未强制重载、改变策略选择或关闭旧连接。
- [ ] 安装并验收定时维护；实际 LaunchAgent 安装被自动审批以 Unauthorized Persistence 拒绝，仅提供未启用的项目内模板。本次未重试持久化安装，不能承诺已启用周期维护。
- [x] 最新部署与验收报告为 `docs/la-ai-egress-deployment-2026-11-05.md`。首次报告 `docs/la-ai-egress-results-2026-11-05.md` 保留历史并加注后续上线链接；前端无修改、后端已上线、客户端待刷新、自动维护未启用及账号业务未验收均分别说明。
