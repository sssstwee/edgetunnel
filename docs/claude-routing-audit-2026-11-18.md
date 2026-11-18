# 双订阅 Claude 分流复核（2026-11-18）

目标：国内域名与内网直连，国际流量全部代理；Anthropic / Claude / Claude Code 的请求与遥测不得直连。

## 范围与方法

- JMS Remote：本仓库 `jms-config/clash-base.yaml`（线上 `jms-sub-config` 部署于 2026-11-18 12:45 UTC，对应 1ab80ae / a497944），经 `buildConfig` 生成。
- EdgeTunnel：线上 `acl4ssr.ini` 指向的 `xiaomao-ai-proxy@9a7af11…/clash-base.yaml`（`gjtq-vpn-entry` 部署于 12:17 UTC，对应 38218b9）。规则集取本仓库 `resources/rules/`，即客户端实际下载的文件。KV 中如另设 SUBCONFIG，需按实际值复核。
- 主机清单：官方 network-config / desktop / data-usage / IP 文档；Claude Code 2.1.327（darwin-arm64）二进制中的主机字符串；claude.com、platform.claude.com、code.claude.com、support.claude.com 页面引用的主机。共 160 个 Claude 相关主机、2 个 Anthropic IP，另加 29 个国内、13 个国际样本及进程场景。
- 匹配：按 Mihomo 语义（`+.` 后缀、精确、`*.` 单级、classical、AND/NOT、PROCESS-*-REGEX、GEOSITE）逐条求首个命中。本次不允许在容器内运行 Mihomo 二进制，因此不是内核实测；上线前应在 Mac 上用 `verge-mihomo` 复跑一次。

## 结论

两份订阅**均无 Claude 相关主机或 Anthropic IP 落入 DIRECT**。国内样本全部 DIRECT，内网 DIRECT，国际样本全部代理。

| 项 | JMS Remote | EdgeTunnel |
|---|---|---|
| 一方域名 / Anthropic IP | 全部 `AI 美国` | 全部 `Claude 专用` |
| Datadog / Sentry / Statsig / GrowthBook 遥测 | 全部 `AI 美国` | 分散在 `ChatGPT 专用`（Sentry、Statsig、Stripe、Intercom、Segment、Turnstile）和 `故障转移`（Datadog API、GrowthBook、hCaptcha、Google 登录、npm、GitHub、MCP 等） |
| 未收录主机 | Claude 进程 → `AI 美国`，其余 `默认代理` | `默认代理`（无进程规则） |
| 纯 IP 的国内连接 | 走代理（无 GEOIP CN） | 走代理；UDP 被末尾 `NETWORK,UDP,REJECT` 拒绝 |

落入 `默认代理`（仍代理，JMS 下可能是日本或荷兰出口）的 Claude 相关主机：`static.intercomassets.com`、`intercom.help`（帮助中心）、`mintcdn.com`、`mintlify.b-cdn.net`、`claude-code.mintlify.site`（文档站资源）、`app.corridor.dev`，以及 VS Code / JetBrains / Open VSX 扩展市场。

## 实施（同日）

只改订阅，不改客户端（电脑 Clash Verge、手机野猫代理，均为 Mihomo 内核）。

- EdgeTunnel 模板（`xiaomao-ai-proxy` 分支 `claude/claude-deps-routing-20261118`，`acl4ssr.ini` 固定到 65494dd）：新增 `claude-deps` → `Claude 专用`（路由与 DNS），新增 `cncidr` 纯 IP 直连，新增 sniffer。WorkOS、Google / Microsoft 账号主机和 OpenAI 自己的 Sentry 项目不放入该集合，以免改变 ChatGPT、Gemini、Copilot 的登录出口。
- JMS 模板：`jms-claude-deps` 补充 Intercom 资源与帮助中心、Mintlify 文档资源、Vertex 区域端点；新增 `jms-cncidr` 纯 IP 直连；进程兜底加入 Cowork 虚拟机进程。
- 资源同步：创建草稿 Release 后直接使用 API 的返回值（原先立即查询列表时看不到新草稿，导致 11-07 起失败）；规则快照先于 Geo 发布提交，Geo 发布失败不再冻结规则。
- 复测（同一匹配脚本）：Claude 相关主机 DIRECT 仍为 0；EdgeTunnel 的 Claude 遥测和登录依赖全部改为 `Claude 专用`；国内与国际样本结果不变；中国大陆纯 IP 改为 DIRECT。
- EdgeTunnel 没有进程规则，Claude 进程以纯 IP 连接中国大陆地址时也会直连。Anthropic 没有部署在中国大陆的端点，这类连接不是 Claude 服务请求。

