import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { cookies } from 'next/headers';

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

async function notionFetch(path: string, options: any = {}, token: string) {
	const headers = {
		'Authorization': `Bearer ${token}`,
		'Notion-Version': '2022-06-28',
		'Content-Type': 'application/json',
		...(options.headers || {})
	};
	const resp = await fetch(`https://api.notion.com/v1${path}`, { ...options, headers });
	if (!resp.ok) {
		const text = await resp.text().catch(() => '');
		throw new Error(`Notion API ${resp.status}: ${text}`);
	}
	return resp.json();
}

function extractJsonObject(text: string): any | null {
	if (!text || typeof text !== 'string') return null;
	const fenceMatch = text.match(/```(?:json)?\n([\s\S]*?)\n```/i);
	const candidate = fenceMatch ? fenceMatch[1] : text;
	try { if (candidate.trim().startsWith('{')) return JSON.parse(candidate); } catch {}
	const s = candidate;
	let start = -1, depth = 0, inStr = false, esc = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inStr) { if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch === '"') { inStr = false; } continue; }
		if (ch === '"') { inStr = true; continue; }
		if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
		if (ch === '}') { depth--; if (depth === 0 && start >= 0) { const frag = s.slice(start, i + 1); try { return JSON.parse(frag); } catch { const fixed = frag.replace(/,\s*(\]|\})/g, '$1'); try { return JSON.parse(fixed); } catch { return null; } } } }
	}
	return null;
}

