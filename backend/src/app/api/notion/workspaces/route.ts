import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { cookies } from 'next/headers';

function withCors(req: NextRequest, res: NextResponse) {
	const origin = req.headers.get('origin') || '*';
	res.headers.set('Access-Control-Allow-Origin', origin);
	res.headers.set('Vary', 'Origin');
	res.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.headers.set('Access-Control-Allow-Headers', '*');
	res.headers.set('Access-Control-Allow-Credentials', 'true');
	return res;
}

export async function OPTIONS(req: NextRequest) {
	return withCors(req, new NextResponse(null, { status: 204 }));
}

export async function GET(req: NextRequest) {
	const userId = cookies().get('sb_user_id')?.value;
	if (!userId) return withCors(req, NextResponse.json({ error: 'Login required' }, { status: 401 }));
	if (!supabaseAdmin) return withCors(req, NextResponse.json({ error: 'Server misconfigured' }, { status: 500 }));
	const { data, error } = await supabaseAdmin
		.from('notion_connections')
		.select('workspace_id, workspace_name, updated_at, access_token')
		.eq('user_id', userId)
		.order('updated_at', { ascending: false });

	if (error) return withCors(req, NextResponse.json({ error: error.message }, { status: 500 }));

	// Enrich with Notion account (authorizing user) if possible
	async function getAccountInfo(token: string | null) {
		if (!token) return { account_email: null as string | null, account_name: null as string | null };
		try {
			const resp = await fetch('https://api.notion.com/v1/users/me', {
				headers: {
					'Authorization': `Bearer ${token}`,
					'Notion-Version': '2022-06-28',
					'Content-Type': 'application/json'
				}
			});
			if (!resp.ok) return { account_email: null, account_name: null };
			const j = await resp.json();
			const email = j?.person?.email || null;
			const name = j?.name || null;
			return { account_email: email, account_name: name };
		} catch { return { account_email: null, account_name: null }; }
	}

	const enriched = await Promise.all((data || []).map(async (row) => {
		const extra = await getAccountInfo(row.access_token as unknown as string);
		return {
			workspace_id: row.workspace_id,
			workspace_name: row.workspace_name,
			updated_at: row.updated_at,
			account_email: extra.account_email,
			account_name: extra.account_name,
		};
	}));

	return withCors(req, NextResponse.json({ workspaces: enriched }));
}


