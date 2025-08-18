// background.js (service worker)
// Handles Notion API and OpenAI API calls, and coordinates saving pages
import { searchUntitledDatabases } from './utils/untitledDatabases.js';
import { searchAllDatabases } from './utils/listAllDatabases.js';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28'; // latest per Notion docs
const OPENAI_API_BASE = 'https://api.openai.com/v1';
const GPT5_NANO_MODEL = 'gpt-5-nano';
const GOOGLE_GENAI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Debug logging helper
const DEBUG_LOGS = true;
function dbgBg(...args) {
  if (!DEBUG_LOGS) return;
  const ts = new Date().toISOString();
  console.log(`[NotionMagicClipper][BG ${ts}]`, ...args);
}

// Produce a compact, safe view of large objects for logging
function sanitizeForLog(value, depth = 0) {
  const MAX_DEPTH = 3;
  const MAX_STRING = 300;
  const MAX_ARRAY = 5;
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '…';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((v) => sanitizeForLog(v, depth + 1)).concat(value.length > MAX_ARRAY ? ['…'] : []);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = sanitizeForLog(v, depth + 1);
  }
  return out;
}

// Helpers to get/set tokens in storage
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        'notionToken',
        'openaiKey',
        'googleApiKey',
        'notionSearchQuery',
        'openai_reasoning_effort',
        'openai_verbosity',
        'databasePrompts',
        'databaseSettings',
        'llmProvider',
        'llmModel',
        'workspaceTokens',
        'dbWorkspaceMap'
      ],
      (res) => resolve(res)
    );
  });
}

// Notion API helpers
async function notionFetch(path, options = {}, tokenOverride) {
  const { notionToken } = await getConfig();
  const effectiveToken = tokenOverride || notionToken;
  if (!effectiveToken) throw new Error('Missing Notion token. Configure it.');

  const headers = {
    'Authorization': `Bearer ${effectiveToken}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const resp = await fetch(`${NOTION_API_BASE}${path}`, {
    ...options,
    headers
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Notion API ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function listDatabases(query = '') {
  // Uses /v1/search with filter for databases
  const body = {
    query,
    filter: { property: 'object', value: 'database' },
    sort: { direction: 'ascending', timestamp: 'last_edited_time' }
  };
  const data = await notionFetch('/search', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  // Map to simple structure
  const results = (data.results || []).map((item) => {
    const title = (item.title || [])
      .map((t) => t.plain_text)
      .join('') || '(Sin título)';
    const iconEmoji = item?.icon?.type === 'emoji' ? item.icon.emoji : undefined;
    const url = item?.url || `https://www.notion.so/${String(item?.id || '').replace(/-/g, '')}`;
    return { id: item.id, title, iconEmoji, url };
  });
  return results;
}

async function getDatabase(databaseId, token) {
  return notionFetch(`/databases/${databaseId}`, {}, token);
}

async function createPageInDatabase(databaseId, properties, pageContentBlocks = [], token) {
  const body = {
    parent: { database_id: databaseId },
    properties,
    ...(pageContentBlocks.length ? { children: pageContentBlocks } : {})
  };
  return notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify(body)
  }, token);
}

// Append up to 100 child blocks to a page or block
async function appendChildrenBlocks(parentBlockId, children = [], token) {
  if (!Array.isArray(children) || children.length === 0) return null;
  return notionFetch(`/blocks/${parentBlockId}/children`, {
    method: 'PATCH',
    body: JSON.stringify({ children })
  }, token);
}

// Start a direct (single-part) file upload; returns { file_upload_id, upload_url }
async function startFileUpload(filename, token) {
  const body = { mode: 'single_part', filename: filename || 'upload.bin' };
  const data = await notionFetch('/file_uploads', { method: 'POST', body: JSON.stringify(body) }, token);
  // Return as much as possible to support different upload styles (PUT vs POST form)
  return {
    id: data?.id,
    file_upload_id: data?.id,
    upload_url: data?.upload_url || data?.url,
    upload_headers: data?.upload_headers || data?.headers,
    upload_fields: data?.upload_fields || data?.fields || data?.form || data?.form_fields
  };
}

