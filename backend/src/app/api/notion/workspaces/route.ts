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
	type WorkspaceRow = {
		workspace_id: string;
		workspace_name: string | null;
		updated_at: string | null;
		access_token: string | null;
	};

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
			const resp = await fetch('https://api.notion.com/v1/users', {
				headers: {
					'Authorization': `Bearer ${token}`,
					'Notion-Version': '2022-06-28',
					'Content-Type': 'application/json'
				}
			});
			if (!resp.ok) return { account_email: null, account_name: null };
			const j = await resp.json();
			const list = Array.isArray(j?.results) ? j.results : [];
			// pick the first real person (not bot); prefer those with email
			let person = list.find((u: any) => u?.type === 'person' && u?.person?.email) || list.find((u: any) => u?.type === 'person');
			const email = person?.person?.email || null;
			const name = person?.name || null;
			return { account_email: email, account_name: name };
		} catch { return { account_email: null, account_name: null }; }
	}

	const rows: WorkspaceRow[] = (data || []) as unknown as WorkspaceRow[];
	const enriched = await Promise.all(rows.map(async (row: WorkspaceRow) => {
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


