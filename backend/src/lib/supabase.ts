import { createClient } from '@supabase/supabase-js';
import env from './env';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
	auth: {
		autoRefreshToken: false,
		detectSessionInUrl: false,
		persistSession: false,
	},
});

export const supabaseAdmin = env.SUPABASE_SERVICE_ROLE_KEY
	? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
	})
	: null as any;