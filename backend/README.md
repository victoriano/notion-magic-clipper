# Notion Magic Backend

Simple Next.js backend to handle Notion OAuth and store tokens in Supabase.

Production URL: https://magic-clipper.vercel.app

## Setup

1. Copy env file and fill values:

```bash
cp .env.example .env.local
```

- `NEXT_PUBLIC_BASE_URL`: Origin allowed to receive final redirect (e.g., extension UI or website). In production use `https://magic-clipper.vercel.app`.
- `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET`: From your Notion integration
- `NOTION_REDIRECT_URI`: Must match the OAuth redirect URL configured in Notion (e.g., http://localhost:3000/api/notion/callback). In production use `https://magic-clipper.vercel.app/api/notion/callback`.
- `SUPABASE_URL` and `SUPABASE_ANON_KEY`: From your Supabase project

2. Create tables in Supabase:

```sql
-- Users are handled by Supabase Auth

create table if not exists public.notion_connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id text not null,
  workspace_name text,
  access_token text not null,
  bot_id text,
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_id)
);
```

Enable RLS and use a service role key on the backend:

```sql
alter table public.notion_connections enable row level security;
create policy "owner can read" on public.notion_connections for select using (auth.uid() = user_id);
-- inserts/updates/deletes should be performed by the backend with service role; or scope with auth.uid() = user_id
```

3. Install deps and run (Bun):

```bash
bun install
bun run dev
```

Open http://localhost:3000 and click "Connect Notion".

## Background jobs with Trigger.dev

We offload slow Notion saves to Trigger.dev to avoid Vercel timeouts. See the Quick start: [Trigger.dev Quick start](https://trigger.dev/docs/quick-start).

Environment variables:

- `TRIGGER_PROJECT_ID` – Trigger.dev project ID
- `TRIGGER_API_KEY` – Secret API key used to enqueue tasks
- `TRIGGER_API_URL` – optional, defaults to `https://api.trigger.dev`

Files:

- `trigger.config.ts` – CLI config, points to `src/trigger`
- `src/trigger/saveToNotion.ts` – task definition (id: `saveToNotion`)
- `src/lib/notionSaveWorker.ts` – shared Notion save logic

Dev server for tasks:

```bash
npx trigger.dev@latest dev
```

The API route `src/app/api/clip/save/route.ts` enqueues `saveToNotion` and returns 202 when `TRIGGER_API_KEY` is present; otherwise it runs synchronously.