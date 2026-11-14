# JMS 远程完整配置

Clash Verge 只需导入一个受令牌保护的地址。Worker 在服务端合并 JMS 原始节点与此目录的 `clash-base.yaml`，客户端无需本地脚本或 Merge 覆写。公开模板不含订阅 URL、节点凭据或访问令牌。

Worker 使用 JMS 官方 `noss=1` 参数请求上游，排除即将退役的 Shadowsocks s1；当前保留 s2、s3、s4、s5、s801 五个 VLESS 节点。客户端订阅地址不变。

## 订阅来源与流量

优先请求 `jmssub.net`；网络失败、8 秒超时、HTTP 错误、重定向、无效 YAML、空节点或缺少已验证美国节点时，自动改用官方镜像 `jjsubmarines.com`。两个来源保留相同订阅参数并强制 `noss=1`，同时过滤意外返回的 SS/SSR。镜像也不可用时返回 503，让客户端保留旧配置，避免提供缺失 AI 分流的原始订阅。`X-Subscription-Source` 响应头标识本次采用的来源，不包含凭据。

服务端复用已有订阅凭据调用官方 `justmysocks6.net/members/getbwcounter.php`，将 `monthly_bw_limit_b` 和 `bw_counter_b` 转换为标准 `subscription-userinfo` 响应头。Clash Verge 原生显示已用/总量及进度条，剩余为总量减已用；无需客户端脚本、额外订阅或流量占位节点。API 只提供累计用量，因此将它放入 `download`，`upload` 设为 0，这不代表实际上下行拆分。数值按 API 原始字节传递；套餐的十进制 GB 与客户端的二进制显示可能不同。

流量随订阅刷新更新，保留每 6 小时的更新提示。API 单次查询限时 4 秒；失败或数据无效时沿用所选上游提供的流量头，若上游也没有则省略，不以 0 冒充查询结果。账单重置日不作为订阅到期日；只有上游明确提供的到期时间才保留。API 与订阅链接均仅留在服务端。

## 分流

- 国内 AI（包括 Kimi/Moonshot 的海外域名）优先直连，其他国内域名及局域网直连。
- 未明确分类的外网、普通海外站点使用 `默认代理` / `自动选择`，不限国家。为统一 Gemini 的 API、登录、验证码和国家域资源出口，整个 Google 规则集（包括 Google、YouTube）归入 `AI 美国`。共享 CDN、GitHub/npm 等 AI 客户端依赖也会使用美国出口。Grok 在 X、Copilot 在 Bing 的共用域复用 MetaCubeX twitter/bing 集合，因此普通 X/Bing 访问也走美国。Claude 登录页实测的 hCaptcha 及 Cloudflare / reCAPTCHA / Arkose 验证资源也统一进美国组。
- Claude/Claude Code、OpenAI/ChatGPT/Codex、Gemini、Meta Muse、Grok、Copilot、DeepL/Lara/Yandex 翻译和其他海外 AI 统一使用美国 `fallback` 组 `AI 美国`。MetaCubeX `category-ai-!cn` 未收录的 character.ai、Replicate、Runway、v0、Bolt、Lovable、Suno、Together、Fireworks、DeepInfra、LMArena、Hailuo 国际版等，以及 Stripe 风控 `stripe.network`、Segment，在 `jms-ai-shared` 中固定为 `AI 美国`。
- 美国白名单依次为 s3、s2、s801，依据 2026-11-13 复核的 Google 地区接口与独立出口检测。节点编号不保证服务商未来不更换出口，变更后应复核白名单。
- 显式国内 AI 例外优先；四类关键账号服务的内置域名紧随其后，先于泛化国内 AI 名单，避免被宽泛分类放行。随后处理其他国内 AI、局域网、AI 应用进程名/路径及其余 AI 域名/IP，最后为国内域名和普通代理。启用 HTTP/TLS/QUIC 域名嗅探（不解密 TLS，不改写实际目的地址）。无法取得进程或嗅探域名时，继续按域名/IP/最终规则处理，不能把进程识别当作绝对保证。
- 移除仅按中国公网 IP 判定 `DIRECT` 的规则。未识别的公网 IP 走普通代理；已知国内域名、国内 AI 与局域网仍直连。这会让只使用公网 IP 的部分国内应用走代理。
- 每条代理规则后跟同条件的 `REJECT`，最终 `MATCH,默认代理` 后也有 `MATCH,REJECT`。节点不支持 UDP 时不会因规则耗尽而直连；节点运行时失效会在代理内失败。
- 保留的五个 VLESS 节点均已通过独立实例的 UDP DNS 转发测试，显式启用 `udp` 和 `packet-encoding: xudp`。此测试不代表已验证任意网站的 HTTP/3 或账号内语音业务。
- 国内及节点 DNS 使用国内解析器；海外 AI 的加密 DNS 显式绑定 `AI 美国`，其余国外 DNS 绑定 `默认代理`。使用明确的 DNS 代理后缀，因此 `respect-rules` 保持关闭，避免启动时规则加载与节点 DNS 互相依赖。

