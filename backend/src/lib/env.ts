type Env = {
  NEXT_PUBLIC_BASE_URL: string;
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
  NOTION_REDIRECT_URI: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
};

function required(name: keyof Env | string): string {
  const value = process.env[name as string];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// Lazy getters to avoid throwing at module import time.
// This is important for Trigger.dev deploy indexing where envs are not yet set.
const env = {
  get NEXT_PUBLIC_BASE_URL(): string {
    return required("NEXT_PUBLIC_BASE_URL");
  },
  get NOTION_CLIENT_ID(): string {
    return required("NOTION_CLIENT_ID");
  },
  get NOTION_CLIENT_SECRET(): string {
    return required("NOTION_CLIENT_SECRET");
  },
  get NOTION_REDIRECT_URI(): string {
    return required("NOTION_REDIRECT_URI");
  },
  get SUPABASE_URL(): string {
    return required("SUPABASE_URL");
  },
  get SUPABASE_ANON_KEY(): string {
    return required("SUPABASE_ANON_KEY");
  },
  get SUPABASE_SERVICE_ROLE_KEY(): string | undefined {
    return process.env.SUPABASE_SERVICE_ROLE_KEY;
  },
  get OPENAI_API_KEY(): string | undefined {
    return process.env.OPENAI_API_KEY;
  },
  get GOOGLE_API_KEY(): string | undefined {
    return process.env.GOOGLE_API_KEY;
  },
} as const;

export default env;