function normalizeExternalImageUrl(raw) {
  try {
    const u = new URL(raw, location.href);
    if ((u.hostname === 'www.notion.so' || u.hostname.endsWith('.notion.so')) && u.pathname.startsWith('/image/')) {
      const qp = u.searchParams.get('url');
      if (qp) return decodeURIComponent(qp);
      const enc = u.pathname.replace(/^\/image\//, '');
      if (enc) return decodeURIComponent(enc);
    }
    return u.href;
  } catch {
    return raw;
  }
}

function redactUrl(u) {
  try {
    const x = new URL(u);
    x.search = '';
    return x.href;
  } catch {
    return String(u).split('?')[0];
  }
}

async function uploadExternalImageToNotion(imageUrl) {
  try {
    const normalized = normalizeExternalImageUrl(imageUrl);
    const urlObj = new URL(normalized, location.href);
    const pathname = urlObj.pathname || '';
    const base = pathname.split('/').pop() || 'image';
    function extensionForMime(mime) {
      if (!mime) return null;
      const m = mime.toLowerCase();
      if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
      if (m === 'image/png') return '.png';
      if (m === 'image/webp') return '.webp';
      if (m === 'image/gif') return '.gif';
      if (m === 'image/svg+xml') return '.svg';
      if (m === 'image/heic') return '.heic';
      if (m === 'image/heif') return '.heif';
      return null;
    }
    dbgBg('UPLOAD: fetching external image', { original: redactUrl(imageUrl), normalized: redactUrl(normalized) });
    const resp = await fetch(normalized, { mode: 'cors' });
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    const blob = await resp.blob();
    // Guard: 20MB single-part limit (approx)
    if (blob.size > 20 * 1024 * 1024) throw new Error('image too large (>20MB)');
    // Choose filename that matches the blob MIME type to avoid Notion content-type mismatch
    const mimeExt = extensionForMime(blob.type) || '.bin';
    let filename = base;
    if (!/\.[A-Za-z0-9]+$/.test(filename)) filename += mimeExt;
    else {
      const currentExt = filename.slice(filename.lastIndexOf('.'));
      if (mimeExt && currentExt.toLowerCase() !== mimeExt) filename = filename.replace(/\.[A-Za-z0-9]+$/, mimeExt);
    }
    const { file_upload_id, upload_url, upload_headers, upload_fields } = await startFileUpload(filename);
    dbgBg('UPLOAD: started', {
      file_upload_id,
      upload_url: redactUrl(upload_url),
      upload_headers: upload_headers ? Object.keys(upload_headers) : [],
      upload_fields: upload_fields ? Object.keys(upload_fields) : [],
      blobType: blob.type,
      filename
    });
    let up;
    if (upload_fields && typeof upload_fields === 'object') {
      // S3 POST policy style: we must include provided fields before the file
      const fd = new FormData();
      for (const [k, v] of Object.entries(upload_fields)) fd.append(k, v);
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      fd.append('file', file);
      const postHeaders = {};
      if (upload_headers && typeof upload_headers === 'object') {
        for (const [k, v] of Object.entries(upload_headers)) postHeaders[k] = v;
      }
      up = await fetch(upload_url, { method: 'POST', headers: postHeaders, body: fd });
      if (!up.ok) {
        const body = await up.text().catch(() => '');
        throw new Error(`upload ${up.status} POST-policy; body=${body.slice(0,300)}`);
      }
    } else {
      // Decide between Notion POST endpoint vs signed PUT URL
      let targetHost = '';
      try { targetHost = new URL(upload_url).hostname; } catch {}
      if (targetHost.endsWith('notion.com')) {
        // Notion expects multipart/form-data POST with 'file'
        const fd = new FormData();
        const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
        fd.append('file', file);
        const postHeaders = {};
        if (upload_headers && typeof upload_headers === 'object') {
          for (const [k, v] of Object.entries(upload_headers)) {
            // Avoid overriding multipart boundary; also avoid forcing a mismatched Content-Type
            if (String(k).toLowerCase() === 'content-type') continue;
            postHeaders[k] = v;
          }
        }
        // Notion upload endpoint requires auth/version even if not listed in upload_headers
        try {
          const { notionToken } = await getConfig();
          if (notionToken) {
            postHeaders['Authorization'] = `Bearer ${notionToken}`;
            postHeaders['Notion-Version'] = NOTION_VERSION;
          }
        } catch {}
        up = await fetch(upload_url, { method: 'POST', headers: postHeaders, body: fd });
        if (!up.ok) {
          const body = await up.text().catch(() => '');
          throw new Error(`upload ${up.status} POST-notion; body=${body.slice(0,300)}`);
        }
      } else {
        // Signed URL (PUT) style
        const headers = { 'Content-Type': blob.type || 'application/octet-stream' };
        if (upload_headers && typeof upload_headers === 'object') {
          for (const [k, v] of Object.entries(upload_headers)) headers[k] = v;
        }
        up = await fetch(upload_url, { method: 'PUT', headers, body: blob });
        if (!up.ok) {
          const body = await up.text().catch(() => '');
          throw new Error(`upload ${up.status} PUT; body=${body.slice(0,300)}`);
        }
      }
    }
    dbgBg('UPLOAD: completed', { file_upload_id });
    return { file_upload_id, id: file_upload_id };
  } catch (e) {
    dbgBg('UPLOAD: failed', { imageUrl: redactUrl(imageUrl), error: String(e?.message || e) });
    return null;
  }
}

async function materializeExternalImagesInPropsAndBlocks(db, props, blocks, { maxUploads = 6 } = {}) {
  let uploads = 0;
  const tryUpload = async (url) => {
    if (uploads >= maxUploads) return null;
    const res = await uploadExternalImageToNotion(url);
    if (res && (res.file_upload_id || res.id)) uploads += 1;
    return res;
  };

  // Convert files properties
  for (const [propName, def] of Object.entries(db.properties || {})) {
    if (def.type !== 'files') continue;
    const v = props[propName];
    const items = v?.files;
    if (!Array.isArray(items) || !items.length) continue;
    const out = [];
    for (const it of items) {
      if (it?.file_upload?.file_upload_id || it?.file_upload?.id) { out.push(it); continue; }
      const ext = it?.external?.url || it?.url;
      if (typeof ext === 'string') {
        const up = await tryUpload(ext);
        if (up) {
          const fid = up.file_upload_id || up.id;
          out.push({ name: it?.name || 'image', file_upload: { id: fid } });
          continue;
        }
      }
      // Fallback – ensure name and external structure
      if (it?.external?.url) out.push({ name: it?.name || 'image', external: { url: it.external.url } });
      else if (it?.url) out.push({ name: 'image', external: { url: it.url } });
    }
    props[propName] = { files: out };
  }

  // Convert image blocks to uploads when possible, otherwise keep as external
  const toRemove = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || b.type !== 'image') continue;
    const ext = b.image?.external?.url || b.url;
    if (typeof ext === 'string') {
      const up = await tryUpload(ext);
      if (up) {
        const fid = up.file_upload_id || up.id;
        b.image = { file_upload: { id: fid } };
      } else {
        // Keep external image if upload fails; Notion can render external URLs
        if (!b.image?.external?.url) {
          // If we got here via b.url, move it to the expected shape
          b.image = { external: { url: ext } };
        }
      }
    }
  }
  for (let j = toRemove.length - 1; j >= 0; j--) blocks.splice(toRemove[j], 1);
}

// Record a recent successful save for display in the popup history
async function recordRecentSave(entry) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['recentSaves'], (res) => {
      const list = Array.isArray(res?.recentSaves) ? res.recentSaves : [];
      const item = {
        url: entry?.url || '',
        ts: typeof entry?.ts === 'number' ? entry.ts : Date.now(),
        databaseId: entry?.databaseId || '',
        databaseTitle: entry?.databaseTitle || '',
        title: entry?.title || '',
        sourceUrl: entry?.sourceUrl || '',
        durationMs: typeof entry?.durationMs === 'number' ? entry.durationMs : undefined
      };
      const next = [item, ...list].slice(0, 30);
      chrome.storage.local.set({ recentSaves: next }, () => resolve());
    });
  });
}