## 优化方案（原始建议）

### P1 EdgeTunnel：Claude 依赖固定到 `Claude 专用`（托管模板仓库）

`故障转移` 只排除“普通”节点，包含 WARP 与 `cf-tcp-backup`，健康检查用 `cp.cloudflare.com`；`Claude 专用` 排除二者并以 `api.anthropic.com` 检查。两组出口不同时，claude.ai 登录、验证码、计费和遥测会从不同 IP 发出。在 `anthropic-ip` 之后、`openai-bootstrap` 之前加入与 JMS `jms-claude-deps` 相同的集合：

```yaml
rules:
  # …anthropic-ip 之后
  - AND,((NETWORK,UDP),(RULE-SET,claude-deps)),REJECT
  - RULE-SET,claude-deps,Claude 专用,no-resolve
  # …openai-bootstrap 之前
rule-providers:
  claude-deps:
    type: inline
    behavior: domain
    payload: [] # 复制 jms-config/clash-base.yaml 的 jms-claude-deps，并加上 P3 的主机
dns:
  nameserver-policy:
    rule-set:claude-deps:
      - https://cloudflare-dns.com/dns-query#Claude 专用
```

### P1 恢复 `resources/` 每日同步

`Subscription resources` 工作流最后一次运行为 2026-11-07（失败），此后没有运行；`resources/rules/` 停在 11-03。与上游相比：`anthropic` 少 `http-intake.logs.us5.datadoghq.com`、`o1158394.ingest.us.sentry.io`，`category-ai-cn` 少 9 条，`category-ai-!cn` 少 5 条。前两条由内联规则兜住，但缺失的国内 AI 会被代理。修复发布 Geo Release 的失败后重新启用工作流，或先手动运行 `node resources/sync.mjs` 并走 PR。

### P1 客户端：Claude Code 不读取 macOS 系统代理

TUN 关闭或失效时，CLI（含遥测）会直连。在 `~/.claude/settings.json` 中加入兜底；后台 agent、Desktop 的 Code 页签和 Cowork 只从这里读取代理变量：

```json
{
  "env": {
    "HTTPS_PROXY": "http://127.0.0.1:7897",
    "HTTP_PROXY": "http://127.0.0.1:7897",
    "NO_PROXY": "localhost,127.0.0.1,::1"
  }
}
```

同时确认 Clash Verge 的 TUN 设置开启严格路由和 IPv6（Verge 的 TUN 设置会覆盖订阅里的 `tun` 段），JMS 订阅关闭 DNS 覆写。

### P2 EdgeTunnel 增加 sniffer

模板没有 `sniffer`。应用自带 DoH 或直接连 IP 时只能按 IP 匹配：Anthropic 网段仍能命中，其余 Claude 依赖退到 `默认代理`，国内纯 IP 的 UDP 被拒绝。复制 JMS 的 `sniffer` 段（HTTP/TLS/QUIC、`parse-pure-ip: true`、`override-destination: false`）。

### P2（可选）国内纯 IP 直连

两份订阅都只按域名判定国内直连，用 IP 直连的国内应用（HTTPDNS、语音、P2P）会绕道海外。如需改变，在进程规则和 `jms-proxy` 之后、`MATCH` 之前加入 `GEOIP,CN,DIRECT,no-resolve`。`no-resolve` 只影响无域名的连接；fake-ip 下域名流量不受影响，Claude 进程仍先由进程规则判定。这会推翻 `jms-config.test.mjs` 中“不使用 GEOIP CN”的约束，属于策略取舍，需要决定后再改。

### P3 补齐零散主机（两份订阅）

加入 Claude 依赖集合：`+.intercomassets.com`、`+.intercom.help`、`mintcdn.com`、`mintlify.b-cdn.net`、`+.mintlify.site`。可选：Cowork 虚拟机进程名 `com.apple.Virtualization.VirtualMachine`。它也会匹配其他使用 Apple 虚拟化框架的虚拟机，按需添加。

## 不需要改的部分

- fake-ip 下 Claude 域名不在 `fake-ip-filter`，所有规则都不需要解析，因此不会向国内 DNS 查询 Claude 域名。
- ECH 外层 SNI `cloudflare-ech.com` 会命中 `jms-proxy`。但纯 IP 连接先匹配 `jms-claude-ip`，fake-ip 连接按映射域名匹配，所以 Anthropic 流量不受影响。
- 所有代理组都没有 DIRECT 成员。节点全部失效时连接会失败，不会回落直连。
