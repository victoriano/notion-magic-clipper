import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const { access_token } = await req.json();
    if (!access_token || typeof access_token !== 'string') {
      return NextResponse.json({ error: 'Missing access_token' }, { status: 400 });
    }
    const { data, error } = await supabase.auth.getUser(access_token);
    if (error || !data?.user?.id) {
      return NextResponse.json({ error: error?.message || 'Invalid token' }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true, user_id: data.user.id });
    res.cookies.set('sb_user_id', data.user.id, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7,
    });
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Error' }, { status: 500 });
  }
}


