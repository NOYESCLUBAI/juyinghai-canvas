# 漫金海海外邀请内测部署

这份说明给不熟悉云平台的仓库所有者。目标是把现有画布放到海外服务器上，只邀请指定邮箱使用。当前决定是：**先不办理中国 ICP 备案**。本文不判断这个决定是否符合某一司法辖区的法律；邀请中国境内用户访问、或站点实际面向中国境内提供服务，仍可能触发备案、生成式人工智能标识等义务。上线前请自行向顾问确认，清单第 5 节没有因为这是内测而自动消失。

不要把下面任何密钥发到聊天、工单或 git。`.env.example` 里标了「公开」和「密钥」。

## 1. 这次部署由哪几块组成

| 部分 | 建议 | 原因 |
| --- | --- | --- |
| 账号与数据库 | Supabase（Auth + Postgres + 私有 Storage） | 前端已经用 Supabase 邮箱登录。表结构和桶策略在 `supabase/migrations/`。 |
| 后端 | Render 上的 Docker Web Service | 控制台创建即可，认 `Dockerfile`，健康检查填 `/livez`，不用装 CLI。视频任务在这个进程里轮询，必须常开。 |
| 前端 | Cloudflare Pages 静态站点 | 免费计划允许商用静态站点，带宽按官方文档不按配额计。构建命令 `npm run build`，输出目录 `dist`。 |
| 域名 | 你自己的域名，前端和 API 可以不同子域 | API 跨域时设置 `VITE_API_BASE` 和 `MJH_PUBLIC_ORIGINS`。 |

没有选择 Render 免费实例：空闲 15 分钟会休眠，进程内的视频轮询会停，本地磁盘也不保留。也没有把 Vercel Hobby 当作主方案：官方写明 Hobby 仅限个人、非商业使用，邀请其他人使用通常不符合。若你已有允许商用的 Vercel 方案，可以用 `deploy/vercel.rewrite.example.json` 把 `/api` 反代到 Render，这时 `VITE_API_BASE` 留空。

前端使用 hash 路由（`/#/projects`），Cloudflare Pages 不需要 SPA 回退规则。

## 2. 费用（核对日期 2026-10-19）

价格会变。以下只转述当天公开页面，不含税，也不是报价。

| 项目 | 内测建议 | 当天页面上的数字 | 来源 |
| --- | --- | --- | --- |
| Supabase | 先用 Free 试通；项目一周无活动会被暂停，正式邀请改 Pro | Free：$0，最多 2 个活跃项目，500 MB 数据库/项目，1 GB 文件存储，未缓存出口 5 GB + 缓存出口 5 GB，50,000 MAU，单文件上传 50 MB。Pro：组织 $25/月起，8 GB 磁盘/项目（超出 $0.125/GB），文件存储 100 GB（超出 $0.0213/GB），出口各 250 GB（未缓存超出 $0.09/GB，缓存超出 $0.03/GB），单文件可达 500 GB | https://supabase.com/pricing ；https://supabase.com/docs/guides/platform/billing-on-supabase ；https://supabase.com/docs/guides/platform/manage-your-usage/egress ；https://supabase.com/docs/guides/platform/manage-your-usage/storage-size |
| Render 计算 | 邀请内测用 1 CPU / 2 GB（$25/月）。视频字节会经过这个进程。只有很短的视频才考虑 $7/月的 512 MB | 实例：Free $0 / 512 MB；不到 1 CPU $7/月 / 512 MB；1 CPU $25/月 / 2 GB。Free 实例 15 分钟无入站流量后休眠，唤醒约 1 分钟；每工作区每月 750 免费实例小时；磁盘临时 | https://render.com/pricing ；https://render.com/docs/free |
| Render 工作区流量 | Hobby 工作区即可起步，留意出口 | 2026-04-23 公告、2026-08-01 起生效：超出部分按 $0.15/GB（公网）。工作区包含量以 https://render.com/docs/outbound-bandwidth 为准（当天 Hobby 5 GB、Pro 25 GB）。入站不计费。绑了支付方式才会按超量扣款，否则服务会被停到下月 | https://render.com/blog/better-pricing-for-fast-growing-teams ；https://render.com/docs/outbound-bandwidth |
| Cloudflare Pages | Free | $0。静态资源请求和带宽官方写明不限。500 次构建/月，同时 1 个构建，单文件 25 MiB，每站点 20,000 个文件，每项目 100 个自定义域。页面更新日期 2026-09-05 | https://developers.cloudflare.com/pages/platform/limits/ ；https://developers.cloudflare.com/pages/functions/pricing/ |
| Vercel（备选，不是主方案） | 商用用 Pro | Hobby $0，仅个人非商业；Fast Data Transfer 100 GB/月，CDN 请求 100 万/月，超出后暂停而不是加价。Pro $20/月起 | https://vercel.com/docs/plans/hobby ；https://vercel.com/pricing ；https://vercel.com/docs/limits/fair-use-guidelines |
| Agnes | 用户自备密钥 | 本仓库不代付模型费用。用户在「模型」里保存自己的连接。 | — |

