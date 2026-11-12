# JMS 远程完整配置

Clash Verge 只需导入一个受令牌保护的地址。Worker 在服务端合并 JMS 原始节点与此目录的 `clash-base.yaml`，客户端无需本地脚本或 Merge 覆写。公开模板不含订阅 URL、节点凭据或访问令牌。

## 分流

- 国内 AI（包括 Kimi/Moonshot 的海外域名）优先直连，其他国内域名及局域网直连。
- Google、YouTube 及其他国外普通访问使用 `JMS` / `JMS Auto`，不限国家。
- Claude、ChatGPT、Gemini 使用各自独立的美国 `fallback`；其他海外 AI 使用 `AI-US`。
- 美国白名单依次为 s3、s2、s801，依据 2026-11-12 的 Google 地区接口与独立出口检测。节点编号不保证服务商未来不更换出口，变更后应复核白名单。
- 每条代理规则后跟同条件的 `REJECT`，最终 `MATCH,JMS` 后也有 `MATCH,REJECT`。节点不支持 UDP 时不会因规则耗尽而直连；节点运行时失效会在代理内失败。
- 六个 JMS 节点均已通过独立实例的 UDP DNS 转发测试；VLESS 显式启用 `udp` 和 `packet-encoding: xudp`。此测试不代表已验证任意网站的 HTTP/3 或账号内语音业务。
- 国内及节点 DNS 使用国内解析器；海外 AI 的加密 DNS 显式绑定相应美国组，其余国外 DNS 绑定 `JMS`。使用明确的 DNS 代理后缀，因此 `respect-rules` 保持关闭，避免启动时规则加载与节点 DNS 互相依赖。

域名/IP 规则复用 MetaCubeX/meta-rules-dat、Loyalsoldier/clash-rules，以及现有 Voyra/EdgeTunnel 的 AI 引导、资源和语音 IP 列表。GitHub 规则由 Mihomo 自动更新，模板更新在下次订阅刷新后生效。

## 托管

`wrangler.jsonc` 声明独立 Worker `jms-sub-config`。通过 Wrangler Secrets 保存 `JMS_SUB_URL`、随机 `PROFILE_TOKEN`，然后部署。订阅路径为 `/clash/<PROFILE_TOKEN>.yaml`；无效令牌返回 404。请求 URL 的调用日志和跟踪记录关闭，错误日志不包含密钥或上游地址。

若 Clash Verge 针对该订阅启用了 DNS 覆盖，需要关闭该订阅的 DNS 覆盖，让远程配置生效。原始 JMS 订阅可保留作回滚入口。

变更验证：`node --test jms-config.test.mjs`、完整 `npm test`、Wrangler dry run，以及独立 Mihomo 的正常/不支持 UDP/全部美国节点不可用三种行为测试。实际客户端切换后还需验证真实 TUN 连接。
