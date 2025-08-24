# Notion Magic Clipper

👉 [Install from the Chrome Web Store](https://chromewebstore.google.com/detail/notion-magic-clipper/gohplijlpngkipjghachaaepbdlfabhk)

[Follow on X: @NotionClipper](https://x.com/NotionClipper)

<p align="center">
  <img src="backend/public/logo.svg" alt="Notion Magic Clipper logo" width="220" />
  <br/>
  <em>Clip the web to Notion with a bit of magic ✨</em>
</p>

A Chrome (MV3) extension that sends the current page to a Notion database and uses GPT‑5 Nano to auto-complete properties and optionally generate page content.

- Fast “clip to Notion” with per‑database custom prompts
- Emoji support for databases in the UI
- Safe, schema‑aware property normalization (title, text, number, date, select, multi_select, status, url, etc.)
- Automatic creation of missing select/multi_select options (capacity‑aware) when allowed by your per‑database instructions
- Robust JSON extraction and block sanitization to avoid Notion API errors
- Recent saves history with completion time and original source link

## Repository structure

```
notion-magic-clipper/
├─ manifest.json                # MV3 manifest
├─ background.js                # Service worker: Notion/OpenAI logic, messaging, persistence
├─ contentScript.js             # Page context collector (title, meta, selection, sample text)
├─ popup.html                   # Popup UI (save flow + history view)
├─ popup.js                     # Popup logic (load DBs, save, history)
├─ options.html                 # Options UI (tokens, utilities, prompts)
├─ options.js                   # Options logic
├─ utils/
│  ├─ listAllDatabases.js       # List all accessible databases (+emoji)
│  └─ untitledDatabases.js      # List databases with empty titles
└─ README.md                    # This file
```

### High-level flow

1. You open the popup and choose a target database.
2. The popup asks the content script for page context (metadata + a small text sample), then sends a `SAVE_TO_NOTION` message to the background.
3. The background worker fetches the Notion database schema, builds an LLM prompt including your per‑database custom instructions, and calls GPT‑5 Nano.
4. The model returns JSON with `properties` and optionally `children` blocks. The background sanitizes values to valid Notion formats and safely normalizes blocks to a small allowed subset.
5. The background creates the page in Notion, records the save in a small history list, and responds back to the popup (which can be closed at any time; work continues in background).

## Installation (developer mode)

1. Clone the repo:

```bash
git clone https://github.com/victoriano/notion-magic-clipper.git
cd notion-magic-clipper
```

2. Load as an unpacked extension in Chrome:
- Open `chrome://extensions`
- Enable “Developer mode”
- Click “Load unpacked” and select this folder

No build step is required; everything is plain HTML/JS.

## Configuration

Open the extension Options page and set:

- Notion Integration Token (`secret_…` or `ntn_…`)
- OpenAI API Key (`sk-…`)
- Optional model tweaks: GPT‑5 Reasoning effort and Verbosity

Tokens are stored in Chrome’s `chrome.storage.local` on your machine.

## Using the popup

- Search/select a Notion database (emoji + title shown)
- Optional note (added as a paragraph above a bookmark block)
- Click “Save to Notion”
- Bottom‑right 🕒 button opens the Recent saves view:
  - Shows Notion page link, original source 🔗, finish time, and total duration (from click to page created)

Switching tabs closes the popup, but saving continues in the background.

## Development (backend + Trigger.dev)

This repo includes a Next.js backend (`backend/`) that handles OAuth with Notion and now offloads long saves to background jobs using Trigger.dev. In dev, run the backend and load the extension in Chrome.

### Prerequisites

- Bun installed (backend uses Bun scripts)
- Supabase project (URL, anon key, service role key)
- Notion integration (Client ID/Secret) and OAuth redirect set to `http://localhost:3000/api/notion/callback`
- Trigger.dev project (optional but recommended for async saves)
- An LLM key (OpenAI or Google), optional in dev

### Backend setup

1) Create env files and fill values:

- Put Trigger.dev variables in `backend/.env` so the CLI loads them.
- Optionally also create `backend/.env.local` for Next.js (overrides), but note the Trigger.dev CLI does NOT read `.env.local`.

```env
# Base URL of your backend (used by tasks/LLM calls)
NEXT_PUBLIC_BASE_URL=http://localhost:3000

# Notion OAuth
NOTION_CLIENT_ID=xxx
NOTION_CLIENT_SECRET=xxx
NOTION_REDIRECT_URI=http://localhost:3000/api/notion/callback

# Supabase
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# LLM providers (optional; at least one)
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...

# Trigger.dev
# Required for the CLI and for server-side enqueue (tasks.trigger)
TRIGGER_PROJECT_ID=proj_...
TRIGGER_SECRET_KEY=tr_sec_...
# TRIGGER_API_URL=https://api.trigger.dev  # optional override
```

Notes:
- The Trigger.dev CLI reads `backend/.env` (not `.env.local`).
- Next.js reads both `.env` and `.env.local` at process start; restart `bun run dev` after changes.
- In local development, set `NEXT_PUBLIC_BASE_URL` to `http://localhost:3000`. On Vercel, set `NEXT_PUBLIC_BASE_URL` to your deployed URL (for example, `https://YOUR_APP.vercel.app`) in Project Settings → Environment Variables. Trigger.dev tasks use this value to call your backend (e.g., `/api/llm/chat`). A mismatch can cause errors like “Server missing OPENAI_API_KEY” if the task calls the wrong environment.

2) Create the Supabase table and RLS policies. See the SQL in `backend/README.md`.

