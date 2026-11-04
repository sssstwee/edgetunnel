# 订阅资源镜像

EdgeTunnel 和 Voyra 的公共静态依赖集中存放在本目录。分组、DNS 和业务分流仍由 [统一托管模板](https://github.com/sssstwee/xiaomao-ai-proxy/tree/main/backend/edgetunnel-subscription) 维护；此处只同步数据，不生成新的分流策略。

| 目录 / 文件 | 内容 | 来源与条款 |
| --- | --- | --- |
| `rules/*.yaml` | 19 个 Mihomo 规则集，原文件保持不变 | Loyalsoldier/clash-rules（GPL-3.0）、MetaCubeX/meta-rules-dat（GPL-3.0）、blackmatrix7/ios_rule_script（GPL-2.0） |
| `icons/*.png` | 默认代理、负载均衡、自动选择、Claude、ChatGPT、QUIC 图标（QUIC 复用 Rocket 原图） | [zuluion/Qure](https://github.com/zuluion/Qure)，基于 Koolson/Qure；固定提交，转载注明出处、禁止商业用途，原说明见 `licenses/Qure.README.md` |
| `cidr/*.txt` | 4 份 CF / 电信 / 联通 / 移动随机优选网段清单，原文件保持不变 | [cmliu/cmliu](https://github.com/cmliu/cmliu)，来源提交与摘要见 `snapshot.json`；上游未提供根许可证，不将其声明为本项目原创 |
| `data/chatgpt-voice.json` | OpenAI 语音 IP 网段 | [OpenAI 官方 JSON](https://openai.com/chatgpt-voice.json)，原样镜像，不将上游数据声明为本项目所有 |
| `licenses/` | 上游许可证、原始说明和来源 | 各文件按原作者条款使用，不因镜像而改为仓库的默认许可证 |
| `sources.json` | 上游仓库、分支 / 固定提交、文件路径 | 同步输入，新增资源在这里登记 |
| `snapshot.json` | 实际下载提交、URL、文件大小及 SHA256 | 每次同步生成的可审计快照 |

四个 Geo 数据文件 `geoip.dat`、`geosite.dat`、`geoip.metadb` 和 `GeoLite2-ASN.mmdb` 保留 MetaCubeX/meta-rules-dat 发布的原始字节，放到本仓库 [Releases](https://github.com/sssstwee/edgetunnel/releases/latest)；不把大二进制反复写入 Git 历史。Release 附带 SHA256SUMS、来源快照和上游声明。派生数据的来源列表保留在 `licenses/MetaCubeX-meta-rules-dat.README.md`；GeoLite2 数据由 MaxMind 创建，见 [MaxMind](https://www.maxmind.com)，原数据和商标权利仍归其作者。

运行中的订阅只引用 `sssstwee` 自有仓库的规则、图标、Voice JSON、随机优选 CIDR 和 Geo 数据。DNS 解析器、AI 服务 API 和测速 URL 是在线服务，继续使用原服务端点。私密节点参数、鉴权和订阅 URL 不进入公共仓库。

## 更新

`Subscription resources` 工作流每天 UTC 19:17（北京时间次日 03:17）执行，也可以手动运行。复用已有 `yaml` 包与 GitHub CLI；不构建客户端。下载时先解析上游分支为提交 SHA，校验 YAML / IP 网段 / PNG；Geo 数据必须匹配上游 GitHub 的 SHA256。全部通过才替换快照，错误时保留仓库中最后可用版本。

Geo 数据以内容哈希命名 Release。先在草稿上传所有附件并核对摘要，再发布为 latest；已发布资产不覆盖。文件未变时复用原 Release。客户端 `geox-url` 使用本仓库 `releases/latest/download/<文件名>`，规则和图标使用 `raw.githubusercontent.com/sssstwee/edgetunnel/main/resources/...`。

```sh
npm install --omit=dev --ignore-scripts
node resources/sync.mjs
node resources/sync.mjs --check
node resources/sync.mjs --publish-geodata
```

同步需要 `gh` 登录或 `GH_TOKEN`；工作流使用仓库自带的 `GITHUB_TOKEN`，无需额外密钥。`.cache/` 仅存放待发布文件，不入库。手工发布前先检查 diff 并走 PR；日常工作流只提交资源快照。
