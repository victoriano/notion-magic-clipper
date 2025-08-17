type Env = {
	NEXT_PUBLIC_BASE_URL: string;
	NOTION_CLIENT_ID: string;
	NOTION_CLIENT_SECRET: string;
	NOTION_REDIRECT_URI: string;
	SUPABASE_URL: string;
	SUPABASE_ANON_KEY: string;
	SUPABASE_SERVICE_ROLE_KEY?: string;
};

const env: Env = {
	NEXT_PUBLIC_BASE_URL: required('NEXT_PUBLIC_BASE_URL'),
	NOTION_CLIENT_ID: required('NOTION_CLIENT_ID'),
	NOTION_CLIENT_SECRET: required('NOTION_CLIENT_SECRET'),
	NOTION_REDIRECT_URI: required('NOTION_REDIRECT_URI'),
	SUPABASE_URL: required('SUPABASE_URL'),
	SUPABASE_ANON_KEY: required('SUPABASE_ANON_KEY'),
	SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

function required(name: keyof Env | string): string {
	const value = process.env[name as string];
	if (!value) {
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

export default env;