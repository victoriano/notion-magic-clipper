import { NextRequest, NextResponse } from 'next/server';
import env from '@/lib/env';

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
	try {
		const body = await req.json().catch(() => ({}));
		const messages = Array.isArray(body?.messages) ? body.messages : [];
		let provider = (body?.provider === 'google' ? 'google' : 'openai') as 'openai' | 'google';
		let model = typeof body?.model === 'string' && body.model ? body.model : (provider === 'google' ? 'gemini-2.5-flash' : 'gpt-5-nano');
		const temperature = typeof body?.temperature === 'number' ? body.temperature : undefined;
		const reasoning_effort = typeof body?.reasoning_effort === 'string' ? body.reasoning_effort : undefined;
		const verbosity = typeof body?.verbosity === 'string' ? body.verbosity : undefined;

		if (provider === 'google' && !env.GOOGLE_API_KEY) provider = 'openai';
		if (provider === 'openai' && !env.OPENAI_API_KEY && env.GOOGLE_API_KEY) provider = 'google';

		if (provider === 'openai') {
			if (!env.OPENAI_API_KEY) return withCors(req, NextResponse.json({ error: 'Server missing OPENAI_API_KEY' }, { status: 500 }));
			const isGPT5 = typeof model === 'string' && /^gpt-5/.test(model);
			const isO1 = typeof model === 'string' && /^o1/.test(model);
			const supportsTemperature = !(isGPT5 || isO1);
			const payload: any = { model, messages };
			if (supportsTemperature && typeof temperature === 'number') payload.temperature = temperature;
			if (isGPT5 && typeof reasoning_effort === 'string') payload.reasoning_effort = reasoning_effort;
			if (isGPT5 && typeof verbosity === 'string') payload.verbosity = verbosity;
			const resp = await fetch('https://api.openai.com/v1/chat/completions', {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(payload)
			});
			if (!resp.ok) {
				const t = await resp.text().catch(() => '');
				return withCors(req, NextResponse.json({ error: `OpenAI ${resp.status}: ${t}` }, { status: 500 }));
			}
			const j = await resp.json();
			const content = j?.choices?.[0]?.message?.content?.trim() || '';
			const usage = j?.usage || {};
			return withCors(req, NextResponse.json({ content, usage: { provider: 'openai', model, prompt_tokens: usage?.prompt_tokens ?? 0, completion_tokens: usage?.completion_tokens ?? 0, total_tokens: usage?.total_tokens ?? 0 } }));
		}

		// Google
		if (!env.GOOGLE_API_KEY) return withCors(req, NextResponse.json({ error: 'Server missing GOOGLE_API_KEY' }, { status: 500 }));
		const contents: any[] = [];
		let systemInstruction: any = null;
		for (const m of messages) {
			const role = m?.role === 'assistant' ? 'model' : (m?.role === 'system' ? 'user' : m?.role);
			const text = typeof m?.content === 'string' ? m.content : (Array.isArray(m?.content) ? m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n') : '');
			if (m?.role === 'system') { systemInstruction = { parts: [{ text }] }; continue; }
			contents.push({ role: role === 'system' ? 'user' : role, parts: [{ text }] });
		}
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GOOGLE_API_KEY)}`;
		const gBody: any = { contents };
		if (systemInstruction) gBody.systemInstruction = systemInstruction;
		const gResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gBody) });
		if (!gResp.ok) {
			const t = await gResp.text().catch(() => '');
			return withCors(req, NextResponse.json({ error: `Gemini ${gResp.status}: ${t}` }, { status: 500 }));
		}
		const g = await gResp.json();
		const parts = g?.candidates?.[0]?.content?.parts || [];
		const out = Array.isArray(parts) ? parts.map((p: any) => p?.text || '').join('\n').trim() : '';
		const usage = g?.usageMetadata || {};
		return withCors(req, NextResponse.json({ content: out, usage: { provider: 'google', model, prompt_tokens: usage?.promptTokenCount ?? 0, completion_tokens: usage?.candidatesTokenCount ?? 0, total_tokens: usage?.totalTokenCount ?? 0 } }));
	} catch (e: any) {
		return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
	}
}