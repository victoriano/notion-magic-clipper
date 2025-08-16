import env from '@/lib/env';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes } from 'crypto';

const NOTION_AUTH_URL = 'https://api.notion.com/v1/oauth/authorize';

export async function GET() {
	const state = randomBytes(16).toString('hex');
	cookies().set('notion_oauth_state', state, {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		path: '/',
		maxAge: 60 * 10,
	});

	const params = new URLSearchParams({
		client_id: env.NOTION_CLIENT_ID,
		response_type: 'code',
		owner: 'user',
		redirect_uri: env.NOTION_REDIRECT_URI,
		state,
	});

	const redirectUrl = `${NOTION_AUTH_URL}?${params.toString()}`;
	return NextResponse.redirect(redirectUrl);
}