邀请内测的平台底价大约是：Supabase Free（$0，有暂停和 50 MB 上传限制）+ Render 2 GB（$25/月）+ Cloudflare Pages（$0）。改成 Supabase Pro 后大约 $50/月起，再加两边的出口流量。一次视频会先从 Agnes 进 Render，再进 Supabase，用户观看时再从 Supabase 出去，所以 Render 出口和 Supabase 出口都会涨。

## 3. 创建 Supabase 项目

1. 打开 https://supabase.com/dashboard ，用你自己的账号新建项目。区域选离邀请用户较近的海外区域（例如新加坡或美西）。记下数据库密码，丢了要到控制台重置。
2. **Project Settings → API** 复制：
   - Project URL → 同时填 `SUPABASE_URL` 和 `VITE_SUPABASE_URL`
   - `anon` / publishable key → 只填 `VITE_SUPABASE_PUBLISHABLE_KEY`（公开）
   - `service_role` key → 只填后端 `SUPABASE_SERVICE_ROLE_KEY`（密钥）
3. **Project Settings → API → JWT**。如果能看到 JWT Secret，填到 `SUPABASE_JWT_SECRET`。如果项目只提供 JWKS，把 `SUPABASE_JWKS_URL` 设为 `https://<项目>.supabase.co/auth/v1/.well-known/jwks.json`（不填时后端会按 `SUPABASE_URL` 拼这个地址）。`SUPABASE_JWT_AUD` 保持 `authenticated`。
4. **Project Settings → Database → Connection string**。选 URI，用 Session pooler 或直连均可。把密码换进去，整串填到 `SUPABASE_DB_URL`。不要打开「把连接串交给前端」。

### 3.1 跑迁移

在 **SQL Editor** 里按顺序整段执行：

1. `supabase/migrations/20261019120000_phase1_cloud.sql`
2. `supabase/migrations/20261019120100_storage.sql`

第二段依赖 Supabase 自带的 `storage` 模式。执行后应看到私有桶 `manjinhai-media`（Public 关闭）。对象键形状是 `{用户 id}/{素材 id}`。

这两段都是新增表和策略。不要为了「重来一次」去 drop 已有用户数据。

### 3.2 关掉公开注册

**Authentication → Providers → Email**：

- 打开 Email。
- 关掉 **Enable sign ups**（公开注册）。内测用户由你在 **Authentication → Users → Add user** 里创建，或只给你已经发出的邀请链接。
- 建议打开邮箱确认。后端不代替这道开关。

服务器另有一道邀请名单，两道都要做。只关前端按钮不够，因为有人可以直接打 Supabase Auth API。

### 3.3 邀请名单

任选一种，或两种一起用（命中任一即放行）：

