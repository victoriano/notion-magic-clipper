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
	const { searchParams } = new URL(req.url);
	const query = searchParams.get('q') || '';
	try {
		const { data, error } = await supabaseAdmin
			.from('notion_connections')
			.select('access_token')
			.eq('user_id', userId);
		if (error) return withCors(req, NextResponse.json({ error: error.message }, { status: 500 }));
		const tokens = (data || []).map((r: any) => r.access_token).filter(Boolean);
		if (tokens.length === 0) return withCors(req, NextResponse.json({ databases: [] }));
		const body = { query, filter: { property: 'object', value: 'database' }, sort: { direction: 'ascending', timestamp: 'last_edited_time' } };
		const per = await Promise.all(tokens.map(async (tok: string) => {
			try {
				const resp = await fetch('https://api.notion.com/v1/search', {
					method: 'POST',
					headers: { 'Authorization': `Bearer ${tok}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				});
				if (!resp.ok) throw new Error('notion');
				const j = await resp.json();
				const results = (j.results || []).map((item: any) => {
					const title = (item.title || []).map((t: any) => t.plain_text).join('') || '(Untitled)';
					const iconEmoji = item?.icon?.type === 'emoji' ? item.icon.emoji : undefined;
					const url = item?.url || `https://www.notion.so/${String(item?.id || '').replace(/-/g, '')}`;
					return { id: item.id, title, iconEmoji, url };
				});
				return results;
			} catch { return []; }
		}));
		const byId = new Map<string, any>();
		for (const list of per) {
			for (const db of list) {
				if (!byId.has(db.id)) byId.set(db.id, db);
			}
		}
		return withCors(req, NextResponse.json({ databases: Array.from(byId.values()) }));
	} catch (e: any) {
		return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
	}
}