# Unified Remote

一个订阅地址汇总 GCP Remote、JMS Remote 和 EdgeTunnel 三条线路。某条线路断了（例如忘记续费），Clash 会自动改用其他线路，不需要手动切换订阅。

## 结构

Worker `all-sub-config` 部署在 `sub.tastedistill.com`，订阅路径是 `/clash/<PROFILE_TOKEN>.yaml`。它只下发 JMS 模板（`../jms-config/clash-base.yaml`），不处理任何节点。模板里有三个 `proxy-providers`，由 Clash 直接拉取各条线路的原订阅：

| 代理集合 | 来源 | 节点名前缀 | 特点 |
|---|---|---|---|
| `gcp` | GCP Remote | 无（名称已含 `GCP`） | HY2 + Reality，每月 260 GiB，花的是 Cloud 赠金 |
| `jms` | JMS Remote | `JMS · ` | 美国 3 个、日本和荷兰各 1 个，每月 500 GB |
| `edgetunnel` | EdgeTunnel | `CF · ` | 美国加州 16 个，不支持 UDP，出口 IP 取决于 ProxyIP |

为什么由 Clash 分别拉取，而不是在服务端合并：每条线路独立拉取、独立缓存，一条线路的订阅失败只影响它自己的节点。统一 Worker 也不需要保存任何线路的节点凭据。Mihomo 能直接读取完整的 Clash 配置作为代理集合，只取其中的 `proxies`，所以三条线路的 Worker 都不用改。

## 分组

- `AI 美国` / `Claude 美国`：`fallback`，引用三个集合，用 `filter: 美国|GCP` 只留美国出口。顺序就是优先级：GCP → JMS → EdgeTunnel。先花完每月赠金；GCP 到 260 GiB 上限断流后，自动由 JMS 接手。EdgeTunnel 不支持 UDP，作为最后一道兜底。
- `自动选择`：`url-test`，从全部节点里选延迟最低的，平时多半会选中 JMS。
- `默认代理`：`select`，第一项是 `自动选择`，其后是全部节点。

## 用量显示

一个订阅只能带一份 `subscription-userinfo`，所以各线路的用量写在三个只用于显示的分组名里。它们是 `select` 分组，只含 `REJECT`，没有任何规则引用，排在代理页最后。EdgeTunnel 的请求额度也是用同样的方式显示的。

- `📊 GCP 已用 2.65 GiB / 260 GiB（1.0%）`、`📊 JMS 已用 61.39 GB / 500 GB（12.3%）`：数据来自对两条线路订阅的 `HEAD` 请求返回的 `subscription-userinfo`。每条线路按服务商的计费单位显示，与服务商后台一致：Google 按二进制 GiB 计费，上限是 260 GiB；JMS 按十进制 GB 计费，套餐是 500 GB。Clash Verge 的订阅卡片和代理集合由客户端自己换算，统一按二进制计算却标作 GB，所以 JMS 在那两处显示为 466GB。
- `📊 CF 本账期剩余请求：99.89%（估算）`：原样沿用 EdgeTunnel 订阅里的同名分组，表示 Worker 调用剩余量。它在 2026-11-13 改成了百分比，这里不另行换算。
- 订阅卡片显示 GCP 与 JMS 的合计用量。EdgeTunnel 按请求次数计量，不计入合计。

用量在 Worker 生成订阅时读取，因此刷新统一订阅后才会更新，默认每 6 小时一次。读取失败时只把该行显示为"暂不可用"，不影响订阅本身。Worker 访问同一个域名下的其他 Worker，需要开启 `global_fetch_strictly_public` 兼容开关。"代理 → 代理集合"里也能看到 GCP 和 JMS 的实时用量。

## 规则

基础规则、DNS 和规则集沿用 JMS 模板。统一订阅单独补充 Google 登录、Antigravity 和必要的 Google .cn 例外，规则和 DNS 都走现有 `AI 美国`，排在通用直连及共享依赖规则之前；保留 `play.googleapis.com` 阻断和现有故障转移，不保证节点故障时公网出口 IP 不变。共享的 Google OAuth 主机也按域名走 `AI 美国`，Claude 和 ChatGPT 自身的服务规则不变。此补丁只需重新部署 `all-sub-config`，不改三条独立订阅。

## 断线时的表现

代理集合每 6 小时更新一次，节点缓存在 `./proxies/unified-<line>.yaml`。拉取失败时继续使用缓存的节点。各分组每 300 秒检测一次节点，连续失败 2 次即跳过，因此失效线路的节点会被自动绕开，线路恢复后再自动用回来。

2026-11-24 用真实订阅在本地验证过：

- GCP 订阅返回 503、节点不可达时，两个 AI 分组切到 JMS 洛杉矶节点，Claude API 返回 401（表示可达），ChatGPT 和 YouTube 返回 200。
- GCP 和 JMS 同时失效时，全部分组切到 EdgeTunnel，请求照常成功。

首次导入时，EdgeTunnel 订阅若遇到转换服务冷启动，可能超过 Mihomo 20 秒的拉取时限，这时该集合暂时为空，下次更新或重新加载后会补上。平时直连拉取约 2 秒。

## 部署

| Wrangler Secret | 内容 |
|---|---|
| `PROFILE_TOKEN` | 统一订阅的令牌，至少 32 个字符 |
| `GCP_PROFILE_URL` | GCP Remote 的订阅地址 |
| `JMS_PROFILE_URL` | JMS Remote 的订阅地址 |
| `EDGETUNNEL_SUB_URL` | EdgeTunnel 的 Clash 订阅地址 |

订阅地址必须是 HTTPS，缺少任何一条时返回 503，客户端继续使用上一次的配置。下发的配置包含这三条线路的订阅地址，所以统一订阅的地址和它们同样需要保密。

```bash
npx wrangler deploy -c all-config/wrangler.jsonc
```
