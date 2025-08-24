## Problem / Context

Loading the database list blocks the popup for several seconds (hundreds of DBs). We also want to persist per‑DB custom instructions and avoid re‑deriving Notion schemas on every save.

## Goals
- Make database selection feel instant across devices
- Cache Notion database list per user (shared, server‑side)
- Cache Notion database schema per database (raw + LLM‑friendly simplified)
- Provide per‑DB settings (custom instructions, flags) stored in backend
- Use stale‑while‑revalidate so the UI renders immediately while background refresh picks up changes
- Version/ETag payloads for efficient client re-fetch

## Non‑Goals
- Replace Notion as the source of truth (we only cache, we don’t own)
- Complex search across properties/content (future)

---

## Architecture Overview

- Server maintains two caches per user: list index (all DBs) and per‑DB schema. Settings are separate.
- Server exposes versioned endpoints; clients send last seen version and receive 304 when unchanged.
- On stale cache reads, server serves the latest cache immediately and refreshes in the background (SWR).

```
Client (extension)
  ├─ GET /api/databases/search?version=<v>  ──►  Server cache
  │        │ 200 {databases,version,stale}       │
  │        └─ 304 Not Modified                    │
  ├─ GET /api/databases/:id/schema?version=<sv> ─►  Server cache
  │        │ 200 {schema,version,stale}
  │        └─ 304 Not Modified
  └─ GET/PUT /api/databases/:id/settings         ─►  Settings table
```

---

## Data Model (Supabase)

### Table: `notion_db_index`
- `user_id uuid` (PK part)
- `workspace_id text`
- `db_id text` (PK part)
- `title text`
- `icon_emoji text`
- `url text`
- `last_edited_time timestamptz null` (from Notion)
- `updated_at timestamptz not null default now()`
- `version text not null` // hash of a stable projection
- Unique: `(user_id, db_id)`
- Index: `(user_id, updated_at desc)`

### Table: `notion_db_schema`
- `user_id uuid` (PK part)
- `db_id text` (PK part)
- `workspace_id text`
- `raw jsonb`            // original Notion DB
- `simplified jsonb`     // LLM‑friendly minimal shape (see below)
- `title_prop text null` // convenience
- `url_prop text null`
- `updated_at timestamptz not null default now()`
- `version text not null` // hash of simplified
- Unique: `(user_id, db_id)`

### Table: `db_settings`
- `user_id uuid` (PK part)
- `db_id text` (PK part)
- `prompt text`
- `save_article boolean not null default true`
- `customize_content boolean not null default false`
- `content_prompt text`
- `updated_at timestamptz not null default now()`

### RLS
- All tables RLS on `user_id`; read/update only by owner.
- Writes/refresh actions executed via service role endpoints.

---

## LLM‑Friendly Simplified Schema

Stored as `notion_db_schema.simplified`:

```json
{
  "db_id": "...",
  "title_prop": "Name",
  "url_prop": "URL",
  "properties": {
    "Name": { "id": "title", "type": "title", "writable": true },
    "URL": { "id": "abcd", "type": "url", "writable": true },
    "Tags": { "id": "efgh", "type": "multi_select", "options": ["AI","NLP"], "writable": true },
    "Status": { "id": "ijkl", "type": "status", "options": ["To Do","In Progress","Done"], "writable": true },
    "Poster": { "id": "mnop", "type": "files", "hints": { "image_like": true }, "writable": true },
    "Created time": { "id": "uvwx", "type": "created_time", "writable": false }
  },
  "version": "sch_v10",
  "updated_at": "2025-08-23T19:00:00Z"
}
```

Rules:
- Property fields by type
  - Common: `{ id, type, description?, writable }`
  - `select|multi_select|status`: add `options: [string]`
  - `number`: add `format?: string`
  - `date`, `title`, `rich_text`, `url`, `email`, `phone_number`, `files`, `checkbox`: `{ type: '...' }`
  - Read‑only (rollup, formula, created_time, last_edited_time): `writable:false`
  - Image hint: for `files` names matching `/poster|cover|thumb|thumbnail|image|artwork|screenshot/i`, add `{hints:{image_like:true}}`
- `title_prop` is the name of the title property; `url_prop` first url property if any
- `version` is a hash (stable JSON stringify) of `simplified` sans `updated_at`

---

## API Design

### GET `/api/databases/search?q=&limit=&version=`
- Response 200: `{ databases: [{id,title,iconEmoji,url}], version: "v123", stale: boolean }`
- Response 304: if `version` matches server cache
- Behavior: Serve cached list immediately. If cache age > TTL (e.g., 5–10 min) or hint of change, schedule a background refresh (SWR).