- 后端环境变量 `MJH_INVITE_ALLOWLIST`：逗号分隔的小写邮箱，或 Supabase 用户 UUID。没有通配符。空名单不会变成「允许所有人」。
- 表 `public.invite_allowlist`，在 SQL Editor 执行：

```sql
insert into public.invite_allowlist (email) values ('friend@example.com');
```

这张表没有给登录用户开 RLS 策略，浏览器用 anon key 读不到。取消邀请就删掉这一行，或从环境变量里去掉邮箱后重新部署后端。

## 4. 准备后端密钥

在你自己的电脑上生成加密密钥（不要把输出贴到 git）：

```bash
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

没有该库时，先 `pip install cryptography`。把输出填进 `MJH_CONFIG_ENCRYPTION_KEY`。换一把新钥匙后，用户以前保存的模型密钥全部无法解密，需要他们重新填写。

确认 `MJH_ALLOW_MEMORY_STORE` 不是 `true`。`render.yaml` 里已经写成 `false`。

## 5. 部署后端（Render）

1. https://dashboard.render.com 用 GitHub 登录，选这个仓库和要发布的分支。
2. New → Web Service，Runtime 选 Docker。Render 会读仓库根目录的 `Dockerfile` 和 `render.yaml`。
3. Health Check Path 填 `/livez`。它只返回 `{"ok": true}`，不暴露模型或配置。
4. Instance type 选 **1 CPU / 2 GB（$25/月）**。不要选 Free。
5. Environment 里逐项粘贴 `.env.example` 中「密钥」一节，以及 `MJH_HOSTED=true`。`MJH_PUBLIC_ORIGINS` 填前端最终源站，例如 `https://app.example.com`，多个用逗号。不要填 `*`。
6. 本地开发用的 `MJH_LLM_API_KEY`、`MJH_IMAGE_API_KEY`、`MJH_VIDEO_API_KEY` **不要**配进公开站点。托管模式拒绝没有 `model_config_id` 的生成请求，也不会用这三把钥匙兜底。
7. 部署完成后打开 `https://<服务名>.onrender.com/livez`，应看到 `{"ok": true}`。再打开 `/api/health`，托管模式只应看到 `{"status":"ok"}`。不带登录令牌访问 `/api/chat` 应是 401。

`Dockerfile` 监听 `0.0.0.0` 和平台给的 `PORT`。本机 `npm run api` 仍绑定 `127.0.0.1`。

## 6. 部署前端（Cloudflare Pages）

1. https://dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git。
2. Framework preset：Vite。Build command：`npm run build`。Build output directory：`dist`。
3. 构建环境变量（公开，会进静态文件）：

```
VITE_MJH_HOSTED=true
VITE_API_BASE=https://<服务名>.onrender.com
VITE_SUPABASE_URL=https://<项目>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable key>
VITE_SOURCE_URL=https://github.com/NOYESCLUBAI/manjinhai-canvas/tree/<这次部署的 commit 或 tag>
VITE_APP_VERSION=<同一次 commit 的短哈希或版本号>
```

`VITE_API_BASE` 不要末尾斜杠。改这些变量后必须重新构建，只改后端不会更新已经发出去的网页。

4. 部署完成后用浏览器打开 Pages 给的 `*.pages.dev` 地址。页脚应有「源码 AGPL-3.0」，链到上面的 `VITE_SOURCE_URL`。
5. 自定义域：Pages 项目 → Custom domains，按提示把域名 CNAME 到 Pages。然后把 `MJH_PUBLIC_ORIGINS` 改成这个 https 源站并重新部署后端，同时把 `VITE_API_BASE` 保持指向 API。Supabase **Authentication → URL configuration** 里把 Site URL 和 Redirect URLs 改成同一个前端源站。

同域反代（可选）：把 `deploy/vercel.rewrite.example.json` 里的主机名换成 Render 主机，合并进 `vercel.json`，`VITE_API_BASE` 留空。Render 侧的 `MJH_PUBLIC_ORIGINS` 仍要包含网页源站。

## 7. 邀请一个用户并自己试一遍

