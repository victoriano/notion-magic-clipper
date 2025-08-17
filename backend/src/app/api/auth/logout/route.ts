import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
	const res = NextResponse.json({ ok: true });
	res.cookies.set('sb_user_id', '', { path: '/', maxAge: 0 });
	return res;
}


