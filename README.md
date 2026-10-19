# 漫金海

**简体中文** | [English](README.en.md)

漫金海是一个以文字剧本为核心的 AI 漫剧画布。当前 MVP 支持文字生成、图片生成、视频素材卡片，以及可以读取并操作画布的 AI 助手。

## 开源版本定位

当前是本地运行版：画布、项目管理、项目资产、全局资产、Agent 和模型接入共用一套应用。项目和媒体保存在当前浏览器，模型密钥保存在本机后端。未提供云同步、团队协作或计费服务，请勿将本机 API 直接暴露到公网。

## 独立运行

支持 macOS / Linux；Windows 请使用 WSL。需要 Node.js 22+、Python 3.10+，以及安装依赖所需的网络连接。画布 Agent 使用的 AI SDK 7 以 Node.js 22 为下限，20.x 无法复现这套依赖。

```bash
npm run setup
npm run dev
```

安装脚本创建 `.venv`、安装前后端依赖，首次复制 `.env.example`；不会覆盖已有 `.env`。浏览器打开 http://127.0.0.1:5173，API 为 http://127.0.0.1:3012。用 `Control + C` 停止。端口占用时先关闭原服务，或设置 `MJH_API_PORT`、`MJH_WEB_PORT`。

不配置 Supabase 也能使用本机画布。在画布「模型」里填写自己的模型 API 地址、Key 和模型 ID 后才能使用对应 AI 生成；不附带共享额度。可选邮箱登录需自行创建 Supabase 项目，在 `.env.local` 配置 `.env.example` 中两个公开前端变量，并在服务后台配置本站回跳地址与邮件服务。禁止把服务端密钥放入 `VITE_` 变量。

## 项目备份

首页项目菜单选择「导出项目备份」，下载 `.mjh.json` 文件；首页右上角「导入项目备份」恢复为独立副本，不覆盖现有项目。备份包含分集画布、卡片、连线、封面、图片/视频与该项目的历史素材，不包含账号、模型密钥、Agent 对话或全局资产收藏状态。

单份备份上限 100 MB（媒体以 Base64 存储，文件会大于原素材）。备份中包含创作内容，请自行妥善保存；清理浏览器数据前先备份。跨浏览器或设备使用需手动导入，登录不会自动同步。

## AI API

漫金海只在后端保存模型密钥，浏览器不直接访问模型服务。前端始终调用统一的 `POST /api/images/generate`；FastAPI 根据选中的模型配置选择供应商协议，旧请求仍兼容 `.env` 设置。Agnes 的文生图和图生图都采用 JSON `/images/generations`，参考图放在 `extra_body.image`；标准 OpenAI 供应商的参考图则采用 multipart `/images/edits`。视频生成采用 Agnes AI 异步 `/videos` 接口，由后端创建任务、轮询结果并把最终 MP4 返回给浏览器。

