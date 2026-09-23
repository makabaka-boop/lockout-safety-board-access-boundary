# 检修隔离牌板（LOTO Isolation Board）

全栈能量隔离上锁挂牌（LOTO）作业系统：React 页面 → Fastify API → PostgreSQL。
两个 API 实例共享同一个 PostgreSQL 做**裁决**，以**单调修订号 + 行级排他锁**
防止旧页面 / 并发请求把仍挂着个人锁的设备误置为"可送电"。

> 核心安全性质：检修人员还挂着个人锁时，任何人都无法把设备复位为可送电；
> 即使两个 API 实例上"撤最后一锁"与"复位"请求同时到达，数据库事务也会把它们
> 强制串行化，**复位最多成功一次**，败方拿到的阻断项 / 终态与数据库完全一致。

## 账号（种子数据）

| 角色 | 账号 | 密码 | 权限 |
| --- | --- | --- | --- |
| 协调员 | `coord` | `coord123` | 新建作业票，指定 1–20 个隔离点与授权人员 |
| 检修人员 | `zhang` | `worker123` | 在被授权的票上确认隔离点、挂 / 撤自己唯一一把个人锁 |
| 检修人员 | `li` | `worker123` | 同上 |
| 检修人员 | `wang` | `worker123` | 同上（默认不授权，演示 FORBIDDEN） |
| 送电负责人 | `lead` | `lead123` | 仅在全部点已确认、锁数为 0、票仍在检修时复位送电 |

## 用 Docker Compose 启动

```bash
# 页面发布端口由 WEB_PORT 控制（默认 8080）
WEB_PORT=8080 docker compose up --build
# 打开 http://localhost:8080
```

服务拓扑：

- `db`：PostgreSQL 16，带健康检查；
- `verify`：**一次性服务**，等待数据库 → 执行迁移 → 播种账号 → 校验后退出
  （`service_completed_successfully`），两个 API 实例必须等它成功后才启动；
- `api-1` / `api-2`：同一个 Fastify 应用的两个实例，各自独立连接池，无任何
  进程内共享状态，只靠数据库裁决；
- `web`：nginx 托管构建好的 React 页面，并把 `/api/*` 在两个 API 实例间轮询
  （`docker/nginx.conf`）。

## 本地开发

需要一个 PostgreSQL（可用任意本机 PG，或自行运行容器）：

```bash
docker run -d --name loto-pg -e POSTGRES_USER=loto -e POSTGRES_PASSWORD=loto \
  -e POSTGRES_DB=loto -p 5432:5432 postgres:16-alpine

export DATABASE_URL=postgres://loto:loto@127.0.0.1:5432/loto
npm install
npm run migrate          # 建表
npm run seed             # 写入演示账号（幂等）
npm run dev              # Vite 页面 :5173（/api 代理到 4101）
npm run dev:api          # Fastify API :4101
# 或构建后由 API 直接托管页面：
npm run build && npm start
```

## 测试（连接真实 PostgreSQL 制造竞争）

```bash
npm test
```

测试**不使用任何假接口 / 内存数据库**：Vitest 全局装配启动一个真实的嵌入式
PostgreSQL，随后启动**两个真实 Fastify 实例**（4171 / 4172，独立连接池），
通过真实 HTTP 制造竞争：

- `test/api.test.ts`：角色鉴权、建票校验（1–20 点、授权人员）、确认、挂 / 撤锁、
  乐观修订号 409、复位阻断项与终态；
- `test/concurrency.test.ts`：两实例"撤最后一锁 × 复位"同修订号并发 10 轮、
  4 个复位并发仅 1 次成功、20 张票交错重放每张票恰好送电一次；并断言败方所见
  快照（revision / status / 锁数 / 阻断项）与数据库真值一致；
- `test/ui/ui.test.tsx`：jsdom + Testing Library 渲染真实 React 页面，所有
  `/api` 请求打到真实 Fastify + PG；覆盖旧页面收到 409 后界面自动重载到并发者
  的结果、刷新后阻断项消失、复位终态等。

## 并发正确性如何保证

1. **行级排他锁**：每个写事务的第一条语句是
   `SELECT ... FROM tickets WHERE id=$1 FOR UPDATE`。两个实例上的撤锁与复位
   因此在数据库层被强制串行，后到者在锁释放后读到的是已提交的最新状态。
2. **单调修订号（乐观锁）**：页面持有"所见修订号"，每次变更都随请求带上；
   与库中不一致即 `409 CONFLICT`，事务回滚（失败保留当前牌板），并在**稳定
   JSON 错误体**中返回 `latestRevision` 与**最新快照**，前端立即据此重载。
3. **裁决与状态翻转原子提交**：复位事务在同一把行锁内检查"全部点已确认 +
   锁数为 0 + 仍在检修"，再做带 `WHERE status='maintenance'` 条件的 UPDATE；
   判定依据快照与翻转原子提交，消除失锁更新（lost update）窗口。
4. **终态不可逆**：票进入 `energized` 后，确认 / 挂锁 / 撤锁 / 再次复位全部
   返回 `409`，阻断项固定为 `terminal`。

### 稳定错误 JSON

所有失败（鉴权、越权、并发冲突、校验）都返回：

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "页面已过期：页面修订号 1，当前修订号 3",
    "latestRevision": 3,
    "blockers": ["locks:1"],
    "snapshot": { "...": "服务端最新牌板快照" }
  }
}
```

状态码：`401 UNAUTHORIZED` / `403 FORBIDDEN` / `400 VALIDATION` /
`404 NOT_FOUND` / `409 CONFLICT` / `500 INTERNAL`。

## 目录结构

```
src/shared/types.ts      前后端共享类型与错误结构
src/server/db.ts         连接池 / 事务封装（每实例独立池）
src/server/migrations.ts PostgreSQL 表结构
src/server/board.ts      牌板裁决：FOR UPDATE 行锁 + 修订号 + 原子复位
src/server/auth.ts       JWT 登录
src/server/server.ts     Fastify 路由与稳定 JSON 错误
src/server/verify.ts     compose 的一次性迁移/播种/校验服务
src/web/                 React 页面（登录、建票、牌板、过期自动重载）
test/                    真实 PG + 双实例 + jsdom 界面测试
docker-compose.yml       db / verify(一次性) / api-1 / api-2 / web(WEB_PORT)
docker/nginx.conf        /api 在两个实例间轮询
```
