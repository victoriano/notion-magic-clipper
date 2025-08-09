// background.js (service worker)
// Handles Notion API and OpenAI API calls, and coordinates saving pages
import { searchUntitledDatabases } from './utils/untitledDatabases.js';
import { searchAllDatabases } from './utils/listAllDatabases.js';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28'; // latest per Notion docs
const OPENAI_API_BASE = 'https://api.openai.com/v1';
const GPT5_NANO_MODEL = 'gpt-5-nano';

// Helpers to get/set tokens in storage
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        'notionToken',
        'openaiKey',
        'notionSearchQuery',
        'openai_reasoning_effort',
        'openai_verbosity',
        'databasePrompts'
      ],
      (res) => resolve(res)
    );
  });
}

// Notion API helpers
async function notionFetch(path, options = {}) {
  const { notionToken } = await getConfig();
  if (!notionToken) throw new Error('Falta el token de Notion. Configúralo en Opciones.');

  const headers = {
    'Authorization': `Bearer ${notionToken}`,
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
    return { id: item.id, title, iconEmoji };
  });
  return results;
}

async function getDatabase(databaseId) {
  return notionFetch(`/databases/${databaseId}`);
}

async function createPageInDatabase(databaseId, properties, pageContentBlocks = []) {
  const body = {
    parent: { database_id: databaseId },
    properties,
    ...(pageContentBlocks.length ? { children: pageContentBlocks } : {})
  };
  return notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

// Start a direct (single-part) file upload; returns { file_upload_id, upload_url }
async function startFileUpload(filename) {
  const body = { mode: 'single_part', filename: filename || 'upload.bin' };
  const data = await notionFetch('/file_uploads', { method: 'POST', body: JSON.stringify(body) });
  return { file_upload_id: data?.id, upload_url: data?.upload_url };
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
async function ensureSelectOptions(databaseId, props) {
  if (!props || typeof props !== 'object') return;
  const db = await getDatabase(databaseId);
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
    });
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
  return content;
}

