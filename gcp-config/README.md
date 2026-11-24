# GCP Remote

一台 Google Cloud 免费层 VM，加一个受令牌保护的 Clash 订阅。费用全部由 Google AI Pro 每月 $10 的 Cloud 赠金抵扣，国内使用不另外付费。

## 成本模型

| 资源 | 规格 | 月费 |
|---|---|---|
| VM | `gcp-proxy-usw1`，e2-micro，标准预配，`us-west1-b` | $0（免费层） |
| 启动盘 | 10 GB `pd-standard`，无快照计划 | $0（免费层） |
| 静态 IPv4 | `gcp-proxy-usw1-ip`，Standard 网络层 | $3.60–3.72 |
| 出站流量 | Standard 层，每月前 200 GiB 免费，之后 $0.085/GiB | 0–$5.10 |

VM 上的 nftables 配额把出站流量限制在每月 **260 GiB**，最高月费约 $8.82，留约 $1.2 余量吸收计量误差。理论上限是 274 GiB，此时正好花完 $10。Standard 层按流量来源区域计价，发往中国大陆没有附加价。Premium 层发往大陆是 $0.23/GiB，且不在免费额度内，所以不使用。

预算"my google vpn 预算"只扣除免费层等折扣，不扣促销赠金。因此它跟踪的是赠金消耗：在 $5、$9、$10 和预计月底超过 $10 时发邮件。预算只发提醒，不停止计费；硬性上限由 VM 配额保证。

## 服务端

`server/setup.sh` 在 Debian 13 上以 root 运行，可以重复执行。已生成的密钥、证书和配额记账都会保留。

- **Xray VLESS + REALITY + Vision**，监听 TCP 443。伪装目标是 `addons.mozilla.org`：TLS 1.3，Fastly 托管，国内可直接访问。目标站协商 X25519MLKEM768，所以客户端必须设 `support-x25519mlkem768: true`，否则 REALITY 认证失败。
- **Hysteria 2**，监听 UDP 443，使用自签证书，客户端用 SHA-256 指纹固定。UDP 21000–21050 由 `gcp-hy2-hop.service` 转发到 443，用于端口跳跃。未认证的探测会被反向代理到 Bing。
- **节点顺序是 HY2 在前、Reality 在后**，两个美国 `fallback` 组也按这个顺序。原因是浙江电信到俄勒冈的最低往返约 185ms，TCP 重传常超过一成，QUIC 更能扛丢包。
- **HY2 客户端设了 `down: 200 Mbps` / `up: 30 Mbps`**，启用 Brutal 拥塞控制。2026-11-24 中午实测 40 MB 下载的中位速度：BBR 50 Mbps，Brutal 100 为 57 Mbps，Brutal 200 为 77 Mbps。三者的 VM 出站都比有效载荷多约 23%–25%，所以 Brutal 没有明显多耗流量。设定值不能超过客户端线路的实际带宽，用 `HY2_DOWN_MBPS` / `HY2_UP_MBPS` 调整。按这个开销估算，260 GiB 出站上限约合 210 GiB 实际内容。
- 两个代理都拒绝访问元数据服务器和私有网段，VM 也没有挂服务账号。
- 内核启用 BBR + fq，UDP 缓冲区 16 MiB，1 GiB swap。unattended-upgrades 只安装 Debian 安全更新，Xray 和 Hysteria 不随系统更新。

### 出站配额

`gcp-egress-quota` 每 10 秒运行一次，按 4 GiB 一块发放 nftables 命名配额。每块额度先写盘记账，内核才能使用，所以崩溃或重启只会让当月少用，不会超额。月份按太平洋时间计算，与 Google 结算月一致。剩余不足 1 GiB 时续额，续额时沿用内核的实际已用字节；重启后没有实时计数，整块已发放额度按已用计算。

配额用完后丢弃所有出站流量，只放行元数据服务器、DHCP 和 SSH 回包，便于维护。Xray 和 Hysteria 依赖配额服务，配额加载失败时两者都不启动。

Debian 自带的 `nftables.service` 已停用，因为它停止和重启时会执行 `flush ruleset`，连配额表一起清空。不要重新启用它。

`gcp-usage-report.timer` 每 10 分钟把用量推送到 Worker 的 `/usage/<USAGE_TOKEN>`，Clash Verge 据此显示已用量和 260 GiB 总量。

## 订阅

Worker `gcp-sub-config` 部署在 `gcp.tastedistill.com`，订阅路径是 `/clash/<PROFILE_TOKEN>.yaml`。它直接打包 `../jms-config/clash-base.yaml`，与 JMS Remote 共用 `renderUsPolicy`，所以两个订阅的规则、DNS 和分组完全一致。改规则只需修改 JMS 模板，然后重新部署这两个 Worker。

| Wrangler Secret | 内容 |
|---|---|
| `GCP_NODES` | VM 上 `/etc/gcp-proxy/client.json` 中的 Mihomo 节点数组 |
| `PROFILE_TOKEN` | 订阅令牌，至少 32 个字符 |
| `USAGE_TOKEN` | VM 推送用量用的令牌，与订阅令牌分开 |

KV `GCP_USAGE` 只保存最新的 `{month, used, total}`。用量不属于当前结算月时，订阅不返回 `subscription-userinfo`。节点无效时返回 503，客户端继续使用上一次的配置。

## 运维

```bash
gcloud compute ssh gcp-proxy-usw1 --zone=us-west1-b
gcloud compute scp --zone=us-west1-b gcp-config/server/* gcp-proxy-usw1:~/gcp-setup/
sudo bash ~/gcp-setup/setup.sh                        # 重新部署，保留密钥
sudo /usr/local/sbin/gcp-egress-quota report          # 本月用量
sudo cat /etc/gcp-proxy/client.json | npx wrangler secret put GCP_NODES -c gcp-config/wrangler.jsonc
npx wrangler deploy -c gcp-config/wrangler.jsonc
```

要修改上限，用 `EGRESS_LIMIT_GIB=<n>` 重新运行 `setup.sh`。重启 VM 时使用 `sudo systemctl reboot`。`gcloud compute instances reset` 相当于断电，刚写入、尚未落盘的文件会变成 0 字节。

验证：`npm test`；本机用 `verge-mihomo -t` 校验订阅；再起一个独立的 Mihomo，设 `interface-name: en0` 绕开本机 TUN，逐个节点请求 gstatic 204、`api.anthropic.com`（401 表示可达）和 Cloudflare trace，确认出口 IP。
