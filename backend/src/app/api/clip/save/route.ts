import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { tasks } from '@trigger.dev/sdk';
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

// --- Image materialization helpers ---
function redactUrl(u: string) {
	try { const x = new URL(u); x.search = ''; return x.href; } catch { return String(u).split('?')[0]; }
}
function buildImageFetchHeaders(imageUrl: string, refererUrl?: string): Record<string,string> {
	const headers: Record<string,string> = {
		'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
		'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
		'Accept-Language': 'en-US,en;q=0.9'
	};
	try {
		const u = new URL(imageUrl);
		if (u.hostname.endsWith('x.com') || u.hostname.endsWith('twimg.com')) headers['Referer'] = 'https://x.com/';
		else if (refererUrl) headers['Referer'] = refererUrl;
	} catch {}
	return headers;
}
async function startFileUpload(filename: string, token: string, contentType?: string) {
	const body: any = { mode: 'single_part', filename: filename || 'upload.bin' };
	if (contentType && typeof contentType === 'string') body.content_type = contentType;
	const data = await notionFetch('/file_uploads', { method: 'POST', body: JSON.stringify(body) }, token);
	return {
		id: data?.id,
		upload_url: data?.upload_url || data?.url,
		upload_headers: data?.upload_headers || data?.headers,
		upload_fields: data?.upload_fields || data?.fields || data?.form || data?.form_fields
	};
}

function guessFilenameFromUrl(u: string, fallback = 'image') {
	try { const url = new URL(u); const base = url.pathname.split('/').pop(); if (base) return base; } catch {}
	return `${fallback}.bin`;
}

