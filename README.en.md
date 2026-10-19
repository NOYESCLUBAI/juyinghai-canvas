# Juyinghai · 剧影海

[简体中文](README.md) | **English**

A local AI storytelling canvas for scripts, images, and videos. Organize ideas as connected cards, manage projects and assets, and work with an assistant that proposes canvas edits for your approval.

Repository: https://github.com/NOYESCLUBAI/juyinghai-canvas

The product name is Juyinghai (剧影海). Internal storage and protocol identifiers keep the previous `mjh` prefix so existing browser data and configs keep working: `localStorage` keys (`mjh.*`), the IndexedDB database name (`manjinhai-canvas-media`, plus the older `manlinghai-canvas-media`), the project backup format id (`manjinhai-project`, `.mjh.json`), and `MJH_*` environment variables. Import also accepts `juyinghai-project`. These identifiers are not the user-facing name.

The application interface is currently in Chinese. This document provides English setup and usage instructions.

## What is included

- Text, image, and video cards on an infinite canvas, with reference connections.
- Card dragging, trackpad panning, layout arrangement with preview and restore, and grid snapping.
- Project search, sorting, duplication, favorites, cover images, and a recoverable trash view.
- Automatic project asset history and a global asset library populated through explicit saves.
- Image and video preview, download, and reuse of project assets on the canvas.
- AI-assisted writing and canvas planning, plus local tools that work without model calls.
- Project backup and import, including media.
- Optional Supabase email authentication and profile settings.

This release runs locally. It does **not** include cloud project synchronization, team collaboration, billing, or a hosted service. The local API is not a public multi-tenant backend; do not expose it directly to the Internet.

## Quick start

### Requirements

- macOS or Linux; use WSL on Windows.
- Node.js 20.19+ or 22.12+.
- Python 3.10+.
- Internet access to install dependencies and, optionally, call model providers.

```bash
git clone https://github.com/NOYESCLUBAI/juyinghai-canvas.git
cd juyinghai-canvas
npm run setup
npm run dev
```

Open **http://127.0.0.1:5173**. The backend runs at **http://127.0.0.1:3012**, with API documentation at `/docs`. Press **Control + C** in the terminal to stop both services.

Setup creates `.venv`, installs Python and npm dependencies, and copies `.env.example` to `.env` only if `.env` does not exist. It automatically looks for a supported Python interpreter. You can specify one explicitly:

```bash
MJH_PYTHON=python3.12 npm run setup
```

The development launcher waits for the backend health check before starting the frontend. If either process exits, it stops the other. It does not silently choose another frontend port. To use different ports:

```bash
MJH_API_PORT=13012 MJH_WEB_PORT=15173 npm run dev
```

`npm run dev:web` starts only the frontend.

## Connect your own models

You can use the local canvas without Supabase or a model API key. AI generation requires your own provider credentials and available quota; this repository does not provide shared credits.

Open **模型** (Models) in the canvas toolbar:

1. Use **设置 Agnes 连接** (Set up Agnes connection) to configure the built-in Agnes models.
2. Or choose **添加模型** (Add model), then enter a display name, protocol, API base URL, API key, and model ID.
3. Select the configuration in the relevant generation panel or Agent panel.

Multiple configurations can use the same model ID. Leaving the key blank when editing preserves the existing key. Deleting a selected configuration requires selecting another one; the application does not silently fall back to a different provider.

Supported integrations:

| Capability | Protocol |
| --- | --- |
| Text and Agent planning | Chat Completions |
| Image generation | Agnes and OpenAI-compatible image APIs |
| Video generation | Agnes v2.0 and 2.5 Flash text-to-video APIs |

Other video providers require an adapter, not just a different model name. Default model IDs are `agnes-2.5-flash` for text, `agnes-image-2.1-flash` for images, and `agnes-video-v2.0` for video. Provider availability and pricing can change; check your provider before generating.

Model credentials are stored by the local backend in `.local/model-configs.json`, with atomic writes and file permissions of `0600`. Environment configuration in `.env` is also supported. The browser persists configuration selections rather than model API keys. Do not share `.local` or your environment files.

**测试连接** (Test connection) checks the provider's model catalog without creating a generation task. A reachable catalog does not prove that generation will succeed. Providers without a catalog endpoint are verified when generating.

## Create on the canvas

### Images

Select an image card to open its generation panel. It supports prompt optimization, text/image references, aspect ratio, resolution, style and camera settings, and batches of 1, 2, or 4 images. The first result fills the selected card; additional results create cards to its right.

The Agnes image adapter passes reference images as Data URIs through `extra_body.image` in JSON `/images/generations` requests. The OpenAI-compatible adapter uses multipart `/images/edits` for reference-image editing. Compatibility depends on the selected provider.

### Videos

