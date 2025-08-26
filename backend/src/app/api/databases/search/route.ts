import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { readIndexCache, refreshIndexCache } from '@/lib/dbIndexCache';
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
	const clientVersion = searchParams.get('version') || '';
	try {
		const { databases, version, stale } = await readIndexCache(userId);
		if (version && clientVersion && clientVersion === version) {
			return withCors(req, new NextResponse(null, { status: 304 }));
		}
		if (databases.length === 0) {
			const refreshed = await refreshIndexCache(userId);
			return withCors(req, NextResponse.json({ databases: refreshed.databases, version: refreshed.version, stale: false }));
		}
		if (stale) {
			refreshIndexCache(userId).catch(() => {});
		}
		return withCors(req, NextResponse.json({ databases, version, stale }));
	} catch (e: any) {
		return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
	}
}