// Build a prompt to map page context to Notion properties
function buildPromptForProperties(schema, pageContext, customInstructions) {
  const { url, title, meta, selectionText, textSample } = pageContext;
  const schemaStr = JSON.stringify(schema, null, 2);
  const contextStr = JSON.stringify({ url, title, meta, selectionText, textSample }, null, 2);
  const messages = [
    {
      role: 'system',
      content: [
        'You are an assistant that generates both Notion PROPERTIES and CONTENT from a database schema and page context.',
        'Return only VALID JSON shaped as { "properties": { ... }, "children"?: [ ... ] }.',
        '- "properties": must use the exact Notion API structure and respect the provided schema types.',
        '- "children" (optional): list of Notion blocks using ONLY: paragraph, heading_1, heading_2, heading_3, bulleted_list_item, numbered_list_item, quote, bookmark, image.',
        'Use simple rich_text with plain text in each block; do not include comments or text outside the JSON.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Database schema (properties):\n${schemaStr}`,
        `\nPage context:\n${contextStr}`,
        '\n\nInstructions:',
        '- Fill as many properties as possible based on the context.',
        '- There must be exactly one "title" property and you must set it to the best possible title.',
        '- For select/multi_select: use existing options by exact name. Do NOT create new options by default. Only propose new options if the custom database instructions explicitly allow creating options. If no clear match exists and creation is not allowed, omit the property.',
        '- If a property name suggests an image (e.g., "Poster", "Cover", "Thumbnail", "Artwork", "Image", "Screenshot") and the page context contains an image URL (e.g., og:image or twitter:image), prefer filling that property with the image URL. If the database uses a files property, use the Notion files property shape with an external URL. Optionally, also add an image block to children using the same URL.',
        '- For dates, if no specific date is found in the content, you may use the current date/time.',
        '- For url, set the page URL if an appropriate property exists.',
        '- Omit properties you cannot determine (do not invent values).',
        '- Do NOT include read-only properties (rollup, created_time, etc.).',
        '- Optionally, generate "children" with brief structured blocks extracted from the context (e.g., headings and bullets).',
        '- Return ONLY one JSON object shaped as { "properties": { ... }, "children"?: [ ... ] }.'
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

function buildBookmarkBlocks(url, note) {
  const blocks = [];
  if (note) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: note } }]
      }
    });
  }
  if (url) {
    blocks.push({
      object: 'block',
      type: 'bookmark',
      bookmark: { url }
    });
  }
  return blocks;
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
      const uploadId = b?.image?.file_upload?.file_upload_id || b?.file_upload_id;
      if (typeof url === 'string' && url) {
        out.push({ object: 'block', type: 'image', image: { external: { url } } });
        continue;
      }
      if (typeof uploadId === 'string' && uploadId) {
        out.push({ object: 'block', type: 'image', image: { file_upload: { file_upload_id: uploadId } } });
        continue;
      }
      continue;
    }
    const field = b[type];
    const txt = field?.rich_text || b.text || b.content || '';
    out.push({ object: 'block', type, [type]: { rich_text: Array.isArray(txt) ? txt : toRichText(txt) } });
  }
  return out;
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
        const { notionSearchQuery } = await getConfig();
        const bases = await listDatabases(message.query ?? notionSearchQuery ?? '');
        sendResponse({ ok: true, databases: bases });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (message?.type === 'LIST_UNTITLED_DATABASES') {
      try {
        const { notionToken } = await getConfig();
        if (!notionToken) throw new Error('Falta el token de Notion. Configúralo en Opciones.');
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
        if (!notionToken) throw new Error('Falta el token de Notion. Configúralo en Opciones.');
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
        const res = await startFileUpload(filename);
        if (!res?.file_upload_id || !res?.upload_url) throw new Error('Failed to start file upload');
        sendResponse({ ok: true, ...res });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (message?.type === 'SAVE_TO_NOTION') {
      try {
        const { databaseId, pageContext, note } = message;
        if (!databaseId) throw new Error('databaseId faltante');
        if (!pageContext) throw new Error('pageContext faltante');

        const db = await getDatabase(databaseId);
        const schemaForLLM = extractSchemaForPrompt(db);
        const { openai_reasoning_effort, openai_verbosity, databasePrompts } = await getConfig();
        const customInstructions = (databasePrompts || {})[databaseId] || '';
        const prompt = buildPromptForProperties(schemaForLLM, pageContext, customInstructions);

        const content = await openaiChat(prompt, {
          model: GPT5_NANO_MODEL,
          reasoning_effort: openai_reasoning_effort || 'low',
          verbosity: openai_verbosity || 'low'
        });

        // Parse JSON block from content (robust extractor)
        const parsed = extractJsonObject(content);
        if (!parsed) {
          throw new Error('The model did not return valid JSON for properties.');
        }

        if (!parsed || typeof parsed !== 'object' || !parsed.properties) {
          throw new Error('Falta la clave "properties" en la salida del modelo.');
        }

        // Ensure a URL property is set if schema has one and model omitted it
        const urlPropName = Object.entries(db.properties || {}).find(([, def]) => def.type === 'url')?.[0];
        if (urlPropName && !parsed.properties[urlPropName] && pageContext.url) {
          parsed.properties[urlPropName] = { url: pageContext.url };
        }

        // Sanitize and normalize properties to valid Notion API shapes
        function sanitizeProperties(db, props) {
          const out = {};
          const schema = db.properties || {};

          function toRichText(text) {
            const content = typeof text === 'string' ? text : '';
            return [{ type: 'text', text: { content } }];
          }

          function normalizeValueByType(def, value) {
            const type = def.type;
            if (value == null) return undefined;
            switch (type) {
              case 'title': {
                if (Array.isArray(value?.title)) return { title: value.title };
                if (typeof value === 'string') return { title: toRichText(value) };
                if (typeof value?.text === 'string') return { title: toRichText(value.text) };
                if (Array.isArray(value)) return { title: value };
                return undefined;
              }
              case 'rich_text': {
                if (Array.isArray(value?.rich_text)) return { rich_text: value.rich_text };
                if (typeof value === 'string') return { rich_text: toRichText(value) };
                if (typeof value?.text === 'string') return { rich_text: toRichText(value.text) };
                if (Array.isArray(value)) return { rich_text: value };
                return undefined;
              }
              case 'url': {
                const url = typeof value === 'string' ? value : value?.url;
                if (typeof url === 'string' && url.length > 0) return { url };
                return undefined;
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
        if (parsed.children || parsed.blocks || parsed.content) {
          children = sanitizeBlocks(parsed.children || parsed.blocks || parsed.content || []);
        }
        // Append uploaded images (from popup) as blocks
        const attachmentBlocks = Array.isArray(message.attachments)
          ? message.attachments
              .filter((a) => typeof a?.file_upload_id === 'string')
              .map((a) => ({ object: 'block', type: 'image', image: { file_upload: { file_upload_id: a.file_upload_id } } }))
          : [];
        // Ensure select options exist (auto-create missing ones)
        await ensureSelectOptions(databaseId, safeProps);
        // Always add user note and bookmark at the top if provided
        const addon = buildBookmarkBlocks(pageContext.url, note);
        const blocks = addon.concat(attachmentBlocks).concat(children);
        // Prefer the start time from the popup for end-to-end duration; fallback to now
        const t0 = typeof message.startedAt === 'number' ? message.startedAt : Date.now();
        const created = await createPageInDatabase(databaseId, safeProps, blocks);
        const t1 = Date.now();
        const pageUrl = created?.url || created?.public_url || '';
        // Try to extract a final page title from properties
        const titlePropNameFinal = Object.entries(db.properties || {}).find(([, def]) => def.type === 'title')?.[0];
        const finalTitle = titlePropNameFinal && created?.properties?.[titlePropNameFinal]?.title
          ? created.properties[titlePropNameFinal].title.map((t) => t?.plain_text || '').join('')
          : undefined;
        const dbTitle = Array.isArray(db?.title) ? db.title.map((t) => t.plain_text).join('') : '';
        await recordRecentSave({ url: pageUrl, ts: Date.now(), databaseId, databaseTitle: dbTitle, title: finalTitle, sourceUrl: pageContext.url || '', durationMs: t1 - t0 });
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
