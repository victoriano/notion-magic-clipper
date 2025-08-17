# Notion Magic Backend

Simple Next.js backend to handle Notion OAuth and store tokens in Supabase.

## Setup

1. Copy env file and fill values:

```bash
cp .env.example .env.local
```

- `NEXT_PUBLIC_BASE_URL`: Origin allowed to receive final redirect (e.g., extension UI or website)
- `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET`: From your Notion integration
- `NOTION_REDIRECT_URI`: Must match the OAuth redirect URL configured in Notion (e.g., http://localhost:3000/api/notion/callback)
- `SUPABASE_URL` and `SUPABASE_ANON_KEY`: From your Supabase project

2. Create a table in Supabase:

```sql
create table if not exists public.notion_tokens (
  workspace_id text primary key,
  workspace_name text,
  access_token text not null,
  bot_id text,
  updated_at timestamptz not null default now()
);
```

Ensure RLS is configured to your needs. For a simple prototype, you can disable RLS or allow inserts/updates from anon key appropriately.

3. Install deps and run (Bun):

```bash
bun install
bun run dev
```

Open http://localhost:3000 and click "Connect Notion".