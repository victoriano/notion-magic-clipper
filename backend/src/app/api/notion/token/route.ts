import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

function withCors(res: NextResponse) {
	res.headers.set('Access-Control-Allow-Origin', '*');
	res.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.headers.set('Access-Control-Allow-Headers', '*');
	return res;
}

export async function OPTIONS() {
	return withCors(new NextResponse(null, { status: 204 }));
}

export async function GET(req: NextRequest) {
	const { searchParams } = new URL(req.url);
	const workspaceId = searchParams.get('workspace_id');
	if (!workspaceId) {
		return withCors(NextResponse.json({ error: 'Missing workspace_id' }, { status: 400 }));
	}

	const { data, error } = await supabase
		.from('notion_tokens')
		.select('workspace_id, workspace_name, access_token, bot_id, updated_at')
		.eq('workspace_id', workspaceId)
		.single();

	if (error || !data) {
		return withCors(NextResponse.json({ error: 'Not found' }, { status: 404 }));
	}

	return withCors(NextResponse.json({
		workspace_id: data.workspace_id,
		workspace_name: data.workspace_name,
		access_token: data.access_token,
		bot_id: data.bot_id,
		updated_at: data.updated_at,
	}));
}