Select a video card to open the video generation panel. The current workflow supports text-to-video, aspect ratio selection, 5- or 10-second durations, and 720p output. The backend submits an asynchronous provider task, polls it, and returns the resulting video to the browser. You can also upload a local video, replace it, or download it.

First-frame and reference-image video generation are not included in this release.

### Canvas Agent

The Agent offers two modes:

- **AI 模型** (AI model): calls the selected text model to read the current canvas and propose scripts, storyboards, or canvas operations.
- **本地工具** (Local tools): performs rule-based reading, arrangement, duplication, editing, and card creation without calling a model. Text splitting preserves the original text; it is not AI writing.

Proposed modifications show a plan and text preview first. Click **确认执行** (Confirm execution) to apply them. Splitting preserves the source card and adds reference connections. Applied plans can be undone as a unit, subject to subsequent edits. Stale plans are rejected rather than overwriting newer work. Failed AI requests report errors instead of silently executing local alternatives.

Current AI planning limits: up to 40 cards, prioritizing selected cards; the first 6,000 characters per card; and up to 8 newly created or duplicated cards per plan. Agent conversations are not persisted. The Agent can create media placeholders, but media generation is initiated separately from the card panel.

## Projects, assets, and storage

The home page supports creating, renaming, copying, searching, sorting, favoriting, and restoring projects. Each project stores its episode canvases, nodes, connections, media references, and viewport. The trash is recoverable and does not delete media files.

Generated and uploaded media are kept in the project's asset history. Saving an asset to the global library is an explicit action. Project assets can be placed back onto the canvas.

Project metadata is stored in browser `localStorage`; media and asset records are stored in IndexedDB. Data is organized by account when optional login is enabled, but this is local organization, not server-side access control. Signing in on another device does **not** synchronize projects. Clearing browser site data can delete your local work.

### Back up and restore

- In the home page project menu, choose **导出项目备份** (Export project backup) to download a `.mjh.json` file.
- Choose **导入项目备份** (Import project backup) at the top of the home page to restore it as a separate copy.

Backups include episode canvases, text, connections, covers, images/videos, and project asset history. They exclude account credentials, model keys, Agent conversations, and global-library saved status. Assets that exist only in the global library should be downloaded separately.

Imports use new project and media IDs and do not overwrite existing projects. Missing media prevents a supposedly complete backup from being exported. The current backup limit is **100 MB per file**; Base64 encoding makes backups larger than the original media. Store backups safely and export before clearing browser data.

## Optional email login

Local creation does not require an account. To enable email registration, sign-in, and profile settings, create your own Supabase project and configure `.env.local`:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

Configure the Site URL and allowed redirect URLs for your local address in Supabase, and configure an email provider for registration and password-reset messages. Keep email verification enabled. Restart Vite after changing environment files.

Only a public publishable key belongs in the frontend. Never place a Supabase secret/service-role key, model key, or SMTP credential in a `VITE_` variable.

Profiles support a nickname, animal emoji avatar, password settings, and copying existing guest projects into the current account while keeping the originals. Optional authentication does not add cloud project storage.

## API overview

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Backend health and configuration status |
| `POST /api/chat` | Text generation and Agent planning |
| `POST /api/images/generate` | Image generation and reference-image editing |
| `POST /api/videos/generate` | Text-to-video generation |
| `GET/POST /api/model-configs` | List/create model configurations |
| `PUT/DELETE /api/model-configs/{id}` | Update/delete a configuration |
| `PUT /api/model-configs/agnes` | Configure the shared Agnes connection |
| `POST /api/model-configs/{id}/test` | Test catalog connectivity |

Generation requests accept `model_config_id`, which takes precedence over the legacy `model` field. A task reads its configuration when it starts; later configuration changes do not alter that in-flight request.

## Development and verification

```bash
npm run build
npm run test:agent
npm run test:projects
npm run test:tidy
npm run test:backup
node scripts/test-agent.mjs tests/modelConfigs.test.ts
node scripts/test-agent.mjs tests/accountStorage.test.ts
.venv/bin/python -m unittest discover -s backend -p 'test_*.py'
```

With the development server running, `/tests/backup.html` provides a browser-based backup round-trip check in isolated test storage. Automated tests do not replace live generation checks with your own provider.

The source package was independently installed and built on macOS, and local canvas editing/persistence was checked in a browser. Real provider generation was not rerun during the release-preparation checks. Cross-device cloud sync, collaboration, billing, audio nodes, and final video composition are not implemented.

`npm run package:source` produces a local source ZIP using an allowlist, excluding private configuration and installed dependencies. It does not publish anything. See the [release checklist (Chinese)](docs/open-source-release.md).

## License

Licensed under **AGPL-3.0-only**. See [LICENSE](LICENSE) for the full terms and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency license information.