export async function POST(req: NextRequest) {
	const userId = cookies().get('sb_user_id')?.value;
	if (!userId) return withCors(req, NextResponse.json({ error: 'Login required' }, { status: 401 }));
	if (!supabaseAdmin) return withCors(req, NextResponse.json({ error: 'Server misconfigured' }, { status: 500 }));
	try {
		const body = await req.json();
		const databaseId: string = body?.databaseId;
		const pageContext = body?.pageContext;
		const customInstructions: string = body?.customInstructions || '';
		const provider: 'openai' | 'google' = (body?.provider === 'google' ? 'google' : 'openai');
		const model: string = typeof body?.model === 'string' ? body.model : (provider === 'google' ? 'gemini-2.5-flash' : 'gpt-5-nano');
		if (!databaseId || !pageContext) return withCors(req, NextResponse.json({ error: 'Missing databaseId or pageContext' }, { status: 400 }));

		const { data: rows, error } = await supabaseAdmin
			.from('notion_connections')
			.select('workspace_id, access_token')
			.eq('user_id', userId);
		if (error) return withCors(req, NextResponse.json({ error: error.message }, { status: 500 }));
		const tokens: string[] = (rows || []).map((r: any) => r.access_token).filter(Boolean);
		if (tokens.length === 0) return withCors(req, NextResponse.json({ error: 'No Notion workspaces linked' }, { status: 400 }));

		// Find a token that can read the database
		let db: any = null;
		let notionToken: string | null = null;
		for (const tok of tokens) {
			try { db = await notionFetch(`/databases/${databaseId}`, {}, tok); notionToken = tok; break; } catch {}
		}
		if (!db || !notionToken) return withCors(req, NextResponse.json({ error: 'Database not accessible with linked workspaces' }, { status: 403 }));

		function extractSchemaForPrompt(database: any) {
			const props = database.properties || {};
			const simplified: any = {};
			Object.entries(props).forEach(([name, def]: any) => {
				const base: any = { type: def.type };
				try { const desc = typeof def?.description === 'string' ? def.description.trim() : ''; if (desc) base.description = desc; } catch {}
				if (def.type === 'select' || def.type === 'multi_select') base.options = def[def.type]?.options?.map((o: any) => o.name) || [];
				if (def.type === 'number') base.format = def.number?.format || 'number';
				simplified[name] = base;
			});
			return simplified;
		}
		const schemaForLLM = extractSchemaForPrompt(db);

		function buildMessages() {
			const schemaStr = JSON.stringify(schemaForLLM, null, 2);
			const baseContext: any = { url: pageContext.url, title: pageContext.title, meta: pageContext.meta, selectionText: pageContext.selectionText, images: pageContext.images };
			if (pageContext?.article && pageContext.article.text) baseContext.article = { title: pageContext.article.title, text: pageContext.article.text };
			if (pageContext?.textSample) baseContext.textSample = pageContext.textSample;
			const contextStr = JSON.stringify(baseContext, null, 2);
			const messages = [
				{ role: 'system', content: [
					'You are an assistant that generates Notion PROPERTIES only from a database schema and page context.',
					'Return only VALID JSON shaped as { "properties": { ... } } (do NOT include "children").',
					'- "properties": must use the exact Notion API structure and respect the provided schema types.',
					'- Title rules: The "title" property is MANDATORY and must be a strong, source-derived headline or entity name. Never return placeholders or generic values such as "Untitled", "New Page", "No title", "Home", or an empty string. Prefer the article title or first H1/H2; if unavailable, use meta og:title/twitter:title; otherwise derive from the URL slug by turning hyphen/underscore-separated words into a clean title. Remove site/section names, sources, categories, bylines, prefixes/suffixes, emojis, quotes, URLs, and separators like "|" or "/". Keep it concise (3–80 characters), Title Case when appropriate, and trim trailing punctuation.'
				].join(' ') },
				{ role: 'user', content: [
					`Database schema (properties):\n${schemaStr}`,
					`\nPage context:\n${contextStr}`,
					'\n\nInstructions:',
					'- Fill as many properties as possible based on the context.',
					'- The "title" property is REQUIRED. Compose the best possible title.',
					'- For select/multi_select: use existing options by exact name. Do NOT create new options by default.',
					'- If a property name suggests an image and there is an image URL, prefer filling that property with the image URL (files external URL shape).',
					'- For dates, if no specific date is found, you may use the current date/time.',
					'- For url, set the page URL if appropriate.',
					'- Omit properties you cannot determine. Do NOT include read-only properties.',
					'- Do NOT include "children". Return ONLY one JSON object shaped as { "properties": { ... } }.'
				].join('\n') }
			];
			if (customInstructions && typeof customInstructions === 'string' && customInstructions.trim()) {
				messages.push({ role: 'user', content: `Custom instructions specific to this database:\n${customInstructions.trim()}` });
			}
			return messages;
		}
		const messages = buildMessages();

		// Call internal LLM endpoint
		const base = new URL(req.url);
		const llmUrl = `${base.origin}/api/llm/chat`;
		const llmResp = await fetch(llmUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model, messages }) });
		if (!llmResp.ok) {
			const t = await llmResp.text().catch(() => '');
			return withCors(req, NextResponse.json({ error: `LLM error: ${t}` }, { status: 500 }));
		}
		const llmJson = await llmResp.json();
		const content = llmJson?.content || '';
		const parsed = extractJsonObject(content) || (content && content.trim().startsWith('{') ? JSON.parse(content) : null);
		if (!parsed || !parsed.properties) return withCors(req, NextResponse.json({ error: 'LLM did not return valid properties JSON' }, { status: 400 }));

		// Ensure URL property if exists in schema
		const urlPropName = Object.entries(db.properties || {}).find(([, def]: any) => def.type === 'url')?.[0];
		if (urlPropName && !parsed.properties[urlPropName] && pageContext.url) parsed.properties[urlPropName] = { url: pageContext.url };

		// Create page (no children here; keep server endpoint minimal)
		const bodyCreate = { parent: { database_id: databaseId }, properties: parsed.properties };
		const created = await notionFetch('/pages', { method: 'POST', body: JSON.stringify(bodyCreate) }, notionToken);
		return withCors(req, NextResponse.json({ page: created }));
	} catch (e: any) {
		return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
	}
}