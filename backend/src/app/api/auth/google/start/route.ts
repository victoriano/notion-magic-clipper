import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes } from 'crypto';
import env from '@/lib/env';

export async function GET() {
	const state = randomBytes(16).toString('hex');
	cookies().set('sb_oauth_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 600 });

	const redirectTo = `${env.NEXT_PUBLIC_BASE_URL}/auth/callback`;
	const params = new URLSearchParams({
		provider: 'google',
		redirect_to: redirectTo,
		state,
	});

	// We rely on Supabase hosted auth page
	const url = `${env.SUPABASE_URL}/auth/v1/authorize?${params.toString()}`;
	return NextResponse.redirect(url);
}