async function uploadExternalImageToNotion(imageUrl: string, token: string, diags?: any[], refererUrl?: string) {
	try {
		const diagBase: any = { url: redactUrl(imageUrl) };
		let resp: any;
		try {
			resp = await fetch(imageUrl, { headers: buildImageFetchHeaders(imageUrl, refererUrl) } as any);
			if (!resp.ok) {
				if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'fetch', ok: false, status: resp.status, statusText: resp.statusText });
				throw new Error(`fetch ${resp.status}`);
			}
		} catch (e: any) {
			if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'fetch', ok: false, error: String(e?.message || e) });
			throw e;
		}
		const blob = await resp.blob();
		const size = Number((blob as any).size || 0);
		const type = String((blob as any).type || '');
		if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'fetched', ok: true, size, type });
		if (size && size > 20 * 1024 * 1024) {
			if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'guard', ok: false, reason: 'image too large (>20MB)' });
			throw new Error('image too large');
		}
		function extensionForMime(mime: string): string | null {
			const m = (mime || '').toLowerCase();
			if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
			if (m === 'image/png') return '.png';
			if (m === 'image/webp') return '.webp';
			if (m === 'image/gif') return '.gif';
			if (m === 'image/svg+xml') return '.svg';
			if (m === 'image/heic') return '.heic';
			if (m === 'image/heif') return '.heif';
			return null;
		}
		let filename = guessFilenameFromUrl(imageUrl, 'image');
		const mimeExt = extensionForMime(type) || '.bin';
		if (!/\.[A-Za-z0-9]+$/.test(filename)) filename += mimeExt;
		else {
			const currentExt = filename.slice(filename.lastIndexOf('.'));
			if (mimeExt && currentExt.toLowerCase() !== mimeExt) filename = filename.replace(/\.[A-Za-z0-9]+$/, mimeExt);
		}
		let upInit;
		try {
			upInit = await startFileUpload(filename, token, type || undefined);
			if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'start_file_upload', ok: true, file_upload_id: upInit?.id });
		} catch (e: any) {
			if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'start_file_upload', ok: false, error: String(e?.message || e) });
			throw e;
		}
		let up: any;
		if (upInit.upload_fields && typeof upInit.upload_fields === 'object') {
			const fd = new FormData();
			for (const [k, v] of Object.entries(upInit.upload_fields)) (fd as any).append(k, v as any);
			const file = new File([blob], filename, { type: (blob as any).type || 'application/octet-stream' });
			(fd as any).append('file', file);
			const headers: any = {};
			if (upInit.upload_headers && typeof upInit.upload_headers === 'object') {
				for (const [k, v] of Object.entries(upInit.upload_headers)) headers[k] = v as any;
			}
			up = await fetch(upInit.upload_url, { method: 'POST', headers, body: fd as any });
			if (!up.ok) {
				const body = await up.text().catch(() => '');
				if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'upload', method: 'POST', ok: false, status: up.status, body: String(body).slice(0, 500) });
				throw new Error(`upload ${up.status} POST-policy`);
			}
			if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'upload', method: 'POST', ok: true, status: up.status });
		} else {
			let targetHost = '';
			try { targetHost = new URL(upInit.upload_url).hostname; } catch {}
			if (targetHost.endsWith('notion.com')) {
				// Notion direct upload endpoint expects multipart/form-data with 'file' and auth headers
				const fd = new FormData();
				const file = new File([blob], filename, { type: (blob as any).type || 'application/octet-stream' });
				(fd as any).append('file', file);
				const postHeaders: any = {};
				if (upInit.upload_headers && typeof upInit.upload_headers === 'object') {
					for (const [k, v] of Object.entries(upInit.upload_headers)) {
						// Do not override Content-Type for multipart
						if (String(k).toLowerCase() === 'content-type') continue;
						postHeaders[k] = v as any;
					}
				}
				// Ensure auth + version headers are present
				postHeaders['Authorization'] = `Bearer ${token}`;
				postHeaders['Notion-Version'] = '2022-06-28';
				up = await fetch(upInit.upload_url, { method: 'POST', headers: postHeaders, body: fd as any });
				if (!up.ok) {
					const body = await up.text().catch(() => '');
					if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'upload', method: 'POST-notion', ok: false, status: up.status, body: String(body).slice(0, 500) });
					throw new Error(`upload ${up.status} POST-notion`);
				}
				if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'upload', method: 'POST-notion', ok: true, status: up.status });
			} else {
				const headers: any = { 'Content-Type': (blob as any).type || 'application/octet-stream' };
				if (upInit.upload_headers && typeof upInit.upload_headers === 'object') {
					for (const [k, v] of Object.entries(upInit.upload_headers)) headers[k] = v as any;
				}
				up = await fetch(upInit.upload_url, { method: 'PUT', headers, body: blob as any });
				if (!up.ok) {
					const body = await up.text().catch(() => '');
					if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'upload', method: 'PUT', ok: false, status: up.status, body: String(body).slice(0, 500) });
					throw new Error(`upload ${up.status} PUT`);
				}
				if (Array.isArray(diags)) diags.push({ ...diagBase, step: 'upload', method: 'PUT', ok: true, status: up.status });
			}
		}
		return { file_upload_id: upInit.id };
	} catch {
		return null;
	}
}

