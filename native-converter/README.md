# Cloudflare 私有订阅转换服务

此目录是独立部署的 GPL-3.0 组件，复用 [jinganix/subconverter](https://github.com/jinganix/subconverter) 的 `@subconverter/core` 0.4.0。原 EdgeTunnel 的许可证保持原值，部署产物通过标准 HTTP 请求 / 响应在私有 Service Binding 间通信，转换引擎不打包到 EdgeTunnel 代理 Worker 中。

服务只接收 `/convert` 的 POST：`{ raw, target, conversion, skipCertVerify }`。没有公网路由和 workers.dev 地址，也不接收需要代抓取的私人订阅 URL；鉴权及节点生成由 EdgeTunnel 原入口执行。模板与公开资源由自有 GitHub 获取，最后有效模板存放于专用 `POLICY_CACHE` KV，300 秒检查更新。

```sh
npm install --ignore-scripts
npx wrangler kv namespace create POLICY_CACHE
cp native-converter/wrangler.toml native-converter/wrangler.local.toml
# 填入自己的 Worker 名称和 POLICY_CACHE 命名空间。
npx wrangler deploy --config native-converter/wrangler.local.toml
```

EdgeTunnel 的本地 Wrangler 配置增加 `CONVERTER` service binding，service 指向刚部署的 Worker 名称。先部署转换服务，再部署 EdgeTunnel；最后将后台 SUBAPI 改为 EdgeTunnel 自身 HTTPS 域名，SUBCONFIG 保持统一 INI。原始订阅地址和凭据保留。独立部署两个 Worker 时都保留原变量与限制；不要向转换服务复制后台密码或节点 UUID 等绑定。

输入与输出均有体积限制；异常日志只有类型，不记录原始节点、订阅 URL 或请求体。仅节点模式不依赖托管模板，模板下载 / 校验失败时保留 KV 中最后有效版本。
