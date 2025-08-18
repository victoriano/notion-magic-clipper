import { NextResponse } from 'next/server';
import env from '@/lib/env';

export async function GET() {
  const redirectTo = `${env.NEXT_PUBLIC_BASE_URL}/auth/callback`;
  // Let Supabase handle state internally; passing our own can cause bad_oauth_state
  const params = new URLSearchParams({ provider: 'notion', redirect_to: redirectTo });
  const url = `${env.SUPABASE_URL}/auth/v1/authorize?${params.toString()}`;
  return NextResponse.redirect(url);
}


