---
name: stories-agent-publishing
description: >-
  Publish and manage blog/stories drafts for The Comma Coffee and VANIET via
  their agent APIs. Use when creating drafts, editing drafts, publishing or
  scheduling after owner approval, or unpublishing live posts back to draft on
  either site.
---

# Stories Agent Publishing (The Comma + VANIET)

Một skill cho cùng một khách — hai website, cùng quy trình draft → duyệt → publish.

## Secrets (do not commit)

Đọc credentials tại:

`.cursor/skills/stories-agent-publishing/secrets.local.env`

(Nếu thiếu: copy từ `secrets.example.env` rồi điền.) **Không** ghi token vào SKILL.md hay git.

Trên Mac mini production cũng có thể dùng bản shared:

`/Users/vsc_agent/projects/.cursor/skills/stories-agent-publishing/secrets.local.env`

| Biến | Dùng cho |
|------|----------|
| `THECOMMA_BASE_URL` | Base URL The Comma (local: `http://127.0.0.1:8765`) |
| `THECOMMA_AGENT_TOKEN` | Bearer token The Comma |
| `VANIET_BASE_URL` | Base URL VANIET (local: `http://127.0.0.1:3008`) |
| `VANIET_AGENT_TOKEN` | Bearer token VANIET |

Mỗi site có **token riêng**. Khi gọi API, chọn đúng cặp URL + token.

```http
Authorization: Bearer <SITE_AGENT_TOKEN>
Content-Type: application/json
```

## Chọn site

| Site | Public path | Author mặc định gợi ý | SEO site key |
|------|-------------|----------------------|--------------|
| The Comma | `/stories/:slug/` → `https://thecommacoffee.com/stories/...` | `The Comma Coffee` | `thecomma` |
| VANIET | `/kien-thuc/:slug/` → `https://vaniet.cloud/kien-thuc/...` | `VANIET` | `vaniet` |

Trước khi viết bài: `GET {BASE}/api/agent/categories` để lấy đúng tên chuyên mục của site đó.

## Hard rules (cả hai site)

1. **Tạo/sửa nội dung chỉ ở `draft`.** Không gửi `status: published|scheduled` trên create/PATCH.
2. **Duyệt ngoài API** (chat với chủ nhân hoặc admin UI). Sau khi được phép mới gọi `/publish`.
3. **Sửa bài đang live:** `unpublish` → sửa draft → `/publish` lại (khi được phép).
4. **Chỉ xóa draft.** Bài live phải unpublish trước.
5. Agent được CRUD **mọi draft**, kể cả bài editor viết tay.

## Status

| Status | Ý nghĩa | Sửa nội dung qua agent? | Hiện public? |
|--------|---------|-------------------------|--------------|
| `draft` | Đang chờ / đang sửa | Có | Không |
| `published` | Đang live | Không (unpublish trước) | Có |
| `scheduled` | Hẹn giờ | Không (unpublish trước) | Khi đến giờ |

**Tự động:** mỗi ~30s (server) + cron Convex 1 phút sẽ flip `scheduled` → `published` khi `scheduledAt` đã qua. The Comma đồng thời regenerate `/stories/`.

The Comma regenerate static `/stories/` khi publish/unpublish **và** khi có bài hẹn giờ đến hạn. VANIET đọc Convex trực tiếp (SPA `/kien-thuc/`).

## API (giống nhau trên cả hai site)

Base = `THECOMMA_BASE_URL` hoặc `VANIET_BASE_URL`.

### List / get

- `GET /api/agent/posts` — optional `?status=draft|published|scheduled`
- `GET /api/agent/posts/:slug`

### Create / upsert draft

`POST /api/agent/posts`

```json
{
  "title": "…",
  "slug": "optional-slug",
  "excerpt": "…",
  "content": "Markdown…",
  "category": "Tên chuyên mục đúng site",
  "tags": ["tag1"],
  "focusKeyword": "…",
  "coverImage": "/uploads/blog/….jpg",
  "author": "…",
  "dryRun": false
}
```

- Luôn lưu `draft`.
- Slug trùng draft → update; trùng published/scheduled → **409**.
- `dryRun: true` → validate + SEO, không ghi.

### Update draft

`PATCH /api/agent/posts/:slug` — partial OK; không đổi status ở đây.

### Delete draft

`DELETE /api/agent/posts/:slug`

### Publish / schedule (sau khi chủ nhân duyệt)

`POST /api/agent/posts/:slug/publish`

```json
{ "status": "published" }
```

```json
{ "status": "scheduled", "scheduledAt": "2026-08-10T09:00:00+07:00" }
```

### Unpublish → draft

`POST /api/agent/posts/:slug/unpublish`

### Helpers

- `GET /api/agent/categories`
- `POST /api/agent/seo` — body có `title` + `content` (+ optional excerpt/slug/tags/…)

## Flow gợi ý

1. Xác định site (Comma hay VANIET) → load đúng BASE + TOKEN.
2. Lấy categories → soạn draft (`dryRun` / SEO nếu cần) → `POST` draft.
3. Đưa chủ nhân duyệt (chat/admin).
4. `POST .../publish` khi được phép.
5. Muốn sửa bài live: xin phép → unpublish → PATCH → publish.

## curl

```bash
set -a
source .cursor/skills/stories-agent-publishing/secrets.local.env
set +a

# --- The Comma draft ---
curl -sS -X POST "$THECOMMA_BASE_URL/api/agent/posts" \
  -H "Authorization: Bearer $THECOMMA_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Comma","content":"## Mở đầu\n\nNội dung đủ dài cho draft.","category":"Cà phê","author":"The Comma Coffee"}'

# --- VANIET draft ---
curl -sS -X POST "$VANIET_BASE_URL/api/agent/posts" \
  -H "Authorization: Bearer $VANIET_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test VANIET","content":"## Mở đầu\n\nNội dung đủ dài cho draft.","category":"Kiến thức","author":"VANIET"}'
```

(Đổi `category` đúng tên trả về từ `/api/agent/categories` của từng site.)