// Ensure select/multi_select options exist in the database schema; create missing ones
async function ensureSelectOptions(databaseId, props, token) {
  if (!props || typeof props !== 'object') return;
  const db = await getDatabase(databaseId, token);
  const updates = {};

  function findExistingFallbackName(def) {
    const options = (def.select?.options || def.multi_select?.options || []).map((o) => o.name);
    const preferred = ['Other', 'Misc', 'Uncategorized', 'General', 'Unknown'];
    for (const p of preferred) {
      if (options.some((n) => String(n).toLowerCase() === p.toLowerCase())) return p;
    }
    return undefined;
  }

  for (const [propName, def] of Object.entries(db.properties || {})) {
    const incoming = props[propName];
    if (!incoming) continue;
    if (def.type === 'select' && incoming.select?.name) {
      const existingOpts = def.select?.options || [];
      const existingNames = new Set(existingOpts.map((o) => o.name));
      const desired = String(incoming.select.name).trim();
      if (!existingNames.has(desired)) {
        const capacity = Math.max(0, 100 - existingOpts.length);
        if (capacity > 0) {
          const color = 'default';
          updates[propName] = existingOpts.concat([{ name: desired, color }]);
        } else {
          // No capacity: fallback to an existing option or drop the property
          const fallback = findExistingFallbackName(def) || existingOpts[0]?.name;
          if (fallback) {
            incoming.select.name = fallback;
          } else {
            delete props[propName];
          }
        }
      }
    }
    if (def.type === 'multi_select' && Array.isArray(incoming.multi_select)) {
      const existingOpts = def.multi_select?.options || [];
      const existingNames = new Set(existingOpts.map((o) => o.name));
      const desiredNames = incoming.multi_select.map((o) => o.name).filter((n) => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim());
      const missing = desiredNames.filter((n) => !existingNames.has(n));

      const capacity = Math.max(0, 100 - existingOpts.length);
      const toAdd = missing.slice(0, capacity);
      const leftover = missing.slice(toAdd.length);

      // Filter incoming values to those that either exist or will be added
      const allowed = new Set([...desiredNames.filter((n) => existingNames.has(n)), ...toAdd]);
      let filtered = desiredNames.filter((n) => allowed.has(n));

      // If some leftover couldn't be added, optionally map to a fallback existing option
      if (leftover.length > 0) {
        const fallback = findExistingFallbackName(def);
        if (fallback && !filtered.includes(fallback)) {
          filtered.push(fallback);
        }
      }
      // Remove duplicates while preserving order
      const seen = new Set();
      filtered = filtered.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
      incoming.multi_select = filtered.map((n) => ({ name: n }));

      if (toAdd.length > 0) {
        const color = 'default';
        updates[propName] = existingOpts.concat(toAdd.map((n) => ({ name: n, color })));
      }
    }
  }

  const payload = {};
  for (const [propName, optList] of Object.entries(updates)) {
    const propDef = db.properties[propName];
    if (propDef.type === 'select') {
      payload[propName] = { select: { options: optList } };
    } else if (propDef.type === 'multi_select') {
      payload[propName] = { multi_select: { options: optList } };
    }
  }

  if (Object.keys(payload).length > 0) {
    await notionFetch(`/databases/${databaseId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: payload })
    }, token);
  }
}

// OpenAI API helper
async function openaiChat(messages, { model = GPT5_NANO_MODEL, temperature = 0.2, reasoning_effort = 'low', verbosity = 'low' } = {}) {
  const { openaiKey } = await getConfig();
  if (!openaiKey) throw new Error('Falta la API key de OpenAI. Configúrala en Opciones.');

  const headers = {
    'Authorization': `Bearer ${openaiKey}`,
    'Content-Type': 'application/json'
  };

  // Determine parameter support based on model
  const isGPT5 = typeof model === 'string' && /^gpt-5/.test(model);
  const isO1Series = typeof model === 'string' && /^o1/.test(model);
  const supportsAdjustableTemperature = !(isGPT5 || isO1Series);

  // Build payload conditionally to avoid unsupported params (e.g., temperature on GPT-5/o1)
  const payload = { model, messages };
  if (supportsAdjustableTemperature && typeof temperature === 'number') {
    payload.temperature = temperature;
  }
  if (isGPT5 && typeof reasoning_effort === 'string') {
    payload.reasoning_effort = reasoning_effort;
  }
  if (isGPT5 && typeof verbosity === 'string') {
    payload.verbosity = verbosity;
  }

  // Use Chat Completions for widest compatibility
  const resp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OpenAI API ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Respuesta vacía del modelo.');
  dbgBg('openaiChat: response chars =', content.length);
  return content;
}

// Google Gemini helper
async function geminiChat(messages, { model = 'gemini-2.5-flash' } = {}) {
  const { googleApiKey } = await getConfig();
  if (!googleApiKey) throw new Error('Falta la API key de Google AI (Gemini). Configúrala en Opciones.');
  // Convert OpenAI-style messages to Gemini contents
  const contents = [];
  let systemInstruction = null;
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'model' : (m.role === 'system' ? 'user' : m.role);
    const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n') : '');
    if (m.role === 'system') {
      systemInstruction = { parts: [{ text }] };
      continue;
    }
    contents.push({ role: role === 'system' ? 'user' : role, parts: [{ text }] });
  }
  const url = `${GOOGLE_GENAI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(googleApiKey)}`;
  const body = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Gemini API ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || data?.candidates?.[0]?.content?.parts || [];
  const out = Array.isArray(parts) ? parts.map((p) => p?.text || '').join('\n').trim() : '';
  if (!out) throw new Error('Respuesta vacía del modelo.');
  dbgBg('geminiChat: response chars =', out.length);
  return out;
}

// Provider-agnostic LLM helper
async function llmChat(messages, opts = {}) {
  const cfg = await getConfig();
  const provider = (opts.provider || cfg.llmProvider || 'openai');
  const model = (opts.model || cfg.llmModel || (provider === 'google' ? 'gemini-2.5-flash' : GPT5_NANO_MODEL));
  dbgBg('llmChat: using provider/model', { provider, model });
  if (provider === 'google') {
    return geminiChat(messages, { model });
  }
  // default to OpenAI
  const { openai_reasoning_effort, openai_verbosity } = cfg;
  return openaiChat(messages, { model, reasoning_effort: openai_reasoning_effort || 'low', verbosity: openai_verbosity || 'low' });
}

// Build a prompt to map page context to Notion properties
function buildPromptForProperties(schema, pageContext, customInstructions, { useArticle } = { useArticle: true }) {
  const { url, title, meta, selectionText, textSample, headings, listItems, shortSpans, attrTexts, images, article } = pageContext;
  const schemaStr = JSON.stringify(schema, null, 2);

  // If we should not use the article, ensure we provide a sample: use existing textSample or derive from article.text
  let effectiveTextSample = textSample;
  if (!useArticle) {
    if (!effectiveTextSample && article && typeof article.text === 'string') {
      try {
        const parts = article.text.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
        effectiveTextSample = parts.slice(0, 10).join('\n\n').slice(0, 6000);
      } catch {}
    }
  }

  // Build a slimmer context when article is present
  let baseContext;
  if (useArticle && article) {
    baseContext = {
      url,
      title,
      meta,
      selectionText,
      article: { title: article.title, text: article.text },
      images
    };
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
        '- Title rules: The "title" property is MANDATORY and must be a strong, source-derived headline or entity name. Never return placeholders or generic values such as "Untitled", "New Page", "No title", "Home", or an empty string. Prefer the article title or first H1/H2; if unavailable, use meta og:title/twitter:title; otherwise derive from the URL slug by turning hyphen/underscore-separated words into a clean title. Remove site/section names, sources, categories, bylines, prefixes/suffixes, emojis, quotes, URLs, and separators like "|" or "/". Keep it concise (3–80 characters), Title Case when appropriate, and trim trailing punctuation.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Database schema (properties):\n${schemaStr}`,
        `\nPage context:\n${contextStr}`,
        '\n\nInstructions:',
        '- Fill as many properties as possible based on the context.',
        '- The "title" property is REQUIRED. Compose the best possible title using content signals in this priority: article.title or H1 > H2 > og:title/twitter:title > URL slug. Do NOT include site names, categories, or sources; never output placeholders like "Untitled" or "New Page". Use concise Title Case, 3–80 characters, no emojis, no quotes, and avoid separators like "|" or "/". If the database suggests an entity type (people, companies, movies, recipes, etc.), set the title to that entity\'s clean name.',
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

function extractSchemaForPrompt(database) {
  // Reduce database object to just properties relevant for the LLM: name, type, options
  const props = database.properties || {};
  const simplified = {};
  Object.entries(props).forEach(([name, def]) => {
    const base = { type: def.type };
    // Include property description, when available, to improve LLM mapping fidelity
    try {
      const desc = typeof def?.description === 'string' ? def.description.trim() : '';
      if (desc) base.description = desc;
    } catch {}
    if (def.type === 'select' || def.type === 'multi_select') {
      base.options = def[def.type]?.options?.map((o) => o.name) || [];
    }
    if (def.type === 'title' || def.type === 'rich_text' || def.type === 'url' || def.type === 'email' || def.type === 'phone_number') {
      // nothing else to add
    }
    if (def.type === 'number') {
      base.format = def.number?.format || 'number';
    }
    if (def.type === 'date') {
      // date supports start/end/time_zone in Notion API
      // Do not hint custom flags like "time" to avoid invalid outputs.
    }
    // people, files, relation, rollup etc. can be omitted or noted
    simplified[name] = base;
  });
  return simplified;
}

// Deprecated: no longer auto-prepend bookmark/note blocks to output
function buildBookmarkBlocks(url, note) {
  return [];
}

function stripForbiddenFieldsFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'image' || b.type === 'file') {
      const container = b[b.type];
      if (container && container.file_upload && typeof container.file_upload === 'object') {
        if ('file_upload_id' in container.file_upload) delete container.file_upload.file_upload_id;
      }
    }
  }
}