### POST `/api/databases/reindex` (optional)
- Body: `{ workspace_id?: string }`
- Kicks a refresh job; returns `{ enqueued: true }`

### GET `/api/databases/:id/schema?shape=simplified|raw&version=`
- Response 200: `{ db_id, version, updated_at, schema }`
- Response 304: if `version` matches cached entry
- Behavior: Serve cached schema; if stale (e.g., 24h), revalidate in background.

### GET `/api/databases/:id/settings`
- Response 200: settings row or defaults

### PUT `/api/databases/:id/settings`
- Upsert settings; return saved row

---

## Refresh Logic (SWR)

- Index refresh
  - Triggered when cache is older than TTL or via manual reindex or post‑OAuth connect
  - Fetch Notion `/v1/search` per workspace in parallel
  - Upsert rows, recompute overall `version` (hash of stable projection of all rows)
- Schema refresh
  - Triggered on TTL (e.g., 24h) or on demand when a save detects unknown property
  - Fetch Notion `/databases/:id`, compute `simplified`, set `version`

Rate Limits / Resilience
- Parallelism capped; exponential backoff on 429
- Partial workspace failures are tolerated; keep last good cache

---

## Extension Changes

- Database list
  - On popup open, call `GET /api/databases/search?version=<last>`
  - If 200: render instantly, store `{items,version,ts}` locally
  - If 304: render from local cache
  - If `stale:true`: UI remains responsive; allow a silent re‑poll once
  - Add a small “Refresh” action in the combobox menu (calls `/reindex` then re-fetches)
- Schema usage
  - On DB select (or before SAVE), call `GET /api/databases/:id/schema?shape=simplified&version=<last>`
  - Use 304 to avoid re-downloading
  - Fallback: only if schema is missing and backend fails, fetch directly from Notion
- Settings
  - Read/write via `/api/databases/:id/settings`

---

## Acceptance Criteria
- First paint shows a database list instantly (cached or recent)
- New DB shows after refresh completes or on manual “Refresh”
- Schema endpoint returns 200 on first load, 304 on subsequent loads with same version
- No UI freeze while background refresh runs

Performance Budgets
- Popup initial render: <100 ms before showing a usable list
- Background search: completes under 3 s for 100–200 DBs (parallel across workspaces)

---

## Security & Privacy
- RLS ensures tenant isolation by `user_id`
- Access to Notion tokens remains server‑side
- Only minimal schema metadata is exposed to the client (no token leakage)

---

## Observability
- Log cache hit/miss, TTL expiries, refresh duration, Notion 429 events
- Add a debug endpoint/flag to inspect cache age and version per user

---

## Risks & Mitigations
- Notion rate limits → backoff, partial updates, persist last good cache
- Schema drift → refresh on TTL and when save detects shape mismatch
- Stale list after new workspace → reindex on OAuth completion and expose manual refresh

---

## Rollout Plan
1) Ship DB index cache + search endpoint with versioning (no client UI change required to start)
2) Wire extension to versioned search and add Refresh action
3) Ship schema cache + schema endpoint; switch SAVE flow to use cached simplified schema
4) Ship per‑DB settings endpoints; wire tokens UI to use backend settings

---

## Implementation Tasks (High‑Level)
- Supabase: create tables, RLS policies, indexes
- Backend:
  - Helpers: hashing (version), Notion fetch, simplifySchema()
  - Routes: search, schema, settings, reindex
  - SWR orchestrator with per‑workspace parallel fetch and backoff
- Extension:
  - Versioned list fetch with local fallback and Refresh
  - Schema fetch on selection with version caching
  - Settings read/write UI using backend

---

## Simplify Function (Pseudo‑signature)

```
function simplifySchema(notionDb: any): SimplifiedSchema
  - detect title_prop, url_prop
  - for each property:
      map { id, type, description? }
      set writable=false for read‑only types
      add options[] for select/multi_select/status
      add number.format when present
      add hints.image_like for likely image files
  - return { db_id, title_prop, url_prop, properties, updated_at }
```

Versioning: `version = sha1(JSON.stringify(simplifiedWithoutUpdatedAt))`

---

## Open Questions
- TTLs: Index 5–10 min; Schema 24 h – confirm
- Streaming progressive results (NDJSON) – worth adding later?
- Server‑side paging & search beyond title? (future)