1. Supabase 里创建用户，并把邮箱写入邀请名单。
2. 打开站点，用该邮箱登录。未登录时不能生成。
3. 打开「模型」，新增一条 Agnes 连接并填写**用户自己的**密钥。列表里只应显示「已配置」，刷新后密钥框为空；留空保存应保留旧密钥。点测试，只测试当前账号的配置。
4. 用第二个不在名单里的邮箱（若你暂时打开了注册）登录，应看到 403，且看不到第一个人的项目和密钥。
5. 生成一张图。图应出现在画布上，节点带有素材 id，Supabase Storage 里能看到 `{用户 id}/{素材 id}`。
6. 生成一段视频。请求应马上回到任务 id，画布继续可操作。完成后视频写入素材库。点「停止等待」后任务变为已取消，界面写明已提交的视频可能仍会计费。
7. 换一台浏览器登录同一账号，应看到同一批项目。模型下拉框的「当前选中项」存在这台浏览器本地，自定义配置要重新选一次。
8. 在登录前的本机库里准备一个项目，登录后点「把本机项目上传到云端」。云端应出现新副本，本机原件还在。用 `.mjh.json` 导入时标题带「（导入）」，素材逐个上传。

本地 `npm run dev` 且不设 `MJH_HOSTED` / `VITE_MJH_HOSTED` 时，行为与现在的单机版相同：项目在浏览器里，密钥可以继续用本机 `.env`。

## 8. 回滚

- **网页**：Cloudflare Pages → Deployments，对上一个成功部署点 Rollback。Vercel 则在 Deployments 里 Promote 上一版。
- **API**：Render → 该服务 → Events，Rollback 到上一个成功部署。回滚不会清空 Supabase。
- **数据库**：这两份迁移只加表和策略。回滚代码时不要 drop 表，否则项目和已加密密钥会丢。桶里的文件也要单独删，删代码不会删文件。
- **加密密钥**：回滚代码没问题，回滚或更换 `MJH_CONFIG_ENCRYPTION_KEY` 会让已存密钥解不开。
- **停机**：把 `MJH_INVITE_ALLOWLIST` 清空并重新部署，所有人都会 403。Supabase 里也可以暂时关掉 Email 登录。

## 9. 和正在并行开发的 Agent P0 怎么接

P0 会在浏览器里用 Vercel AI SDK，并经过一个注入密钥的 FastAPI 兼容接口。请直接复用：

- `backend.auth.current_user`：本地返回空，托管模式要求邀请名单内的用户。不要从请求体里信任 user id。
- `backend.model_access.resolve_model_config`：托管模式必须传入该用户自己的文本 `model_config_id`，解析出的密钥只存在于进程内。不要读 `MJH_LLM_API_KEY`。

会话：单机继续用 `localStorage` 的 `mjh.agentSessions.v1`。托管模式改走 `GET/PUT /api/agent-sessions`（`src/agent/sessionCloud.ts`），一行对应一个用户 + 项目 + 画布。P0 的视频以后要消费任务 id，不要假设 `/api/videos/generate` 直接返回 mp4。文本控制台的 `/api/chat` 仍返回完整 JSON。

## 10. 已知限制

- 视频工人跑在 API 进程里。Render 重新部署时，已写入的上游 `video_id` 会在新进程里继续轮询；若实例休眠超过任务截止时间（默认 420 秒），任务会失败。
- 默认单文件 45 MB。Supabase Free 的上传上限是 50 MB，更长的视频要升到 Pro 并调高 `MJH_MEDIA_MAX_BYTES`。
- `.mjh.json` 在托管模式下浏览器仍会整份解析，上限 512 MB；真正发给 API 的是拆开的项目 JSON 和逐个素材。
- 取消视频只停止等待和标记任务，不能保证 Agnes 侧不计费。
- 日志会去掉 Bearer、密钥字段、data URL 和带签名的查询串，但仍不要把原始请求体贴进第三方日志平台。