3) Run the backend:

```bash
cd backend
bun install
bun run dev
```

4) Run Trigger.dev dev server (registers tasks during development). See the Quick start docs: [Trigger.dev Quick start](https://trigger.dev/docs/quick-start).

```bash
cd backend
npx trigger.dev@latest dev --project-ref "$TRIGGER_PROJECT_ID"
```

5) In your browser, open `http://localhost:3000` and sign in, then click “Connect Notion” to link a workspace.

### Extension in dev

1) Load the extension (unpacked) as described below in “Installation (developer mode)”.

2) In the extension Options, set the backend URL to `http://localhost:3000` (if available), or it will use the configured default.

3) Use the popup to save pages. When `TRIGGER_SECRET_KEY` is set (and `TRIGGER_PROJECT_ID`), the backend enqueues the save and returns `202` immediately; the page is created in the background and you can monitor runs in Trigger.dev.

### LLM pricing & cost estimation

- The backend tracks LLM usage and an estimated cost for each save.
- Usage (tokens, provider, model, call count) is stored in the `public.notion_saves` table: `provider`, `model`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `call_count`, and `estimated_cost_usd`.
- Model pricing is stored in `public.llm_pricing` with time‑aware rows: `provider`, `model`, per‑1K input/output USD, optional cache rates, and `effective_from`.

How pricing data is populated

- Prices are imported from `models.dev` and normalized to per‑1K tokens.
- Endpoint to refresh pricing (dev only):

```bash
curl -X POST http://localhost:3000/api/llm/pricing/refresh
```

- This fetches `https://models.dev/api.json` and inserts rows into `public.llm_pricing` with `effective_from = now()`.
- Note: `models.dev` publishes costs per 1M tokens; we divide by 1000 to store per‑1K values.

How cost is calculated

- After each save, the Trigger task aggregates token usage across all internal LLM calls (property extraction, optional transforms, summaries) and looks up the latest effective pricing row for `(provider, model)`.
- Formula used:

```
estimated_cost_usd = (prompt_tokens / 1000) * input_usd_per_1k
                   + (completion_tokens / 1000) * output_usd_per_1k
```

- Example (Gemini 2.5 Flash): models.dev shows $0.30/M input and $2.50/M output → stored as $0.0003/1K input and $0.0025/1K output.
- With ~3.1K prompt and ~0.28K completion tokens → cost ≈ 3.1K*0.0003 + 0.28K*0.0025 ≈ $0.0016.

