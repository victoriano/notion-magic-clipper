import { NextResponse } from 'next/server';
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

export async function GET() {
	const { data, error } = await supabase
		.from('notion_tokens')
		.select('workspace_id, workspace_name, updated_at')
		.order('updated_at', { ascending: false });

	if (error) return withCors(NextResponse.json({ error: error.message }, { status: 500 }));

	return withCors(NextResponse.json({ workspaces: data || [] }));
}


