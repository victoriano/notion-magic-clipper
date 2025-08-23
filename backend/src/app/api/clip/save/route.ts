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
		const saveArticle: boolean = body?.saveArticle !== false; // default true when omitted
		const customizeContent: boolean = body?.customizeContent === true;
		const contentPrompt: string = typeof body?.contentPrompt === 'string' ? body.contentPrompt.trim() : '';
		const reasoning_effort: string | undefined = typeof body?.reasoning_effort === 'string' ? body.reasoning_effort : undefined;
		const verbosity: string | undefined = typeof body?.verbosity === 'string' ? body.verbosity : undefined;
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
		const llmResp = await fetch(llmUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model, messages, reasoning_effort, verbosity }) });
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

		// Prepare children blocks if requested
		function toRichText(text: string) { return [{ type: 'text', text: { content: String(text || '') } }]; }
		function sanitizeBlocks(rawBlocks: any[]): any[] {
			if (!Array.isArray(rawBlocks)) return [];
			const allowed = new Set(['paragraph','heading_1','heading_2','heading_3','bulleted_list_item','numbered_list_item','quote','image']);
			const out: any[] = [];
			for (const b of rawBlocks) {
				if (typeof b === 'string') { out.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: toRichText(b) } }); continue; }
				if (!b || typeof b !== 'object') continue;
				const type = b.type;
				if (!allowed.has(type)) continue;
				if (type === 'image') {
					const url = b?.image?.external?.url || b?.url;
					if (typeof url === 'string' && url) { out.push({ object: 'block', type: 'image', image: { external: { url } } }); }
					continue;
				}
				const field = (b as any)[type];
				const txt = field?.rich_text || field?.text || (b as any).text || (b as any).content || '';
				out.push({ object: 'block', type, [type]: { rich_text: Array.isArray(txt) ? txt : toRichText(txt) } });
			}
			return out;
		}

		let children: any[] = [];
		if (saveArticle) {
			if (Array.isArray(pageContext?.articleBlocks) && pageContext.articleBlocks.length) {
				children = sanitizeBlocks(pageContext.articleBlocks);
			} else if (customizeContent && contentPrompt && typeof pageContext?.article?.html === 'string' && pageContext.article.html.length) {
				// Ask the LLM to transform the article HTML into Notion blocks
				const transformMessages = [
					{ role: 'system', content: [
						'You convert ARTICLE HTML into a JSON array of Notion blocks according to the user instructions.',
						'Output rules: Return ONLY a raw JSON array (no wrapper object, no code fences).',
						'Allowed block types: paragraph, heading_1, heading_2, heading_3, bulleted_list_item, numbered_list_item, quote, image.',
						'For text blocks use simple rich_text with plain text only.'
					].join(' ') },
					{ role: 'user', content: `Article HTML:\n${pageContext.article.html}` },
					{ role: 'user', content: `Transform instructions:\n${contentPrompt}` }
				];
				try {
					const tResp = await fetch(llmUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model, messages: transformMessages, reasoning_effort, verbosity }) });
					if (tResp.ok) {
						const tJson = await tResp.json();
						const raw = tJson?.content || '';
						let parsedBlocks: any = null;
						const trim = typeof raw === 'string' ? raw.trim() : '';
						if (trim.startsWith('[')) { try { parsedBlocks = JSON.parse(trim); } catch {} }
						if (!parsedBlocks) { try { parsedBlocks = JSON.parse(raw); } catch {} }
						if (!parsedBlocks) { parsedBlocks = null; }
						if (Array.isArray(parsedBlocks)) children = sanitizeBlocks(parsedBlocks);
					}
				} catch {}
			}
		}

		const firstBatch = Array.isArray(children) ? children.slice(0, 100) : [];
		const bodyCreate: any = { parent: { database_id: databaseId }, properties: parsed.properties };
		if (firstBatch.length > 0) bodyCreate.children = firstBatch;
		const created = await notionFetch('/pages', { method: 'POST', body: JSON.stringify(bodyCreate) }, notionToken);
		// Append remaining children if any
		const rest = Array.isArray(children) ? children.slice(100) : [];
		const parentId = created?.id;
		for (let i = 0; i < rest.length && parentId; i += 100) {
			const chunk = rest.slice(i, i + 100);
			try { await notionFetch(`/blocks/${parentId}/children`, { method: 'PATCH', body: JSON.stringify({ children: chunk }) }, notionToken); } catch {}
		}
		return withCors(req, NextResponse.json({ page: created }));
	} catch (e: any) {
		return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
	}
}