Agnes 图片适配以官方的 [Image 2.5 Flash 文档](https://agnes-ai.com/zh-Hans/docs/agnes-image-25-flash)、[Image 2.1 Flash 文档](https://agnes-ai.com/zh-Hans/docs/agnes-image-21-flash) 和 [Image 2.0 Flash 文档](https://agnes-ai.com/zh-Hans/docs/agnes-image-20-flash) 为准。2.5 Flash 与 2.1 Flash 的请求协议相同：JSON `/images/generations`，用分辨率档位 `size` 配合 `ratio`，参考图放在 `extra_body.image`；文生图要 Base64 时同时发送 `return_base64`。

| 接口 | 用途 | 输入 | 输出 |
| --- | --- | --- | --- |
| `GET /api/health` | 查看项目和可选文字模型 | 无 | 项目、默认模型、模型列表、配置状态 |
| `POST /api/chat` | 文字生成（文字控制台） | `prompt`，可选 `system`、`model` | `text`、实际模型 |
| `POST /api/agent/chat/completions` | 画布 Agent 的 Chat Completions 转发 | `messages`、`tools`、`tool_choice`，可选 `stream`；模型可用请求头 `X-MJH-Model-Config` | 上游原始响应（含 `tool_calls`）。错误正文不含密钥 |
| `POST /api/images/generate` | 图片生成与参考图编辑 | 提示词、模型、比例、清晰度、风格、摄影机、数量、引用内容 | 图片 data URL、实际模型 |
| `POST /api/videos/generate` | 文字生成视频 | 提示词、模型、比例、时长 | MP4 视频 |

文字默认选择 `agnes-3.0-flash`，图片默认选择 `agnes-image-2.5-flash`，视频默认选择 `agnes-video-2.5-flash`。用户可选择内置模型或添加自定义模型配置；后端不进行自动回退，所选模型不可用时直接返回错误，原卡片内容保持不变。已保存的旧模型 ID（包括已下架的 `agnes-video-v2.0`）仍会解析到对应内置配置，不会被清空。

图片服务支持 Agnes 与 OpenAI 兼容协议；文字支持 Chat Completions。视频默认使用 Agnes Video 2.5 Flash 的异步 `/videos` 文生视频协议（`seconds`、`mode`、`size: "720P"`、`aspect_ratio`），完成后优先读取任务结果顶层 `url`。付费的 `agnes-video-2.5` 使用同一套请求；已下架的 `agnes-video-v2.0` 仍走原来的 `width` / `height` / `num_frames` 格式。其他视频平台需要增加对应适配器，不能只替换模型名称。

## 模型管理

画布顶部点击「模型」：

- 「设置 Agnes 连接」统一填写内置 Agnes 模型的地址和 Key；国际站与其他站点需使用对应的 Key。
- 各分类的「添加模型」填写名称、接口类型、API 地址、Key、模型 ID。支持多个连接使用相同模型 ID，按配置独立切换。
- 编辑时 Key 留空保留原密钥。删除当前配置后需重新选择模型，不自动回退。
- 模型配置与 Key 写入本机 `.local/model-configs.json`，原子保存、文件权限 `0600`，不写入 `.env`。该文件被排除版本管理，不要随项目分享；浏览器只持久化配置选择，不保存 Key。
- 「测试连接」只读取上游模型目录，不创建生成任务。目录可达不等于生成成功；没有目录接口时显示「生成时验证」。
- 内置目录按 2026-10-18 的 [Agnes 官方定价](https://www.agnes-ai.com/zh-Hans/docs/pricing) 标注。当前免费：文字 `agnes-3.0-flash`、`agnes-2.5-flash`；图片 `agnes-image-2.0-flash`、`agnes-image-2.1-flash`、`agnes-image-2.5-flash`。视频 `agnes-video-2.5-flash` 限时免费（仅 720P）。付费：`agnes-2.5-pro`、`agnes-2.5-pro-beta`、`agnes-video-2.5`。`agnes-3.0-pro` 即将上线且为付费。`agnes-video-v2.0` 已不在定价页，目录中保留并标为已下架。实际费用以平台账单为准。

配置接口：`GET/POST /api/model-configs`、`PUT/DELETE /api/model-configs/{id}`、`PUT /api/model-configs/agnes`、`POST /api/model-configs/{id}/test`。生成接口均支持 `model_config_id`（优先于旧 `model`），仅在任务开始时读取该配置，之后修改配置不影响进行中的请求。

`npm run dev` 等待后端健康检查通过再启动前端，并在任一进程退出时停止另一进程。后端仅启用 HTTP，避免加载不需要的 WebSocket 依赖。前端端口被占用会直接提示，不自动换地址。需要其他端口可设置 `MJH_API_PORT` 和 `MJH_WEB_PORT`；用 `Control + C` 停止。只运行 `npm run dev:web` 不会启动后端。

模型列表读取失败后会有限重试，重新打开模型管理或点击「重新连接」也会刷新。界面分别显示本机后端未连接、未配置 Key、已配置未验证和上游错误。

验证命令：`npm run build`、`npm run test:agent`、`node scripts/test-agent.mjs tests/modelConfigs.test.ts`、`.venv/bin/python -m unittest discover -s backend -p 'test_*.py'`。

## 图片卡片

- 创建或选中图片卡片后，画布底部打开图片生成控制台。
- 支持提示词优化、引用画布文字/图片、比例、清晰度、风格、摄影机和 1/2/4 张批量生成。
- Agnes 参考图会由后端以 Data URI 放入 `extra_body.image`，不要求本机图片先上传为公网 URL。
- 第一张结果写入当前卡片，其他结果在右侧创建新图片卡片。
- 生成图片保存在当前浏览器的 IndexedDB，画布数据保存在 `localStorage`；清除浏览器站点数据或换设备后不会自动同步。
- 图片生成可能消耗上游额度，只有用户点击生成按钮时才会调用图片服务。

## 视频卡片

- 创建或选中视频卡片后，画布底部打开视频生成控制台。
- 当前 MVP 支持文字生成视频，可选择画面比例和 5/10 秒时长，输出固定为 720p。
- 视频任务由后端异步轮询；生成完成后写入当前卡片，也可以重新生成、下载或上传本地视频替换。
- 生成视频保存在当前浏览器的 IndexedDB；清除浏览器站点数据或换设备后不会自动同步。
- 当前画布图片仅保存在本机，而 Agnes 图生视频要求公网图片 URL，因此本版暂不提供首帧和参考图生成。

## 参考画布布局与 Agent（2026-09-20）

画布按 Pavo 参考页的浅灰工作区、元素目录、浮动工具与生成面板改造，保留漫金海品牌、原有模型和浏览器存储格式。左侧可切换“画布元素 / 项目画布”，支持搜索、类型筛选、点击定位；底部支持添加文字/图片/视频节点、整理全部卡片、小地图、网格吸附及操作指南。

Agent 支持两种明确的运行模式：

- **AI 模型**：在浏览器里跑多步观察–动手循环（Vercel AI SDK 的 `ToolLoopAgent`）。模型请求只发到本机 `POST /api/agent/chat/completions`，由后端注入文字模型密钥后再转发；浏览器不保存 Agnes Key，也不走 Vercel AI Gateway。面板按步骤显示读取、创建、改字、排列等操作。删除、一次超过 8 张的新建或复制，以及图片/视频生成提案，必须点确认后才写入。生成提案只记在卡片上，不会调用 `/api/images/generate` 或 `/api/videos/generate`。超过 40 张卡片时用检索和按 id 读取，而不是把全文一次塞进提示。对话按分集保存在浏览器的 `mjh.agentSessions.v1`，不写入项目画布 `mjh.projects.v1`。
- **本地工具**：不调用模型；按规则读取、排列、复制、修改或创建卡片。拆分时按原文句段分组，保留全部原文，不替代 AI 创作。仍先展示整份计划，点「确认执行」后一次性写入。

AI 模式每一步成功写入都会进入顶部撤销栈；整轮结束还可以「撤销本轮」。若之后又有别的编辑，整轮撤销会被拒绝，以免盖掉新内容。模型失败或点停止后，已经写入的步骤保留，不会改走本地规则。单轮最多 12 步；同一工具、同一参数连续两次会停止。默认权限是「平衡」：额度内的结构修改自动执行，危险操作仍要确认。「全部确认」则每一步写入都要确认。Agent 的文字模型默认 `agnes-3.0-flash`，可以和文字控制台分开选。

当前边界：付费图片和视频生成仍从卡片面板主动发起。参考站的音频、导演台、视频合成、云资产库和计费功能不在本次范围。

验证：`npm run test:agent` 检查本地规则、多步循环、审批、冲突哈希、停止、超过 40 张卡片、生成提案和会话落盘；`npm run build` 检查类型与生产构建。浏览器验证需结合自己的模型配置进行。

## 主页与项目管理（2026-09-20）

- 默认进入「全部项目」；画布左上角漫金海 Logo 返回主页。支持继续上次创作、搜索、排序、新建、重命名、复制、收藏、选择项目图片作为封面，以及移入回收站和恢复。
- 每个项目独立保存分集画布、卡片、连线、素材引用和视口。原有 `mjh.project.v2` 项目首次自动迁入 `mjh.projects.v1` 列表，原记录保留不覆盖。
- 返回主页、浏览器后退和刷新前会立即保存；保存失败或生成任务尚未完成时阻止切换，避免静默丢失内容。复制项目重新生成画布、节点和连线标识，保留媒体引用。
- 回收站只做可恢复移除，不删除媒体文件。当前仍为本机浏览器存储；已支持资产库与项目备份导入导出，云同步尚未实现。
- `npm run test:projects` 验证迁移、复制、独立数据、回收站持久化及存储异常；`npm run test:agent` 验证已有 Agent 行为。
- 浏览器手动验收与发布限制见 `docs/open-source-release.md`。

## 开源发布准备

见 [发布检查说明](docs/open-source-release.md)。`npm run package:source` 只生成本地源码压缩包，不会上传。本项目采用 AGPL-3.0-only，协议全文见 [LICENSE](LICENSE)。
