import { NextRequest, NextResponse } from 'next/server';

function withCors(req: NextRequest, res: NextResponse) {
	const origin = req.headers.get('origin') || '*';
	res.headers.set('Access-Control-Allow-Origin', origin);
	res.headers.set('Vary', 'Origin');
	res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
	res.headers.set('Access-Control-Allow-Headers', '*');
	res.headers.set('Access-Control-Allow-Credentials', 'true');
	return res;
}

export async function OPTIONS(req: NextRequest) {
	return withCors(req, new NextResponse(null, { status: 204 }));
}

export async function POST(req: NextRequest) {
	const res = withCors(req, NextResponse.json({ ok: true }));
	res.cookies.set('sb_user_id', '', {
		path: '/',
		maxAge: 0,
		sameSite: 'lax',
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
	});
	return res;
}


