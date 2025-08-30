import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function createLazySupabase(getCreds: () => { url: string; key: string }): SupabaseClient {
  let client: SupabaseClient | null = null;
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (!client) {
        const { url, key } = getCreds();
        if (!url || !key) throw new Error("Supabase not configured");
        client = createClient(url, key, {
          auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
        });
      }
      return (client as any)[prop as any];
    },
  };
  return new Proxy({}, handler) as any;
}

export const supabase: SupabaseClient = createLazySupabase(() => {
  const url = process.env.SUPABASE_URL as string;
  const key = process.env.SUPABASE_ANON_KEY as string;
  return { url, key };
});

export const supabaseAdmin: SupabaseClient | null = ((): SupabaseClient | null => {
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined;
  if (!srk) return null;
  return createLazySupabase(() => {
    const url = process.env.SUPABASE_URL as string;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
    return { url, key };
  });
})();