域名/IP 规则复用 MetaCubeX/meta-rules-dat、Loyalsoldier/clash-rules、blackmatrix7/ios_rule_script 的域名条目，以及现有 Voyra/EdgeTunnel 的 AI 引导和资源列表。ChatGPT 语音 IP 更新自 [OpenAI 官方 JSON](https://openai.com/chatgpt-voice.json)（2026-11-12 发布，540 条）；后续新增且未列入的公网 IP 仍会走普通代理，不会按中国 IP 回落直连。GitHub 规则由 Mihomo 自动更新，模板更新在下次订阅刷新后生效。

## 托管

`wrangler.jsonc` 声明独立 Worker `jms-sub-config`。通过 Wrangler Secrets 保存 `JMS_SUB_URL`、随机 `PROFILE_TOKEN`，然后部署。订阅路径为 `/clash/<PROFILE_TOKEN>.yaml`；无效令牌返回 404。请求 URL 的调用日志和跟踪记录关闭，错误日志不包含密钥或上游地址。

若 Clash Verge 针对该订阅启用了 DNS 覆盖，需要关闭该订阅的 DNS 覆盖，让远程配置生效。原始 JMS 订阅可保留作回滚入口。

变更验证：`node --test jms-config.test.mjs`、完整 `npm test`、Wrangler dry run，以及独立 Mihomo 的正常/不支持 UDP/全部美国节点不可用三种行为测试。实际客户端切换后还需验证真实 TUN 连接。

Muse 的 `muse.ai` 除自动更新的 AI 清单外，还固定在内置 Meta 优先规则中；与 `metaaivm.com`、Meta 认证/CDN 域共用美国策略及 DNS。Muse / Muse Code 进程名称和 Muse.app 路径也列入兜底。

## Claude / Claude Code 专项

覆盖 claude.ai 网页、Claude Desktop（含 Cowork、Artifact、MCP Apps、Claude in Chrome 桥接与自动更新）、Claude Code（原生安装、npm/bun、Homebrew、VS Code 扩展、Desktop 内置副本）、Console、Bedrock / Vertex / Foundry / Claude Platform on AWS 与官方 MCP 连接器。清单来自[官方网络要求](https://code.claude.com/docs/en/network-config)、[Desktop 网络要求](https://code.claude.com/docs/en/desktop)、[Anthropic IP 段](https://platform.claude.com/docs/en/api/ip-addresses)、CLI 与 Desktop 安装包内的主机字符串、claude.ai 页面实际请求和本机内核的实时连接。

- 一方域名（`anthropic.com`、`claude.ai`、`claude.com`、`claude.app`、`claudeusercontent.com`、`claudemcpcontent.com`、`clau.de` 等及其全部子域）在 `jms-claude-bootstrap`，仅次于少量国内 AI 例外，先于任何其他直连规则。
- 第三方依赖在 `jms-claude-deps`，紧跟其后：Datadog / GrowthBook / Sentry / Statsig 遥测与特性开关，hCaptcha / Turnstile / reCAPTCHA / Google 登录，Stripe / Intercom / Segment，安装更新与插件所需的 `storage.googleapis.com`、npm、GitHub、Homebrew、googlesource，Artifact 字体与脚本库，Chrome 扩展更新，Bedrock / Vertex / Foundry / `*.api.aws`，以及 Claude 内置的 MCP 连接器主机。
- IP 直连：`160.79.104.0/23`、`153.61.224.0/22`、`2607:6bc0::/48`。
- 进程兜底：进程名 `claude`、`Claude`、`Claude Helper*`；路径 `/Applications/Claude.app/`、`~/.local/share/claude/versions/`、`~/Library/Application Support/Claude/claude-code/`、编辑器扩展 `anthropic.claude-code-*`、Homebrew `Caskroom/claude-code/`。npm 安装的 Claude Code 以 `node` 进程运行，只能依靠上述域名规则。
- 以上每组都有同条件 `REJECT` 兜底，DNS 也经 `AI 美国` 解析。
- 剩余限制：TUN 只接管 IPv4。所在网络提供 IPv6 时，自行取得 AAAA 记录的应用（如开启“安全 DNS”的浏览器）可能绕过代理直连；在这类网络上，请在 Clash Verge 中启用 IPv6 接管，或关闭该网卡的 IPv6。

## 覆盖边界

核对来源：[Claude Code 网络要求](https://code.claude.com/docs/en/network-config)、[ChatGPT 网络要求](https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps)、[Codex 官方源码](https://github.com/openai/codex)、[Gemini CLI 官方源码](https://github.com/google-gemini/gemini-cli)。Statsig 动态切换域复用[官方列表](https://docs.statsig.com/infrastructure/statsig_domains)，WorkOS / AuthKit 使用官方认证域族。另按 [hCaptcha 官方通配域要求](https://docs.hcaptcha.com/#content-security-policy-settings) 覆盖动态资源子域。包含 API、认证、WebSocket、上传/工件、安装更新、插件依赖、遥测及语音 IP；共享主机按域名整体代理，无法按加密 URL 路径只分出 AI 请求。

用户选择保留普通代理兜底，因此不能承诺所有未来新 AI 域名都自动归入 `AI 美国`。动态 MCP/第三方网关、自定义 API、远程云端执行请求、未被本机 TUN 接管的连接，需要分别核验。本机规则也不是断开客户端后仍生效的系统防火墙。验收只声明实际采集、逐项路由测试及故障注入覆盖的范围；主页响应或海外 IP 不代表登录、生成、语音等业务全部成功。