async function materializeExternalImagesInPropsAndBlocks(db: any, props: any, blocks: any[], token: string, maxUploads = 24, diags?: any[], refererUrl?: string) {
	let uploads = 0;
	const tryUpload = async (url: string) => {
		if (uploads >= maxUploads) return null;
		const res = await uploadExternalImageToNotion(url, token, diags, refererUrl);
		if (res && (res as any).file_upload_id) uploads += 1;
		return res;
	};
	// files properties
	for (const [propName, def] of Object.entries(db.properties || {})) {
		if ((def as any).type !== 'files') continue;
		const v = (props || {})[propName as string];
		const items = v?.files;
		if (!Array.isArray(items) || !items.length) continue;
		const out: any[] = [];
		for (const it of items) {
			if (it?.file_upload?.id || it?.file_upload?.file_upload_id) { out.push(it); continue; }
			const ext = it?.external?.url || it?.url;
			if (typeof ext === 'string') {
				const up = await tryUpload(ext);
				if (up) { const fid = (up as any).file_upload_id; out.push({ name: it?.name || 'image', file_upload: { id: fid } }); continue; }
			}
		}
		(props as any)[propName] = { files: out };
	}
	// image blocks
	for (const b of Array.isArray(blocks) ? blocks : []) {
		if (!b || b.type !== 'image') continue;
		const ext = b.image?.external?.url || (b as any).url;
		if (typeof ext === 'string') {
			const up = await tryUpload(ext);
			if (up) { const fid = (up as any).file_upload_id; b.image = { file_upload: { id: fid } }; }
		}
	}
	// Drop only Twitter/X images that couldn't be materialized; keep other externals
	if (Array.isArray(blocks) && blocks.length) {
		for (let i = blocks.length - 1; i >= 0; i--) {
			const blk: any = blocks[i];
			if (blk && blk.type === 'image') {
				const hasUpload = !!(blk?.image?.file_upload?.id);
				if (!hasUpload) {
					let host = '';
					try { const u = new URL(blk?.image?.external?.url || ''); host = u.hostname; } catch {}
					if (host.endsWith('twimg.com') || host.endsWith('x.com')) blocks.splice(i, 1);
				}
			}
		}
	}
}
// --- end helpers ---

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

		// If Trigger.dev is configured, enqueue the work and return immediately (asynchronous processing)
		const hasTrigger = Boolean(process.env.TRIGGER_SECRET_KEY) && Boolean(process.env.TRIGGER_PROJECT_ID);
		if (hasTrigger) {
			try {
				// Create a save tracking row so the client can await completion
				let saveId: string | null = null;
				try {
					const { data: inserted, error: insErr } = await supabaseAdmin
						.from('notion_saves')
						.insert({ user_id: userId, database_id: databaseId, source_url: pageContext?.url || '', status: 'queued', provider, model })
						.select()
						.single();
					if (insErr) throw insErr;
					saveId = inserted?.id || null;
				} catch (e) {
					// Non-fatal: continue without saveId if insert fails
				}

				const payload = {
					userId,
					databaseId,
					pageContext,
					customInstructions,
					provider,
					model,
					saveArticle,
					customizeContent,
					contentPrompt,
					reasoning_effort,
					verbosity,
					// Pass saveId so the worker can update the same row
					saveId,
				};
				try {
					const run = await tasks.trigger('saveToNotion', payload);
					// Attach run metadata to the save row if we created one
					try {
						if (saveId) {
							const runId: any = (run as any)?.id || (run as any)?.run?.id || null;
							await supabaseAdmin
								.from('notion_saves')
								.update({ run_id: runId || null, task_id: 'saveToNotion', status: 'queued', provider, model })
								.eq('id', saveId)
								.eq('user_id', userId);
						}
					} catch {}
					// Return a neutral stub (no source URL) to avoid showing the original URL in the popup
					const stub = { object: 'page', id: 'pending', url: '', public_url: '' } as const;
					const res = NextResponse.json({ enqueued: true, task: 'saveToNotion', run, saveId, page: stub, uploadDiagnostics: [] }, { status: 202 });
					res.headers.set('X-Trigger-Used', '1');
					return withCors(req, res);
				} catch (e) {
					console.log('[save] tasks.trigger failed, falling back to sync', e);
				}
			} catch (e: any) {
				return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
			}
		}

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
			const { url, title, meta, selectionText, textSample, headings, listItems, shortSpans, attrTexts, images, article } = pageContext || {};
			const useArticle = saveArticle;
			const schemaStr = JSON.stringify(schemaForLLM, null, 2);

			// If we should not use the article, ensure we provide a sample: use existing textSample or derive from article.text
			let effectiveTextSample = textSample;
			if (!useArticle) {
				if (!effectiveTextSample && article && typeof article.text === 'string') {
					try {
						const parts = article.text.split(/\n\s*\n+/).map((s: string) => s.trim()).filter(Boolean);
						effectiveTextSample = parts.slice(0, 10).join('\n\n').slice(0, 6000);
					} catch {}
				}
			}

			// Build a slimmer context when article is present
			let baseContext: any;
			if (useArticle && article) {
				baseContext = { url, title, meta, selectionText, article: { title: article.title, text: article.text }, images };
			} else {
				baseContext = { url, title, meta, selectionText, headings, listItems, shortSpans, attrTexts, images };
			}
			if (useArticle && !article) {
				// If useArticle requested but no article, keep non-article context
			}
			if (effectiveTextSample) Object.assign(baseContext, { textSample: effectiveTextSample });
			const contextStr = JSON.stringify(baseContext, null, 2);
			const messages = [
				{
					role: 'system',
					content: [
					'You are an assistant that generates Notion PROPERTIES only from a database schema and page context.',
					'Return only VALID JSON shaped as { "properties": { ... } } (do NOT include "children").',
					'- "properties": must use the exact Notion API structure and respect the provided schema types.',
					].join(' ')
				},
				{
					role: 'user',
					content: [
					`Database schema (properties):\n${schemaStr}`,
					`\nPage context:\n${contextStr}`,
					'\n\nInstructions:',
						'- Fill as many properties as possible based on the context.',
						'- Title rules: The "title" property is MANDATORY and must be a strong, source-derived headline or entity name. Never return placeholders or generic values such as "Untitled", "New Page", "No title", "Home", or an empty string. Prefer the article title or first H1/H2; if unavailable, use meta og:title/twitter:title; otherwise derive from the URL slug by turning hyphen/underscore-separated words into a clean title. Remove site names (like IMDB, Wikipedia, etc.) and section names of the page, sources, categories, bylines, prefixes/suffixes, emojis, quotes, URLs, and separators like "|" or "/". Keep it concise (3–80 characters), Title Case when appropriate, and trim trailing punctuation.',
						'- For select/multi_select: use existing options by exact name. Do NOT create new options by default. Only propose new options if the custom database instructions explicitly allow creating options. If no clear match exists and creation is not allowed, omit the property.',
						'- If a property name suggests an image (e.g., "Poster", "Cover", "Thumbnail", "Artwork", "Image", "Screenshot") and the page context contains an image URL (e.g., og:image or twitter:image), prefer filling that property with the image URL. If the database uses a files property, use the Notion files property shape with an external URL. Optionally, also add an image block to children using the same URL.',
						'- When choosing among multiple images, prefer medium-to-large content images (avoid tiny icons/sprites). As a heuristic, prioritize images where width or height ≥ 256px and de-prioritize those < 64px. Use the collected image context (alt text, nearest heading, parent text, classes, and any width/height or rendered sizes) to decide.',
						'- For dates, if no specific date is found in the content, you may use the current date/time.',
						'- For url, set the page URL if an appropriate property exists.',
						'- Omit properties you cannot determine (do not invent values).',
						'- Do NOT include read-only properties (rollup, created_time, etc.).',
						'- Do NOT generate "children". Return ONLY one JSON object shaped as { "properties": { ... } }.'
					].join('\n')
				}
			];
			if (customInstructions && typeof customInstructions === 'string' && customInstructions.trim().length > 0) {
				messages.push({
					role: 'user',
					content: `Custom instructions specific to this database:\n${customInstructions.trim()}`
				});
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

		// Sanitize and normalize properties to valid Notion API shapes
		function toRichText(text: string) {
			const content = typeof text === 'string' ? text : '';
			return [{ type: 'text', text: { content } }];
		}
		function sanitizeRichTextArray(arr: any[]): any[] {
			const out: any[] = [];
			const MAX = 20;
			function make(text: string, linkUrl?: string) {
				const content = String(text || '').slice(0, 2000);
				const base: any = { type: 'text', text: { content } };
				if (linkUrl && typeof linkUrl === 'string') base.text.link = { url: linkUrl };
				return base;
			}
			for (const it of Array.isArray(arr) ? arr : []) {
				if (out.length >= MAX) break;
				if (typeof it === 'string') { out.push(make(it)); continue; }
				if (it && typeof it === 'object') {
					if ((it as any).type === 'text' && (it as any).text?.content) { out.push(it); continue; }
					if (typeof (it as any).plain_text === 'string') { out.push(make((it as any).plain_text, (it as any).href)); continue; }
					if (typeof (it as any).content === 'string') { out.push(make((it as any).content)); continue; }
				}
			}
			if (out.length === 0) out.push(make(''));
			return out;
		}
		function normalizeValueByType(def: any, value: any): any | undefined {
			const type = def.type;
			if (value == null) return undefined;
			switch (type) {
				case 'title': {
					if (Array.isArray(value?.title)) return { title: sanitizeRichTextArray(value.title) };
					if (typeof value === 'string') return { title: toRichText(value) };
					if (typeof value?.text === 'string') return { title: toRichText(value.text) };
					if (Array.isArray(value)) return { title: sanitizeRichTextArray(value) };
					return undefined;
				}
				case 'rich_text': {
					if (Array.isArray(value?.rich_text)) return { rich_text: sanitizeRichTextArray(value.rich_text) };
					if (typeof value === 'string') return { rich_text: toRichText(value) };
					if (typeof value?.text === 'string') return { rich_text: toRichText(value.text) };
					if (Array.isArray(value)) return { rich_text: sanitizeRichTextArray(value) };
					return undefined;
				}
				case 'url': {
					const url = typeof value === 'string' ? value : value?.url;
					if (typeof url === 'string' && url.length > 0) return { url };
					return undefined;
				}
				case 'files': {
					const arr = Array.isArray(value) ? value : (Array.isArray(value?.files) ? value.files : undefined);
					if (!Array.isArray(arr)) return undefined;
					const files: any[] = [];
					for (const item of arr) {
						if (!item) continue;
						if (typeof item === 'string') { files.push({ name: 'file', external: { url: item } }); continue; }
						if (typeof item?.url === 'string') { files.push({ name: item.name || 'file', external: { url: item.url } }); continue; }
						if (item.external?.url) { files.push({ name: item.name || 'file', external: { url: item.external.url } }); continue; }
					}
					return files.length ? { files } : undefined;
				}
				case 'email': {
					const email = typeof value === 'string' ? value : value?.email;
					if (typeof email === 'string' && email.length > 0) return { email };
					return undefined;
				}
				case 'phone_number': {
					const phone = typeof value === 'string' ? value : value?.phone_number;
					if (typeof phone === 'string' && phone.length > 0) return { phone_number: phone };
					return undefined;
				}
				case 'number': {
					const num = typeof value === 'number' ? value : Number(value?.number ?? value);
					if (!Number.isNaN(num)) return { number: num };
					return undefined;
				}
				case 'checkbox': {
					const bool = typeof value === 'boolean' ? value : (typeof value === 'string' ? value.toLowerCase() === 'true' : undefined);
					if (typeof bool === 'boolean') return { checkbox: bool };
					return undefined;
				}
				case 'select': {
					const name = typeof value === 'string' ? value : value?.select?.name ?? value?.name;
					if (typeof name === 'string' && name.trim().length > 0) return { select: { name: name.trim() } };
					return undefined;
				}
				case 'multi_select': {
					const arr = Array.isArray(value) ? value : (Array.isArray(value?.multi_select) ? value.multi_select : (typeof value === 'string' ? value.split(',') : undefined));
					if (Array.isArray(arr)) {
						const cleaned = arr.map((v: any) => (typeof v === 'string' ? v.trim() : v?.name)).filter((n: any) => typeof n === 'string' && n.length > 0).map((name: string) => ({ name }));
						if (cleaned.length > 0) return { multi_select: cleaned };
					}
					return undefined;
				}
				case 'status': {
					const name = typeof value === 'string' ? value : value?.status?.name ?? value?.name;
					if (typeof name === 'string' && name.length > 0) return { status: { name } };
					return undefined;
				}
				case 'date': {
					if (typeof value === 'string') return { date: { start: value } };
					if (value && typeof value === 'object') {
						if (typeof value.date === 'string') return { date: { start: value.date } };
						if (value.date && typeof value.date === 'object') {
							const d: any = value.date;
							const cleaned: any = {};
							if (typeof d.start === 'string') cleaned.start = d.start;
							if (typeof d.end === 'string') cleaned.end = d.end;
							if (typeof d.time_zone === 'string') cleaned.time_zone = d.time_zone;
							if (Object.keys(cleaned).length > 0) return { date: cleaned };
						}
						if (typeof value.start === 'string' || typeof value.end === 'string' || typeof value.time_zone === 'string') {
							const cleaned: any = {};
							if (typeof value.start === 'string') cleaned.start = value.start;
							if (typeof value.end === 'string') cleaned.end = value.end;
							if (typeof value.time_zone === 'string') cleaned.time_zone = value.time_zone;
							return { date: cleaned };
						}
					}
					return undefined;
				}
				default: return undefined;
			}
		}
		function sanitizeProperties(dbObj: any, props: any): any {
			const out: any = {};
			const schema = dbObj.properties || {};
			for (const [propName, def] of Object.entries(schema)) {
				const raw = (props || {})[propName as string];
				if (raw === undefined) continue;
				const normalized = normalizeValueByType(def, raw);
				if (normalized && typeof normalized === 'object' && Object.keys(normalized).length > 0) out[propName as string] = normalized;
			}
			return out;
		}
		let safeProps = sanitizeProperties(db, parsed.properties);
		// Ensure title property exists and is non-empty/non-placeholder
		const titlePropName = Object.entries(db.properties || {}).find(([, def]: any) => def.type === 'title')?.[0];
		if (titlePropName) {
			const computedTitle = String(pageContext.title || pageContext.meta?.['og:title'] || pageContext.url || 'Untitled');
			const existing: any = (safeProps as any)[titlePropName];
			function extractPlainText(arr: any[]): string {
				if (!Array.isArray(arr)) return '';
				return arr
					.map((r: any) => (typeof r?.text?.content === 'string' ? r.text.content : (typeof r?.plain_text === 'string' ? r.plain_text : '')))
					.filter(Boolean)
					.join(' ')
					.trim();
			}
			function isPlaceholderTitle(s: string): boolean {
				const v = s.trim().toLowerCase();
				return v === '' || v === 'untitled' || v === 'new page' || v === 'no title' || v === 'home';
			}
			const existingText = extractPlainText(existing?.title);
			const hasValidTitle = typeof existingText === 'string' && !isPlaceholderTitle(existingText);
			if (!hasValidTitle) (safeProps as any)[titlePropName] = { title: toRichText(computedTitle) };
		}

		// Ensure select/multi_select options exist (auto-create missing ones when capacity allows)
		async function ensureSelectOptions(databaseId: string, props: any) {
			const updates: any = {};
			for (const [propName, def] of Object.entries(db.properties || {}) as [string, any][]) {
				const incoming = (props as any)[propName];
				if (!incoming) continue;
				if (def.type === 'select' && incoming.select?.name) {
					const existingOpts = (def as any).select?.options || [];
					const existingNames = new Set(existingOpts.map((o: any) => o.name));
					const desired = String(incoming.select.name).trim();
					if (!existingNames.has(desired)) {
						const capacity = Math.max(0, 100 - existingOpts.length);
						if (capacity > 0) { updates[propName] = existingOpts.concat([{ name: desired, color: 'default' }]); }
					}
				}
				if (def.type === 'multi_select' && Array.isArray(incoming.multi_select)) {
					const existingOpts = (def as any).multi_select?.options || [];
					const existingNames = new Set(existingOpts.map((o: any) => o.name));
					const desiredNames = incoming.multi_select.map((o: any) => o.name).filter((n: any) => typeof n === 'string' && n.trim().length > 0);
					const missing = desiredNames.filter((n: string) => !existingNames.has(n));
					const capacity = Math.max(0, 100 - existingOpts.length);
					const toAdd = missing.slice(0, capacity).map((n: string) => ({ name: n, color: 'default' }));
					if (toAdd.length > 0) updates[propName] = existingOpts.concat(toAdd);
				}
			}
			if (Object.keys(updates).length > 0) {
				await notionFetch(`/databases/${databaseId}`, { method: 'PATCH', body: JSON.stringify({ properties: Object.fromEntries(Object.entries(updates).map(([k,v]) => {
					const def: any = (db.properties as any)[k];
					if (def.type === 'select') return [k, { select: { options: v } }];
					if (def.type === 'multi_select') return [k, { multi_select: { options: v } }];
					return [k, v];
				})) }) }, notionToken as string);
			}
		}
		await ensureSelectOptions(databaseId, safeProps);

		// Prepare children blocks if requested
		function toRichTextBlock(text: string) { return [{ type: 'text', text: { content: String(text || '') } }]; }
		function sanitizeBlocks(rawBlocks: any[]): any[] {
			if (!Array.isArray(rawBlocks)) return [];
			const allowed = new Set(['paragraph','heading_1','heading_2','heading_3','bulleted_list_item','numbered_list_item','quote','image']);
			function normalizeRichTextArray(value: any): any[] {
				const list = Array.isArray(value) ? value : [value];
				const out: any[] = [];
				for (const it of list) {
					if (typeof it === 'string') { out.push({ type: 'text', text: { content: it } }); continue; }
					if (it && typeof it === 'object') {
						// Proper shape
						if (it.type === 'text' && it.text && typeof it.text.content === 'string') { out.push(it); continue; }
						// Common loose shapes -> normalize
						const fromPlain = typeof (it as any).plain_text === 'string' ? (it as any).plain_text : undefined;
						const fromContent = typeof (it as any).content === 'string' ? (it as any).content : undefined;
						const fromText = typeof (it as any).text === 'string' ? (it as any).text : undefined;
						const chosen = fromPlain ?? fromContent ?? fromText;
						if (typeof chosen === 'string') { out.push({ type: 'text', text: { content: chosen } }); continue; }
					}
				}
				if (out.length === 0) out.push({ type: 'text', text: { content: '' } });
				return out;
			}
			const out: any[] = [];
			for (const b of rawBlocks) {
				if (typeof b === 'string') { out.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: toRichTextBlock(b) } }); continue; }
				if (!b || typeof b !== 'object') continue;
				const type = b.type;
				if (!allowed.has(type)) continue;
				if (type === 'image') {
					const url = b?.image?.external?.url || (b as any).url;
					if (typeof url === 'string' && url) { out.push({ object: 'block', type: 'image', image: { external: { url } } }); }
					continue;
				}
				const field = (b as any)[type];
				const txt = field?.rich_text ?? field?.text ?? (b as any).text ?? (b as any).content ?? '';
				const rich = normalizeRichTextArray(txt);
				out.push({ object: 'block', type, [type]: { rich_text: rich } });
			}
			return out;
		}

		let children: any[] = [];
		if (saveArticle) {
			// First pass: deterministic article blocks if provided by the client
			if (Array.isArray(pageContext?.articleBlocks) && pageContext.articleBlocks.length) {
				children = sanitizeBlocks(pageContext.articleBlocks);
			}
			// Optional: LLM-based customization pass when requested (even if we had articleBlocks)
			if (customizeContent && contentPrompt && typeof pageContext?.article?.html === 'string' && pageContext.article.html.length) {
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
						// 1) pure array
						if (trim.startsWith('[')) { try { parsedBlocks = JSON.parse(trim); } catch {} }
						// 2) try direct parse
						if (!parsedBlocks) { try { parsedBlocks = JSON.parse(raw); } catch {} }
						// 3) fenced JSON array
						if (!parsedBlocks) {
							const fence = String(raw).match(/```(?:json)?\n([\s\S]*?)\n```/i);
							if (fence) { try { parsedBlocks = JSON.parse(fence[1]); } catch {} }
						}
						// 4) object wrappers
						if (parsedBlocks && !Array.isArray(parsedBlocks)) {
							if (Array.isArray(parsedBlocks.children)) parsedBlocks = parsedBlocks.children;
							else if (Array.isArray((parsedBlocks as any).blocks)) parsedBlocks = (parsedBlocks as any).blocks;
							else if (Array.isArray((parsedBlocks as any).content)) parsedBlocks = (parsedBlocks as any).content;
						}
						if (Array.isArray(parsedBlocks)) {
							const safeTransformed = sanitizeBlocks(parsedBlocks);
							if (safeTransformed.length > 0) children = safeTransformed;
						}
					}
				} catch {}
			}
			// Fallback: images + summary paragraph when we still have no children
			if (!children || !Array.isArray(children) || children.length === 0) {
				const imageOnly = (Array.isArray(pageContext.articleBlocks) ? sanitizeBlocks(pageContext.articleBlocks) : [])
					.filter((b) => b && b.type === 'image')
					.slice(0, 30);
				let summaryBlocks: any[] = [];
				try {
					const contextText = String(pageContext.article?.text || pageContext.textSample || '').slice(0, 4000);
					const summaryMessages = [
						{ role: 'system', content: 'Return only a JSON array with a single Notion paragraph block that briefly explains why this insight matters now. Use neutral, concise language (1-2 sentences).' },
						{ role: 'user', content: `Context:\n${contextText}` },
						{ role: 'user', content: `Additional instructions for the paragraph:\n${contentPrompt || ''}` }
					];
					const sResp = await fetch(llmUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model, messages: summaryMessages, reasoning_effort, verbosity }) });
					if (sResp.ok) {
						const sJson = await sResp.json();
						const raw = sJson?.content || '';
						let arr = extractJsonObject(raw) || [];
						if (typeof raw === 'string' && raw.trim().startsWith('[')) { try { arr = JSON.parse(raw); } catch {} }
						const safe = sanitizeBlocks(Array.isArray(arr) ? arr : (arr?.children || []));
						if (Array.isArray(safe) && safe.length) summaryBlocks = safe.slice(0, 1);
					}
				} catch {}
				if (summaryBlocks.length === 0) summaryBlocks = [{ object: 'block', type: 'paragraph', paragraph: { rich_text: toRichTextBlock('Summary unavailable.') } }];
				children = imageOnly.concat(summaryBlocks);
			}
		}

		// Materialize external images into Notion uploads (both in blocks and files properties)
		const uploadDiagnostics: any[] = [];
		await materializeExternalImagesInPropsAndBlocks(db, safeProps, children, notionToken, 6, uploadDiagnostics, pageContext?.url);

		const firstBatch = Array.isArray(children) ? children.slice(0, 100) : [];
		const bodyCreate: any = { parent: { database_id: databaseId }, properties: safeProps };
		if (firstBatch.length > 0) bodyCreate.children = firstBatch;
		const created = await notionFetch('/pages', { method: 'POST', body: JSON.stringify(bodyCreate) }, notionToken);
		// Append remaining children if any
		const rest = Array.isArray(children) ? children.slice(100) : [];
		const parentId = created?.id;
		for (let i = 0; i < rest.length && parentId; i += 100) {
			const chunk = rest.slice(i, i + 100);
			try { await notionFetch(`/blocks/${parentId}/children`, { method: 'PATCH', body: JSON.stringify({ children: chunk }) }, notionToken); } catch {}
		}
		return withCors(req, NextResponse.json({ page: created, uploadDiagnostics }));
	} catch (e: any) {
		return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
	}
}