// Normalize and sanitize LLM-provided blocks into a safe subset supported by Notion API
function sanitizeBlocks(rawBlocks) {
  if (!Array.isArray(rawBlocks)) return [];

  function toRichText(text) {
    const content = typeof text === 'string' ? text : '';
    return [{ type: 'text', text: { content } }];
  }

  const allowedTypes = new Set([
    'paragraph',
    'heading_1',
    'heading_2',
    'heading_3',
    'bulleted_list_item',
    'numbered_list_item',
    'quote',
    'bookmark',
    'image',
    'file'
  ]);

  const out = [];
  for (const b of rawBlocks) {
    if (typeof b === 'string') {
      out.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: toRichText(b) } });
      continue;
    }
    if (!b || typeof b !== 'object') continue;
    const type = b.type;
    if (!allowedTypes.has(type)) continue;
    if (type === 'bookmark') {
      const url = b?.bookmark?.url || b?.url || '';
      if (!url) continue;
      out.push({ object: 'block', type: 'bookmark', bookmark: { url } });
      continue;
    }
    if (type === 'image') {
      const url = b?.image?.external?.url || b?.url;
      const uploadId = b?.image?.file_upload?.id || b?.image?.file_upload?.file_upload_id || b?.file_upload_id;
      if (typeof url === 'string' && url) {
        out.push({ object: 'block', type: 'image', image: { external: { url } } });
        continue;
      }
      if (typeof uploadId === 'string' && uploadId) {
        out.push({ object: 'block', type: 'image', image: { file_upload: { id: uploadId } } });
        continue;
      }
      continue;
    }
    const field = b[type];
    const txt = field?.rich_text || field?.text || b.text || b.content || '';
    out.push({ object: 'block', type, [type]: { rich_text: Array.isArray(txt) ? txt : toRichText(txt) } });
  }
  return out;
}

// Build simple paragraph blocks from a text sample
function blocksFromTextSample(sample, { maxBlocks = 20, maxCharsPerBlock = 1200 } = {}) {
  if (typeof sample !== 'string' || !sample.trim()) return [];
  const lines = sample
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const blocks = [];
  const toRichText = (text) => [{ type: 'text', text: { content: text } }];
  for (const line of lines) {
    if (blocks.length >= maxBlocks) break;
    const clipped = line.length > maxCharsPerBlock ? line.slice(0, maxCharsPerBlock) : line;
    blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: toRichText(clipped) } });
  }
  return blocks;
}

// Extract the first valid JSON object from a free-form string.
function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  // Strip code fences if present
  const fenceMatch = text.match(/```(?:json)?\n([\s\S]*?)\n```/i);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  // Fast path
  try { if (candidate.trim().startsWith('{')) return JSON.parse(candidate); } catch (_) {}
  // Walk to find the first balanced {...}
  const s = candidate;
  let start = -1, depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0 && start >= 0) {
      const frag = s.slice(start, i + 1);
      try {
        return JSON.parse(frag);
      } catch (_) {
        // Try to remove trailing commas
        const fixed = frag.replace(/,\s*(\]|\})/g, '$1');
        try { return JSON.parse(fixed); } catch (_) { return null; }
      }
    }}
  }
  return null;
}

