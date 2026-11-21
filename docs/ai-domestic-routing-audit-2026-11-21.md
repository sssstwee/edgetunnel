# 双订阅国际 AI 与国内直连复核（2026-11-21）

目标：Claude、OpenAI、Gemini 等国际 AI 的全部域名和请求都走代理（EdgeTunnel 进各自的 AI 专用组，JMS 进 `AI 美国`）；开着代理访问国内站点和应用时直连。

## 方法

- **主机清单**
  - 从本机 AI 客户端的程序和资源文件中提取主机名：Claude Desktop、Claude Code 2.1.329、ChatGPT、Codex 0.171.0、Gemini CLI、Antigravity、Cursor / cursor-agent、Grok Bot / grok CLI、Amp、Warp、T3 Code、Qoder。
  - 补充 Anthropic、OpenAI、Google 官方网络文档中的主机，以及约 60 个其他国际 AI 服务。
  - 厂商自有域名 1,085 个，其余主机名 16,921 个（含大量打包库和代码片段带来的噪音）。
  - 国内站点与应用样本 165 个，覆盖网站、App 接口、CDN、推送 SDK 和国内 AI。
- **内核实测**
  - 用 Mihomo v1.19.33（`verge-mihomo`）独立实例加载 Clash Verge 当前缓存的两份订阅。
  - 规则集使用本仓库 `resources/rules/`（当天同步）和最新的 Geo 数据。
  - 节点换成本地空的 SOCKS 接收端，直连绑定 `lo0`，整个测试不产生真实的外网连接。
  - 以内核日志中的首个命中规则为准。

## 结论（修复前）

两条订阅都**没有国际 AI 厂商的主机走直连**。各厂商的一方域名全部进入 AI 组：Anthropic、OpenAI、Google/Gemini、xAI/X、Microsoft Copilot、Cursor。

在本机 AI 客户端出现的主机中，走直连的都是国内站点或中国区端点，例如 `amazonaws.com.cn`、`microsoftonline.cn`、清华 PyPI 镜像。这些直连是正确的。

| # | 线路 | 问题 | 影响 |
|---|---|---|---|
| A | EdgeTunnel | `ai-shared` 含 `+.googleapis.com`、`+.gstatic.com`、`+.googleusercontent.com` 等 27 条 Google 后缀，排在 `google` 之前 | 438 个 Google 主机走 `故障转移`，与 `Gemini 专用` 可能不同出口 |
| B | EdgeTunnel | `tld-not-cn` 排在 Loyalsoldier `direct` 之前 | `direct` 中约 816 个国内域名被代理，例如 `115cdn.de`、`163.fm`、`lizhi.fm` |
| C | EdgeTunnel | 广告清单含 `+.getui.com`、`+.getui.net`、`+.jpush.cn`、`+.jpush.io`、`msg.umengcloud.com` | 个推、极光、友盟推送被拒绝，手机上国内 App 的推送可能失效 |
| D | 两条 | Amp、Warp、T3 Chat、Anysphere、`geminicli.com` 未收录 | 走 `默认代理`；JMS 下可能从日本或荷兰出口 |

以下属于设计如此，没有修改：
- **国内厂商的国际版 AI 直连**：Kimi、Moonshot、Qwen、Z.ai 等由 `cn-ai-extra` 显式定为直连。
- **`cdn.jsdelivr.net` 走 Claude 组**：这是 Artifacts 依赖。
- **EdgeTunnel 的广告和统计主机继续 REJECT**：例如 `hm.baidu.com`、`ulogs.umengcloud.com`。

## 修复

- **EdgeTunnel 托管模板**：
  - `google` 规则（连同 UDP 拒绝规则）移到 `ai-shared` 之前。
  - `tld-not-cn` 移到 `direct` 之后、`GEOSITE,cn` 之前。后者含 `.ms`、`mpg.de` 等宽泛条目，排在后面可以避免这些外国域名改为直连。
  - DNS 策略按相同顺序调整。
  - 新增 `cn-push` 推送放行规则，排在广告清单之前。
  - `ai-shared` 补充上述 AI 工具，`gemini-bootstrap` 补充 `geminicli.com`。
- **JMS 模板**：
  - `jms-ai-shared` 和 `jms-gemini-bootstrap` 做同样的补充。
  - 进程兜底路径加入 Amp、Warp、T3 Code、Grok Bot 和 `~/.grok/`。

## 复测

在同一套环境上对全部主机做前后对比：
- **EdgeTunnel**
  - 438 个 Google 主机由 `故障转移` 改为 `Gemini 专用`。
  - 新增的 AI 工具域名进入 AI 组。
  - 新走直连的只有 `direct` 清单内的国内域名（120 个样本中 102 个；其余 4 个同时在代理清单中，保持代理）和推送 SDK。
  - 没有任何厂商主机变为直连。
- **JMS**：只有 8 个新增 AI 主机由 `默认代理` 改为 `AI 美国`，其余结果不变。
- **测试**：模板测试 18/18、仓库 `npm test` 全部通过。

## 仍未覆盖

- **EdgeTunnel 的 UDP 限制**：EdgeTunnel 节点不承载 UDP，AI 的 QUIC 和语音 UDP 会被拒绝，客户端需要回落到 TCP。JMS 的 `AI 美国` 支持 UDP。
- **未收录主机的兜底**：未收录的 AI 主机在 EdgeTunnel 走 `默认代理`（全部是美国节点）。JMS 在识别到 AI 进程时走 `AI 美国`。
- **验证范围**：内核实测只验证规则命中，不包括登录、生成、语音等实际业务，也不包括手机客户端。