Operational notes

- Pricing can change over time. Re‑run the refresh endpoint to insert new rows with a newer `effective_from`.
- Existing `estimated_cost_usd` values are computed at run time and not retroactively updated.
- Quick SQL examples:

```sql
-- Total estimated cost for the last 7 days
select coalesce(sum(estimated_cost_usd), 0) as usd
from public.notion_saves
where started_at >= now() - interval '7 days';

-- Average cost by model
select model, round(avg(estimated_cost_usd)::numeric, 6) as avg_usd
from public.notion_saves
group by 1
order by 2 desc;
```

## Per‑database custom prompts (Options → Utilities → List all)

- Click “Edit prompt” on any database to store custom guidance (how to map fields, what to prioritize, content structure).
- The background appends these instructions to the LLM prompt for that database.
- Default behavior for select/multi_select:
  - Use existing options only. Do not create new options unless your custom instructions explicitly allow it.
  - If creation is allowed, the extension will add missing options up to Notion’s limit (100); any extras map to a fallback or are omitted to avoid errors.

## Utilities (Options)

- List untitled databases (quick links to review in Notion)
- List all databases (emoji + title), with prompt editor per database

## Implementation details

### Background service worker (`background.js`)

- Notion helpers: authenticated fetch, search databases, get database, create page
- OpenAI helper: calls Chat Completions with GPT‑5 Nano and constructs messages
- Prompt builder:
  - System: instructs the model to return only JSON `{ properties, children? }`
  - User: provides the database schema + page context + strict instructions
  - Custom: appends per‑database instructions from `databasePrompts`
- Property normalization:
  - Strict per Notion type (title, rich_text, url, email, phone_number, number, checkbox, select, multi_select, status, date)
  - Dates normalized to `{ date: { start, end?, time_zone? } }`
  - Title guaranteed even if the model omits it
- Select/multi_select option management:
  - Adds missing options only when allowed by your custom prompt
  - Capacity‑aware: respects the 100‑option limit; maps excess to a fallback option when necessary
- Block sanitization:
  - Only allows: paragraph, heading_1/2/3, bulleted_list_item, numbered_list_item, quote, bookmark
- Recent saves:
  - Persists `{ url, sourceUrl, ts, durationMs, databaseId, databaseTitle, title }` (max 30)

### Content script (`contentScript.js`)

Collects:
- `document.title`
- Meta tags: description, og:title, og:description, og:url, og:type, twitter:title, twitter:description, keywords
- First paragraphs (short sample)
- User selection (if any)

### Popup (`popup.html`, `popup.js`)

- Loads databases (`LIST_DATABASES`)
- Starts a timer at click; sends `SAVE_TO_NOTION` with `startedAt`
- Shows success status and link to created page
- History view (🕒): reads `recentSaves` and renders links + time + duration

### Options (`options.html`, `options.js`)

- Manages tokens and GPT‑5 settings
- Utilities:
  - Untitled databases
  - All databases with emoji and prompt editor
- Robust fallbacks: if the background worker sleeps, Options can query Notion directly

### Utils (`utils/*.js`)

- `listAllDatabases.js`: Search all databases, returns `{ id, title, url, iconEmoji }`
- `untitledDatabases.js`: Same but filtered to empty titles

## Troubleshooting

- Notion 400 validation_error
  - The extension normalizes values per schema. If a date/title is missing, it fills safe defaults or omits invalid fields.
  - For select/multi_select at capacity: we map to a fallback option or omit extra values.

- “The model did not return valid JSON for properties.”
  - We use a robust extractor that handles fences and finds the first balanced JSON object. If it persists, tighten your custom prompt to avoid extra text.

- Popup closes mid‑save
  - Saving continues in the background; check 🕒 history for completion.

## Privacy & storage

- Tokens and configuration are stored locally via `chrome.storage.local`.
- No analytics or tracking are performed by the extension.

## License

MIT
