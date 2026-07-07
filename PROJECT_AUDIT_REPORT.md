# NodeCrypt 安全审计与优化实施报告

审计与实施日期：2026-07-07  
项目定位：临时端到端加密聊天，服务端只做在线成员协调和密文盲转发。  
范围：`client/`、`worker/`、`server/`、`wrangler.toml`、`Dockerfile`、`README.md`、依赖与本地部署流程。

## 总结

本轮已按“临时聊天”场景完成主要修复：服务端不再参与明文或密钥计算，消息、图片、文件和私信都走客户端端到端加密；Worker 和本地 Node 服务端都改成盲转发；成员列表、后进入房间显示 `Peer ...` 后不更新、双方无法通信、同 `clientId` 重连误删成员等问题已经修复并回归验证。

当前可直接用于临时会话，但不建议作为长期账号系统或持久化聊天系统使用。它没有注册登录、历史消息、离线消息和强身份认证；任何拿到相同房间名和密码的人都可以加入。

## 已修复的问题

### 1. 在线成员列表与后进入房间通信

- 修复后进入房间时 relay 早于成员密钥建立导致消息丢失的问题：未知 peer 的 relay 会短暂排队，成员列表到达并完成 ECDH 后再解密。
- 修复成员先显示 `Peer <clientId>` 但不更新真实用户名的问题：profile 消息现在通过 E2EE 发送，收到后会把成员名从临时 peer 名称更新为对方用户名。
- 修复双向通信失败：本地与 Worker WebSocket 统一走 `/ws?room=...`，服务端只转发密文，不再混用旧协议路径。
- 修复同 `clientId` 重连或重复连接时，旧 socket 的 close 事件误删新成员的问题：现在 close 时只清理与当前 socket 完全匹配的成员记录。

### 2. 加密协议

- 移除旧的 AES-CBC、裸 ChaCha20、RSA 服务端密钥、`SHA-256(password)` 和 XOR 混合密钥设计。
- 新增 V2 协议：
  - PBKDF2-HMAC-SHA-256 从房间名和密码派生房间密钥。
  - P-256 ECDH 为每次连接生成临时会话密钥。
  - HKDF 做用途隔离，生成每个 peer、每个方向独立的消息密钥和 nonce 前缀。
  - AES-GCM 做认证加密，AAD 绑定协议版本、房间、发送方、接收方、消息类型和序号。
- 服务端只看到 `roomId`、临时 `clientId`、临时公钥和密文 envelope，不接收房间密码，也不解密消息。

### 3. 分享链接隐私

- 分享链接从旧的 query 参数改为 URL fragment：`#invite=...`。
- 房间名和密码不会随 HTTP 请求发送给服务器，因此不会进入普通访问日志。
- 保留旧格式兼容：仍能读取旧的 `?r=&p=` 和 `?node=&pwd=` 链接，读取后会清理地址栏。

### 4. 服务端安全

- Worker 和本地 Node 服务端都增加了：
  - 房间 ID、客户端 ID、公钥、nonce、消息类型、序号、密文长度校验。
  - 每房间最多 64 人。
  - 每连接 10 秒最多 120 条消息。
  - 连续坏消息上限。
  - 连接超时清理。
  - `/api/health` 健康检查。
  - 未知 `/api/*` 返回 404，不再返回误导性成功。
  - `/ws` 非 WebSocket Upgrade 返回 426。
- 房间成员容器从普通对象改为 `Map`，避免对象原型污染类问题。
- 本地 `server/server.js` 关闭 `perMessageDeflate`，限制 `maxPayload = 8MB`。

### 5. 前端安全

- 默认关闭 debug，避免协议对象、消息内容或密钥相关状态被打印到控制台。
- 成员列表增加临时公钥安全码，用户可通过其他可信渠道核对当前会话对端。
- 图片预览、文件下载和文件消息路径已清理主要 XSS 风险：
  - 用户输入默认走 `textContent`。
  - 文件下载按钮移除 inline handler。
  - 图片源限制在 `data:image/png|jpeg|jpg|gif|webp` 或 `blob:`。
  - 文件名、文件 ID、大小等字段做转义和格式校验。
- 文件传输增加限制：
  - 单批最多 20 个文件。
  - 单文件最大 50MB。
  - 单批总大小最大 100MB。
  - 最大 512 个分片。
  - 文件 ID 使用随机值。

### 6. 安全响应头

Worker 和本地 Node 静态服务都加了基础安全头：

- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy`
- `Cross-Origin-Opener-Policy`

当前 CSP 仍保留 `style-src 'unsafe-inline'`，主要是为了兼容现有 UI 中的内联样式。后续如果继续收紧，需要先把内联样式迁移到 CSS class。

## 部署流程结论

### Cloudflare Workers

可以部署到 Cloudflare Workers。当前项目已经按 Workers + Static Assets + Durable Objects 结构整理：

- `wrangler.toml` 使用 `assets.directory = "./dist"`。
- `binding = "ASSETS"`，Worker 可通过 `env.ASSETS.fetch(request)` 返回静态资源。
- `run_worker_first = ["/ws*", "/api/*"]`，只有 WebSocket 和 API 先进入 Worker，普通静态资源优先走 Assets。
- `durable_objects` 绑定和 migration 已配置。
- `npm run deploy` 已改为先 `npm run build`，再 `wrangler deploy`。

一键部署按钮也已修正为 Cloudflare 官方按钮格式：

```md
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shuaiplus/NodeCrypt)
```

注意：一键部署要求仓库可被 Cloudflare 访问，并且 Cloudflare 账号有 Workers、Static Assets、Durable Objects 权限。它可以减少手工步骤，但不是完全绕过账号授权和 GitHub 授权。

### Docker 自托管

Dockerfile 已改成单进程 Node 服务，不再用 Nginx 静态服务和 Node WebSocket 分离，避免路径和端口不一致。

运行方式：

```bash
docker run -d --name nodecrypt -p 8088:8088 ghcr.io/shuaiplus/nodecrypt
```

访问：

```text
http://localhost:8088
```

### 本地运行

```bash
npm install
npm run build
node server/server.js
```

默认监听：

```text
http://127.0.0.1:8088
```

## 依赖审计

已执行根项目和 `server/` 的依赖审计：

- 根项目 `npm audit --json`：0 个漏洞。
- `server/` `npm audit --json`：0 个漏洞。

当前仍有 3 个大版本过时项：

| 包 | 当前版本 | latest | 处理建议 |
| --- | ---: | ---: | --- |
| `vite` | 6.4.3 | 8.1.3 | 暂缓，需统一 Node >= 22.12 后单独迁移验证 |
| `cssnano` | 7.1.9 | 8.0.2 | 暂缓，Node engine 要求更高 |
| `@dicebear/core` | 9.4.3 | 10.3.0 | 暂缓，需与 `@dicebear/micah` 兼容性一起验证 |

本项目 `package.json` 已声明 `node >=22.0.0`。当前机器本地 Node 是 `v20.15.1`，构建可以通过，但正式 Cloudflare 构建和 Docker 构建建议使用 Node 22。

## 验证结果

已执行：

```bash
node --check server/server.js
node --check /tmp/nodecrypt-worker-check.mjs
npm run build
npm audit --json
cd server && npm audit --json
npm outdated --json
cd server && npm outdated --json
curl --noproxy '*' -sS -i http://127.0.0.1:8088/api/health
curl --noproxy '*' -sS -i http://127.0.0.1:8088/api/does-not-exist
curl --noproxy '*' -sS -i http://127.0.0.1:8088/ws
```

结果：

- `server/server.js` 语法检查通过。
- Worker 作为 ESM 语法检查通过。
- Vite 生产构建通过，转换 58 个模块。
- 根项目和 `server/` 依赖审计均为 0 漏洞。
- `/api/health` 返回 200 和安全响应头。
- 未知 `/api/*` 返回 404。
- `/ws` 非 Upgrade 请求返回 426。
- 双客户端 V2 E2EE smoke test 通过：
  - Alice 和 Bob 均能看到成员列表。
  - 后进入成员先显示临时 peer 名称，收到 profile 后更新真实用户名。
  - Alice 收到 Bob 的 `hi`。
  - Bob 收到 Alice 的 `hello`。
- 同 `clientId` 重连测试通过：
  - 旧连接关闭。
  - 新连接仍保留在成员列表。
  - 没有 WebSocket 错误。

## 剩余风险

这些风险符合“临时聊天”定位，但需要明确：

- Web 端到端加密无法防止部署方投递恶意前端 JavaScript。生产环境需要可信构建、版本锁定和发布审计。
- 没有强身份认证。安全码只能帮助人工核对当前临时会话，不等同于长期身份。
- 拿到房间名和密码的人都能加入。分享链接应只发给可信对象。
- 弱房间名和弱密码仍可能被猜测。建议使用不易猜的房间名和密码。
- 当前没有离线消息、历史消息和消息持久化；刷新或掉线后历史不可恢复。
- 当前协议是 pairwise fanout，大群组会线性放大加密和转发成本；适合小规模临时会话。
- Cloudflare 侧仍建议配合 WAF、Bot 管理或 Turnstile 做滥用控制，尤其是公开部署后。

## 后续优化建议

1. 增加 Playwright E2E：两个浏览器加入同房间，覆盖文本、图片、文件、私信、成员重连。
2. 增加协议测试向量：固定 room/password/ECDH key，验证 roomId、pairKey、AAD、nonce 和 AES-GCM 解密。
3. 把剩余内联样式迁移到 CSS class，再收紧 CSP，移除 `style-src 'unsafe-inline'`。
4. 统一 Node 到 `>=22.12.0` 后迁移 Vite 8 和 cssnano 8。
5. 如果后续需要更大房间，设计 sender-key 或 MLS 风格群组密钥，减少 pairwise fanout 成本。
