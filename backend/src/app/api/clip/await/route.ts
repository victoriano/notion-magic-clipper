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
	try {
		const { searchParams } = new URL(req.url);
		const id = searchParams.get('id');
		const runId = searchParams.get('run_id');
		const recent = searchParams.get('recent');
		const active = searchParams.get('active');
		const userId = cookies().get('sb_user_id')?.value;
		if (!userId) return withCors(req, NextResponse.json({ error: 'Login required' }, { status: 401 }));
		if (!supabaseAdmin) return withCors(req, NextResponse.json({ error: 'Server misconfigured' }, { status: 500 }));
		if (active) {
			const { data, error } = await supabaseAdmin
				.from('notion_saves')
				.select('id, status, run_id, notion_page_id, notion_page_url, error, started_at, completed_at, source_url, title, database_id')
				.eq('user_id', userId)
				.in('status', ['queued','running'])
				.order('started_at', { ascending: false })
				.limit(20);
			if (error) return withCors(req, NextResponse.json({ error: error.message }, { status: 500 }));
			return withCors(req, NextResponse.json({ saves: data || [] }));
		}
		if (recent) {
			const { data, error } = await supabaseAdmin
				.from('notion_saves')
				.select('id, status, notion_page_id, notion_page_url, error, started_at, completed_at, source_url, title')
				.eq('user_id', userId)
				.order('started_at', { ascending: false })
				.limit(20);
			if (error) return withCors(req, NextResponse.json({ error: error.message }, { status: 500 }));
			return withCors(req, NextResponse.json({ saves: data || [] }));
		}
		if (!id && !runId) return withCors(req, NextResponse.json({ error: 'Missing id or run_id' }, { status: 400 }));
		let query = supabaseAdmin
			.from('notion_saves')
			.select('id, user_id, status, notion_page_id, notion_page_url, error, started_at, completed_at, source_url, title')
			.eq('user_id', userId)
			.limit(1);
		if (id) query = query.eq('id', id);
		else if (runId) query = query.eq('run_id', runId);
		const { data, error } = await query.maybeSingle();
		if (error) return withCors(req, NextResponse.json({ error: error.message }, { status: 500 }));
		if (!data) return withCors(req, NextResponse.json({ error: 'Not found' }, { status: 404 }));
		const { user_id: _omit, ...rest } = data as any;
		return withCors(req, NextResponse.json({ save: rest }));
	} catch (e: any) {
		return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
	}
}