// Messaging handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'LIST_DATABASES') {
      try {
        dbgBg('LIST_DATABASES: query =', message.query);
        const { notionSearchQuery, workspaceTokens } = await getConfig();
        const tokensMap = workspaceTokens && typeof workspaceTokens === 'object' ? workspaceTokens : {};
        const tokenValues = Object.values(tokensMap);
        let bases = [];
        if (tokenValues.length === 0) {
          bases = await listDatabases(message.query ?? notionSearchQuery ?? '');
        } else {
          const body = { query: message.query ?? notionSearchQuery ?? '', filter: { property: 'object', value: 'database' }, sort: { direction: 'ascending', timestamp: 'last_edited_time' } };
          const per = await Promise.all(tokenValues.map(async (tok) => {
            try {
              const data = await notionFetch('/search', { method: 'POST', body: JSON.stringify(body) }, tok);
              const results = (data.results || []).map((item) => {
                const title = (item.title || []).map((t) => t.plain_text).join('') || '(Sin título)';
                const iconEmoji = item?.icon?.type === 'emoji' ? item.icon.emoji : undefined;
                const url = item?.url || `https://www.notion.so/${String(item?.id || '').replace(/-/g, '')}`;
                return { id: item.id, title, iconEmoji, url };
              });
              return results;
            } catch { return []; }
          }));
          const byId = new Map();
          for (const list of per) { for (const db of list) { if (!byId.has(db.id)) byId.set(db.id, db); } }
          bases = Array.from(byId.values());
        }
        // Persist a basic dbId->workspaceId map for later saves
        try {
          const map = {};
          if (Array.isArray(bases)) {
            for (const db of bases) {
              // We can't infer workspaceId directly from /search; mark unknown
              map[db.id] = map[db.id] || null;
            }
          }
          const prev = await getConfig();
          await set({ dbWorkspaceMap: { ...(prev.dbWorkspaceMap || {}), ...map } });
        } catch {}
        sendResponse({ ok: true, databases: bases });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (message?.type === 'LIST_UNTITLED_DATABASES') {
      try {
        const { notionToken } = await getConfig();
        if (!notionToken) throw new Error('Missing Notion token. Configure it.');
        const list = await searchUntitledDatabases(notionToken);
        sendResponse({ ok: true, databases: list });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (message?.type === 'LIST_ALL_DATABASES') {
      try {
        const { notionToken, notionSearchQuery } = await getConfig();
        if (!notionToken) throw new Error('Missing Notion token. Configure it.');
        const list = await searchAllDatabases(notionToken, { query: message.query ?? notionSearchQuery ?? '' });
        sendResponse({ ok: true, databases: list });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (message?.type === 'START_FILE_UPLOAD') {
      try {
        const { filename } = message || {};
        const { workspaceTokens, dbWorkspaceMap } = await getConfig();
        const tokensMap = workspaceTokens && typeof workspaceTokens === 'object' ? workspaceTokens : {};
        // We don't know target DB here; fallback to first token
        const token = Object.values(tokensMap)[0] || null;
        const res = await startFileUpload(filename, token);
        if (!res?.file_upload_id || !res?.upload_url) throw new Error('Failed to start file upload');
        sendResponse({ ok: true, ...res });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (message?.type === 'SAVE_TO_NOTION') {
      try {
        const { databaseId, pageContext, note, saveArticle } = message;
        if (!databaseId) throw new Error('databaseId faltante');
        if (!pageContext) throw new Error('pageContext faltante');
        dbgBg('SAVE_TO_NOTION: start', { databaseId, url: pageContext?.url });
        const debugReport = { t: new Date().toISOString(), databaseId, pageUrl: pageContext?.url || '' };
        // Log Readability raw HTML (separately) for quick inspection
        try {
          const artHtml = pageContext?.article?.html || '';
          if (typeof artHtml === 'string' && artHtml.length > 0) {
            dbgBg('READABILITY_HTML: length', artHtml.length);
            // Print the entire HTML in chunks for easy copy/paste (avoids console truncation)
            try {
              const chunkSize = 50000; // characters per chunk
              const total = Math.ceil(artHtml.length / chunkSize) || 1;
              dbgBg('READABILITY_HTML: chunks', { count: total, chunkSize });
              for (let i = 0; i < total; i++) {
                const start = i * chunkSize;
                const end = Math.min(artHtml.length, start + chunkSize);
                dbgBg(`READABILITY_HTML: chunk ${i + 1}/${total}`, artHtml.slice(start, end));
              }
            } catch {}
            debugReport.readabilityHtmlLen = artHtml.length;
            debugReport.readabilityHtmlSample = artHtml.slice(0, 20000);
          }
        } catch {}

        const { workspaceTokens, dbWorkspaceMap } = await getConfig();
        const tokensMap = workspaceTokens && typeof workspaceTokens === 'object' ? workspaceTokens : {};
        const wsIdHint = dbWorkspaceMap && typeof dbWorkspaceMap === 'object' ? dbWorkspaceMap[databaseId] : null;
        let tokenForDb = wsIdHint && tokensMap[wsIdHint] ? tokensMap[wsIdHint] : Object.values(tokensMap)[0];
        let db;
        // Probe tokens if needed to find one that can read this database
        if (!tokenForDb) throw new Error('Missing Notion token. Configure it.');
        try {
          db = await getDatabase(databaseId, tokenForDb);
        } catch (e) {
          const tokens = Object.entries(tokensMap);
          for (const [wsId, tok] of tokens) {
            if (tok === tokenForDb) continue;
            try {
              db = await getDatabase(databaseId, tok);
              tokenForDb = tok;
              // Cache mapping for future saves
              try { const prev = await getConfig(); const map = Object.assign({}, prev.dbWorkspaceMap || {}); map[databaseId] = wsId; await set({ dbWorkspaceMap: map }); } catch {}
              break;
            } catch {}
          }
          if (!db) throw e;
        }
        dbgBg('SAVE_TO_NOTION: fetched database schema');
        const schemaForLLM = extractSchemaForPrompt(db);
        dbgBg('SAVE_TO_NOTION: schemaForLLM', sanitizeForLog(schemaForLLM));
        const { openai_reasoning_effort, openai_verbosity, databasePrompts, databaseSettings, llmProvider, llmModel } = await getConfig();
        const settingsForDb = (databaseSettings || {})[databaseId] || {};
        const legacyPrompt = (databasePrompts || {})[databaseId] || '';
        const customInstructions = (settingsForDb.prompt ?? legacyPrompt) || '';
        const saveArticleFlag = settingsForDb.saveArticle !== false; // default true per DB
        const effectiveSaveArticle = (typeof saveArticle === 'boolean' ? saveArticle : saveArticleFlag);
        const customizeContent = settingsForDb.customizeContent === true;
        const contentPrompt = typeof settingsForDb.contentPrompt === 'string' ? settingsForDb.contentPrompt.trim() : '';
        const chosenProvider = message.llmProvider || llmProvider || 'openai';
        const chosenModel = message.llmModel || llmModel || (chosenProvider === 'google' ? 'gemini-2.5-flash' : GPT5_NANO_MODEL);
        const promptMode = effectiveSaveArticle ? 'article+children' : 'properties-only';
        dbgBg('SAVE_TO_NOTION: mode', { promptMode, chosenProvider, chosenModel });
        debugReport.settings = {
          promptMode,
          saveArticleFlag,
          effectiveSaveArticle,
          customizeContent,
          contentPromptLen: contentPrompt.length,
          hasArticle: !!pageContext.article,
          articleBlocks: Array.isArray(pageContext.articleBlocks) ? pageContext.articleBlocks.length : 0,
          textSampleLen: typeof pageContext.textSample === 'string' ? pageContext.textSample.length : 0
        };
        const prompt = buildPromptForProperties(schemaForLLM, pageContext, customInstructions, { useArticle: effectiveSaveArticle });
        dbgBg('SAVE_TO_NOTION: db settings', {
          databaseId,
          settingsForDb: sanitizeForLog(settingsForDb),
          saveArticleMsg: typeof saveArticle === 'boolean' ? saveArticle : undefined,
          saveArticleFlag,
          effectiveSaveArticle,
          articleBlocks: Array.isArray(pageContext.articleBlocks) ? pageContext.articleBlocks.length : 0,
          hasArticle: !!pageContext.article
        });
        dbgBg('SAVE_TO_NOTION: prompt (messages)', sanitizeForLog(prompt));
        try {
          dbgBg('SAVE_TO_NOTION: prompt (full object)', prompt);
          // Also log a viewer-friendly JSON without \n escapes by structuring user content
          function safeParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }
          function buildViewer(messages) {
            return messages.map((m) => {
              if (typeof m?.content !== 'string') return m;
              const markerA = 'Database schema (properties):\n';
              const markerB = '\n\nPage context:\n';
              const markerC = '\n\nInstructions:';
              const iA = m.content.indexOf(markerA);
              const iB = m.content.indexOf(markerB);
              const iC = m.content.indexOf(markerC);
              if (iA >= 0 && iB > iA && iC > iB) {
                const schemaStr = m.content.slice(iA + markerA.length, iB);
                const ctxStr = m.content.slice(iB + markerB.length, iC);
                const instrStr = m.content.slice(iC + markerC.length);
                const schemaObj = safeParseJSON(schemaStr.trim());
                const ctxObj = safeParseJSON(ctxStr.trim());
                const instructions = instrStr.trim().split(/\n+/).map((s) => s.replace(/^[-•]\s*/, '').trim()).filter(Boolean);
                return { role: m.role, content_view: { schema: schemaObj ?? schemaStr, pageContext: ctxObj ?? ctxStr, instructions } };
              }
              // Fallback: split content into lines to remove explicit \n sequences
              return { role: m.role, content_lines: m.content.split('\n') };
            });
          }
          const viewer = buildViewer(prompt);
          dbgBg('SAVE_TO_NOTION: prompt (viewer json)', JSON.stringify(viewer, null, 2));
          debugReport.promptMessagesViewer = viewer;
        } catch (e) {
          dbgBg('SAVE_TO_NOTION: prompt logging error', String(e?.message || e));
        }
        debugReport.promptMessages = prompt;

        const content = await llmChat(prompt, {
          provider: chosenProvider,
          model: chosenModel,
          reasoning_effort: openai_reasoning_effort || 'low',
          verbosity: openai_verbosity || 'low'
        });
        dbgBg('SAVE_TO_NOTION: received LLM content');
        debugReport.mainRaw = typeof content === 'string' ? content.slice(0, 200000) : '';

        // Parse JSON block from content (robust extractor)
        const parsed = extractJsonObject(content);
        if (!parsed) {
          throw new Error('The model did not return valid JSON for properties.');
        }
        dbgBg('SAVE_TO_NOTION: parsed JSON', sanitizeForLog(parsed));
        try {
          dbgBg('SAVE_TO_NOTION: response (viewer json)', JSON.stringify(parsed, null, 2));
          debugReport.mainParsedViewer = parsed;
        } catch {}
        try { debugReport.mainParsedChildrenCount = (Array.isArray(parsed?.children) ? parsed.children.length : (Array.isArray(parsed?.blocks) ? parsed.blocks.length : (Array.isArray(parsed?.content) ? parsed.content.length : 0))); } catch {}

        if (!parsed || typeof parsed !== 'object' || !parsed.properties) {
          throw new Error('Falta la clave "properties" en la salida del modelo.');
        }

        // Ensure a URL property is set if schema has one and model omitted it
        const urlPropName = Object.entries(db.properties || {}).find(([, def]) => def.type === 'url')?.[0];
        if (urlPropName && !parsed.properties[urlPropName] && pageContext.url) {
          parsed.properties[urlPropName] = { url: pageContext.url };
        }
        dbgBg('SAVE_TO_NOTION: ensured URL property', urlPropName ? { [urlPropName]: parsed.properties[urlPropName] } : {});

        // Sanitize and normalize properties to valid Notion API shapes
        function sanitizeProperties(db, props) {
          const out = {};
          const schema = db.properties || {};

          function toRichText(text) {
            const content = typeof text === 'string' ? text : '';
            return [{ type: 'text', text: { content } }];
          }

          function sanitizeRichTextArray(arr) {
            const out = [];
            const MAX = 20;
            function make(text, linkUrl) {
              const content = String(text || '').slice(0, 2000);
              const base = { type: 'text', text: { content } };
              if (linkUrl && typeof linkUrl === 'string') {
                base.text.link = { url: linkUrl };
              }
              return base;
            }
            for (const it of Array.isArray(arr) ? arr : []) {
              if (out.length >= MAX) break;
              if (typeof it === 'string') { out.push(make(it)); continue; }
              if (it && typeof it === 'object') {
                // Accept both proper Notion shape and lenient LLM output missing type
                if ((it.type === 'text' || it.type == null) && it.text && typeof it.text.content === 'string') {
                  const linkUrl = it.text.link?.url || it.href || (typeof it.text.link === 'string' ? it.text.link : undefined);
                  out.push(make(it.text.content, linkUrl));
                  continue;
                }
                if (typeof it.plain_text === 'string') {
                  out.push(make(it.plain_text, it.href));
                  continue;
                }
                if (typeof it.content === 'string') {
                  out.push(make(it.content));
                  continue;
                }
              }
            }
            if (out.length === 0) out.push(make(''));
            return out;
          }

          function guessNameFromUrl(u, fallback = 'file') {
            try {
              const url = new URL(u);
              const base = url.pathname.split('/').pop();
              if (base && base !== '/') return base;
            } catch {}
            return fallback;
          }

          function normalizeValueByType(def, value) {
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
                // Accept arrays of strings (external URLs) or file/external/file_upload objects
                const arr = Array.isArray(value) ? value : (Array.isArray(value?.files) ? value.files : undefined);
                if (!Array.isArray(arr)) return undefined;
                const files = [];
                for (const item of arr) {
                  if (!item) continue;
                  if (typeof item === 'string') {
                    files.push({ name: guessNameFromUrl(item, 'image'), external: { url: item } });
                    continue;
                  }
                  if (typeof item?.url === 'string') {
                    files.push({ name: guessNameFromUrl(item.url, item.name || 'image'), external: { url: item.url } });
                    continue;
                  }
                  if (item.external?.url) {
                    files.push({ name: item.name || guessNameFromUrl(item.external.url, 'image'), external: { url: item.external.url } });
                    continue;
                  }
                  if (item.file_upload?.file_upload_id) {
                    files.push({ name: item.name || 'image', file_upload: { file_upload_id: item.file_upload.file_upload_id } });
                    continue;
                  }
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
                  const cleaned = arr
                    .map((v) => (typeof v === 'string' ? v.trim() : v?.name))
                    .filter((n) => typeof n === 'string' && n.length > 0)
                    .map((name) => ({ name }));
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
                // Normalize to { date: { start, end?, time_zone? } }
                if (typeof value === 'string') return { date: { start: value } };
                if (value && typeof value === 'object') {
                  if (typeof value.date === 'string') return { date: { start: value.date } };
                  if (value.date && typeof value.date === 'object') {
                    const d = value.date;
                    const cleaned = {};
                    if (typeof d.start === 'string') cleaned.start = d.start;
                    if (typeof d.end === 'string') cleaned.end = d.end;
                    if (typeof d.time_zone === 'string') cleaned.time_zone = d.time_zone;
                    if (Object.keys(cleaned).length > 0) return { date: cleaned };
                  }
                  // Accept shorthand { start, end?, time_zone? }
                  if (typeof value.start === 'string' || typeof value.end === 'string' || typeof value.time_zone === 'string') {
                    const cleaned = {};
                    if (typeof value.start === 'string') cleaned.start = value.start;
                    if (typeof value.end === 'string') cleaned.end = value.end;
                    if (typeof value.time_zone === 'string') cleaned.time_zone = value.time_zone;
                    return { date: cleaned };
                  }
                }
                return undefined;
              }
              default:
                // For people, files, relation, rollup etc., skip unless the model provided a valid object we recognize
                return undefined;
            }
          }

          // Normalize only properties that exist in schema
          for (const [propName, def] of Object.entries(schema)) {
            const raw = props[propName];
            if (raw === undefined) continue;
            const normalized = normalizeValueByType(def, raw);
            if (normalized && typeof normalized === 'object' && Object.keys(normalized).length > 0) {
              out[propName] = normalized;
              // Remove stray flags on date
              if (def.type === 'date' && out[propName]?.date && typeof out[propName].date === 'object') {
                delete out[propName].date.time;
                delete out[propName].date.allow_time;
              }
            }
          }

          return out;
        }

        let safeProps = sanitizeProperties(db, parsed.properties);
        dbgBg('SAVE_TO_NOTION: sanitized properties', sanitizeForLog(safeProps));
        // Ensure title property exists with a valid shape
        const titlePropName = Object.entries(db.properties || {}).find(([, def]) => def.type === 'title')?.[0];
        if (titlePropName) {
          const existing = safeProps[titlePropName];
          const hasValidTitle = Array.isArray(existing?.title) && existing.title.length > 0;
          if (!hasValidTitle) {
            safeProps[titlePropName] = {
              title: [ { type: 'text', text: { content: pageContext.title || pageContext.meta?.['og:title'] || pageContext.url || 'Untitled' } } ]
            };
          }
        }
        let children = [];
        if (effectiveSaveArticle) {
          if (Array.isArray(pageContext.articleBlocks) && pageContext.articleBlocks.length) {
            // Use deterministic article blocks built in the content script
            children = sanitizeBlocks(pageContext.articleBlocks);
          } else if (parsed && (parsed.children || parsed.blocks || parsed.content)) {
            children = sanitizeBlocks(parsed.children || parsed.blocks || parsed.content || []);
          }
          // If DB requires content customization and we used article blocks, run a second pass to transform children
          if (customizeContent && contentPrompt && typeof pageContext?.article?.html === 'string' && pageContext.article.html.length > 0) {
            const htmlForTransform = pageContext.article.html;
            dbgBg('SAVE_TO_NOTION: content customization starting', { articleHtmlLen: htmlForTransform.length, contentPromptLen: contentPrompt.length });
            const transformMessages = [
              { role: 'system', content: [
                'You convert ARTICLE HTML into a JSON array of Notion blocks according to the user instructions.',
                'Output rules:',
                '- Return ONLY a raw JSON array (no wrapper object, no code fences). Do NOT ask questions or propose plans. Output the final array now.',
                '- Allowed block types: paragraph, heading_1, heading_2, heading_3, bulleted_list_item, numbered_list_item, quote, image.',
                '- For text blocks use simple rich_text with plain text only (no annotations).',
                '- For image blocks use the external URL shape only.',
                '- Do NOT include fields like object, id, children, created_time, annotations, etc.',
                '- Keep the array to at most 100 blocks. Prefer a concise summary followed by the most important sections/images in reading order.',
                'Examples:',
                '[',
                '  {"type":"heading_2","heading_2":{"rich_text":[{"type":"text","text":{"content":"Section title"}}]}},',
                '  {"type":"paragraph","paragraph":{"rich_text":[{"type":"text","text":{"content":"One or two sentences explaining the section."}}]}},',
                '  {"type":"bulleted_list_item","bulleted_list_item":{"rich_text":[{"type":"text","text":{"content":"Key point"}}]}},',
                '  {"type":"numbered_list_item","numbered_list_item":{"rich_text":[{"type":"text","text":{"content":"Step 1"}}]}},',
                '  {"type":"quote","quote":{"rich_text":[{"type":"text","text":{"content":"Quoted insight."}}]}},',
                '  {"type":"image","image":{"external":{"url":"https://example.com/image.jpg"}}}',
                ']'
              ].join(' ') },
              { role: 'user', content: `Article HTML:\n${htmlForTransform}` },
              { role: 'user', content: `Transform instructions:\n${contentPrompt}` }
            ];
            try {
              function safeParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }
              function buildTransformViewer(messages) {
                return messages.map((m) => {
                  if (typeof m?.content !== 'string') return m;
                  const m1 = 'Article HTML:\n';
                  const m2 = 'Transform instructions:\n';
                  if (m.content.startsWith(m1)) {
                    const htmlStr = m.content.slice(m1.length);
                    return { role: m.role, articleHtmlLen: htmlStr.length, articleHtmlPreview: htmlStr.slice(0, 10000) };
                  }
                  if (m.content.startsWith(m2)) {
                    const instr = m.content.slice(m2.length).trim().split(/\n+/).filter(Boolean);
                    return { role: m.role, instructions: instr };
                  }
                  return { role: m.role, content_lines: m.content.split('\n') };
                });
              }
              const cviewer = buildTransformViewer(transformMessages);
              dbgBg('SAVE_TO_NOTION: content customization prompt (viewer json)', JSON.stringify(cviewer, null, 2));
              if (!debugReport.customization) debugReport.customization = { used: true };
              debugReport.customization.promptViewer = cviewer;
            } catch {}
            let replacedViaModel = false;
            try {
              const transformed = await llmChat(transformMessages, { provider: chosenProvider, model: chosenModel, reasoning_effort: openai_reasoning_effort || 'low', verbosity: openai_verbosity || 'low' });
              try { dbgBg('SAVE_TO_NOTION: content customization raw', transformed.slice(0, 2000)); } catch {}
              // Allow either a pure array or { children: [...] } shapes
              const tTrim = typeof transformed === 'string' ? transformed.trim() : '';
              let parsedTransformed = null;
              if (tTrim.startsWith('[')) {
                // Fast path for arrays
                try { parsedTransformed = JSON.parse(tTrim); } catch {}
              }
              if (!parsedTransformed) parsedTransformed = extractJsonObject(transformed);
              if (!parsedTransformed) {
                try { parsedTransformed = JSON.parse(transformed); } catch {}
              }
              if (Array.isArray(parsedTransformed)) {
                // ok
              } else if (parsedTransformed && Array.isArray(parsedTransformed.children)) {
                parsedTransformed = parsedTransformed.children;
              } else {
                // Try to recover from fenced JSON arrays
                const fence = transformed.match(/```(?:json)?\n([\s\S]*?)\n```/i);
                if (fence) {
                  try {
                    const arr = JSON.parse(fence[1]);
                    if (Array.isArray(arr)) parsedTransformed = arr;
                  } catch {}
                }
              }
              try {
                dbgBg('SAVE_TO_NOTION: content customization response (viewer json)', JSON.stringify(parsedTransformed, null, 2));
                if (!debugReport.customization) debugReport.customization = { used: true };
                debugReport.customization.responseViewer = parsedTransformed;
              } catch {}
              let safeTransformed = sanitizeBlocks(Array.isArray(parsedTransformed) ? parsedTransformed : []);
              if (Array.isArray(safeTransformed) && safeTransformed.length) {
                children = safeTransformed;
                replacedViaModel = true;
              }
              // Retry once with a stricter repair prompt if we still have zero blocks and the model answered with prose
              if (!replacedViaModel) {
                const repairMessages = [
                  { role: 'system', content: [
                    'Your previous answer was not a JSON array of Notion blocks. Return ONLY a raw JSON array now, with at most 100 blocks.',
                    'Allowed types: paragraph, heading_1, heading_2, heading_3, bulleted_list_item, numbered_list_item, quote, image.',
                    'No wrapper object, no code fences, no explanation.'
                  ].join(' ') },
                  { role: 'user', content: `Article HTML (again):\n${htmlForTransform}` },
                  { role: 'user', content: `Transform instructions (again):\n${contentPrompt}` }
                ];
                try {
                  const repaired = await llmChat(repairMessages, { provider: chosenProvider, model: chosenModel, reasoning_effort: openai_reasoning_effort || 'low', verbosity: openai_verbosity || 'low' });
                  let reparsed = null;
                  const rTrim = typeof repaired === 'string' ? repaired.trim() : '';
                  if (rTrim.startsWith('[')) { try { reparsed = JSON.parse(rTrim); } catch {} }
                  if (!reparsed) reparsed = extractJsonObject(repaired);
                  if (Array.isArray(reparsed)) {
                    safeTransformed = sanitizeBlocks(reparsed);
                    if (Array.isArray(safeTransformed) && safeTransformed.length) {
                      children = safeTransformed;
                      replacedViaModel = true;
                    }
                  }
                  try { dbgBg('SAVE_TO_NOTION: customization repair raw', repaired.slice(0, 2000)); } catch {}
                  try { dbgBg('SAVE_TO_NOTION: customization repair parsed (len)', Array.isArray(safeTransformed) ? safeTransformed.length : 0); } catch {}
                } catch {}
              }
              try { dbgBg('SAVE_TO_NOTION: content customization parsed (first block)', Array.isArray(children) && children[0] ? sanitizeForLog(children[0]) : null); } catch {}
              dbgBg('SAVE_TO_NOTION: content customization done', { outCount: children.length });
              debugReport.customization = {
                used: true,
                transformMessages,
                raw: typeof transformed === 'string' ? transformed.slice(0, 200000) : '',
                outCount: children.length,
                replacedViaModel
              };
            } catch (e) {
              dbgBg('Content customization failed (using original article blocks)', String(e?.message || e));
              debugReport.customization = { used: true, error: String(e?.message || e) };
            }

            // Fallback: if model returned no blocks, keep only images and add a short summary paragraph
            if (!children || !Array.isArray(children) || children.length === 0 || (debugReport.customization && debugReport.customization.replacedViaModel === false)) {
              const imageOnly = (Array.isArray(pageContext.articleBlocks) ? sanitizeBlocks(pageContext.articleBlocks) : children || [])
                .filter((b) => b && b.type === 'image')
                .slice(0, 8);
              let summaryBlocks = [];
              try {
                const contextText = (pageContext.article?.text || pageContext.textSample || '').slice(0, 4000);
                const summaryMessages = [
                  { role: 'system', content: 'Return only a JSON array with a single Notion paragraph block that briefly explains why this insight matters now. Use neutral, concise language (1-2 sentences).' },
                  { role: 'user', content: `Context:\n${contextText}` },
                  { role: 'user', content: `Additional instructions for the paragraph:\n${contentPrompt}` }
                ];
                const resp = await llmChat(summaryMessages, { provider: chosenProvider, model: chosenModel, reasoning_effort: openai_reasoning_effort || 'low', verbosity: openai_verbosity || 'low' });
                const parsedSummary = extractJsonObject(resp) || JSON.parse(resp);
                const safeSummary = sanitizeBlocks(Array.isArray(parsedSummary) ? parsedSummary : (parsedSummary?.children || []));
                if (Array.isArray(safeSummary) && safeSummary.length) summaryBlocks = safeSummary.slice(0, 1);
              } catch {}
              if (summaryBlocks.length === 0) {
                summaryBlocks = [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'Summary unavailable.' } }] } }];
              }
              children = imageOnly.concat(summaryBlocks);
              dbgBg('SAVE_TO_NOTION: customization fallback applied', { images: imageOnly.length, summary: summaryBlocks.length });
              if (debugReport.customization) {
                debugReport.customization.fallbackUsed = true;
                debugReport.customization.fallbackImages = imageOnly.length;
              }
            }
          }
          // When article is disabled, we intentionally ignore any children returned by the model
          // and do not synthesize blocks from textSample.
        }

        // Snapshot for debugging (easy to copy/paste)
        const modelChildrenCount = parsed ? ((Array.isArray(parsed.children) && parsed.children.length) || (Array.isArray(parsed.blocks) && parsed.blocks.length) || (Array.isArray(parsed.content) && parsed.content.length) || 0) : 0;
        const snapshot = {
          databaseId,
          pageUrl: pageContext.url || '',
          promptMode,
          saveArticleFlag,
          effectiveSaveArticle,
          customizeContent,
          contentPromptLen: contentPrompt.length,
          hasArticle: !!pageContext.article,
          articleBlocks: Array.isArray(pageContext.articleBlocks) ? pageContext.articleBlocks.length : 0,
          textSampleLen: typeof pageContext.textSample === 'string' ? pageContext.textSample.length : 0,
          modelChildrenCount,
          chosenChildren: Array.isArray(children) ? children.length : 0
        };
        dbgBg('SAVE_TO_NOTION: snapshot', snapshot);
        dbgBg('SAVE_TO_NOTION: prepared children blocks', children.length, sanitizeForLog(children));
        // Append uploaded images (from popup) as blocks
        const attachmentBlocks = Array.isArray(message.attachments)
          ? message.attachments
              .filter((a) => typeof a?.file_upload_id === 'string')
              .map((a) => ({ object: 'block', type: 'image', image: { file_upload: { id: (a.file_upload_id || a.id) } } }))
          : [];
        // Also try to map attachments into an image-like files property if present
        if (Array.isArray(message.attachments) && message.attachments.length) {
          const imageLike = /poster|cover|thumb|thumbnail|image|artwork|screenshot|photo|picture/i;
          const filesPropName = Object.entries(db.properties || {})
            .filter(([, def]) => def.type === 'files')
            .map(([name]) => name)
            .sort((a, b) => {
              const ai = imageLike.test(a) ? 0 : 1;
              const bi = imageLike.test(b) ? 0 : 1;
              return ai - bi;
            })[0];
          if (filesPropName) {
            const uploads = message.attachments
              .filter((a) => typeof a?.file_upload_id === 'string')
              .map((a) => ({ name: 'upload', file_upload: { id: (a.file_upload_id || a.id) } }));
            if (uploads.length) {
              const existing = safeProps[filesPropName]?.files || parsed.properties?.[filesPropName]?.files || [];
              safeProps[filesPropName] = { files: existing.concat(uploads) };
            }
          }
        }
        // Ensure select options exist (auto-create missing ones)
        await ensureSelectOptions(databaseId, safeProps, tokenForDb);
        dbgBg('SAVE_TO_NOTION: ensured select options (props sent to check)', sanitizeForLog(safeProps));
        // Do not prepend bookmark/note. Note becomes extra LLM context only.
        const blocks = attachmentBlocks.concat(children);
        // Materialize external image URLs into Notion-hosted uploads (both blocks and files properties)
        await materializeExternalImagesInPropsAndBlocks(db, safeProps, blocks, { maxUploads: 6 });
        // Ensure we do not send forbidden fields to Notion (e.g., file_upload.file_upload_id in blocks)
        stripForbiddenFieldsFromBlocks(blocks);
        // Prefer the start time from the popup for end-to-end duration; fallback to now
        const t0 = typeof message.startedAt === 'number' ? message.startedAt : Date.now();
        dbgBg('SAVE_TO_NOTION: creating page in Notion with', { properties: sanitizeForLog(safeProps), children: sanitizeForLog(blocks) });
        // Notion limits initial children to 100; create page with up to 100, then append the rest
        const firstBatch = blocks.slice(0, 100);
        debugReport.finalChildrenCount = blocks.length;
        try { debugReport.propertiesKeys = Object.keys(safeProps || {}); } catch {}
        const created = await createPageInDatabase(databaseId, safeProps, firstBatch, tokenForDb);
        const t1 = Date.now();
        dbgBg('SAVE_TO_NOTION: page created', sanitizeForLog({ id: created?.id, url: created?.url || created?.public_url, properties: created?.properties }));
        const pageUrl = created?.url || created?.public_url || '';
        // Append remaining children batches in chunks of 100
        const rest = blocks.slice(100);
        const parentId = created?.id;
        for (let i = 0; i < rest.length && parentId; i += 100) {
          const chunk = rest.slice(i, i + 100);
          try {
            await appendChildrenBlocks(parentId, chunk, tokenForDb);
            dbgBg('SAVE_TO_NOTION: appended children chunk', { offset: i, count: chunk.length });
          } catch (e) {
            dbgBg('SAVE_TO_NOTION: append failed', { offset: i, count: chunk.length, error: String(e?.message || e) });
            break; // stop on first error to avoid partial spam
          }
        }
        // Try to extract a final page title from properties
        const titlePropNameFinal = Object.entries(db.properties || {}).find(([, def]) => def.type === 'title')?.[0];
        const finalTitle = titlePropNameFinal && created?.properties?.[titlePropNameFinal]?.title
          ? created.properties[titlePropNameFinal].title.map((t) => t?.plain_text || '').join('')
          : undefined;
        const dbTitle = Array.isArray(db?.title) ? db.title.map((t) => t.plain_text).join('') : '';
        await recordRecentSave({ url: pageUrl, ts: Date.now(), databaseId, databaseTitle: dbTitle, title: finalTitle, sourceUrl: pageContext.url || '', durationMs: t1 - t0 });
        const totalSeconds = ((Date.now() - t0) / 1000).toFixed(1);
        dbgBg('SAVE_TO_NOTION: total time (s)', totalSeconds);
        sendResponse({ ok: true, page: created });      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }
    // If we got here, no known message type matched. Respond to avoid channel timeout.
    try {
      sendResponse({ ok: false, error: `Tipo de mensaje no reconocido: ${message?.type || 'desconocido'}` });
    } catch (_) {}
  })();
  // Indicate async response
  return true;
});
