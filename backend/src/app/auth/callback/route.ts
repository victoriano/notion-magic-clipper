import { NextRequest, NextResponse } from 'next/server';
import env from '@/lib/env';

// Serve a small HTML bridge that reads tokens from the URL fragment and
// posts them to /api/auth/session to set a server cookie, then redirects.
export async function GET(_req: NextRequest) {
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Signing in…</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 20px">
  <p>Completing sign-in…</p>
  <script>
  (async function(){
    try {
      var h = location.hash.startsWith('#') ? location.hash.slice(1) : '';
      var qsH = new URLSearchParams(h);
      var qsQ = new URLSearchParams(location.search);
      var access_token = qsH.get('access_token') || qsQ.get('access_token');
      if (access_token) {
        await fetch('/api/auth/session', {method:'POST',headers:{'Content-Type':'application/json'}, body: JSON.stringify({ access_token }), credentials:'include'});
      }
    } catch (e) { console.error('callback error', e); }
    // Chain directly into Notion workspace connect so users only click once
    location.replace('/api/notion/start');
  })();
  </script></body></html>`;
  return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}


