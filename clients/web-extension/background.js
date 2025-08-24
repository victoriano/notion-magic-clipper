// background.js (service worker)
// Handles Notion API and OpenAI API calls, and coordinates saving pages
import { searchUntitledDatabases } from './utils/untitledDatabases.js';
import { searchAllDatabases } from './utils/listAllDatabases.js';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28'; // latest per Notion docs
const OPENAI_API_BASE = 'https://api.openai.com/v1';
const GPT5_NANO_MODEL = 'gpt-5-nano';
const GOOGLE_GENAI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Visual DEV badge for unpacked/local builds
const PROD_EXTENSION_ID = 'gohplijlpngkipjghachaaepbdlfabhk'; // update to your published Web Store ID
async function updateBadge() {
  try {
    const { backendUrl } = await getConfig();
    const usingLocal = typeof backendUrl === 'string' && /^https?:\/\/localhost(?::\d+)?/i.test(backendUrl);
    const isProdExtension = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id === PROD_EXTENSION_ID);
    if (!isProdExtension || usingLocal) {
      try { await chrome.action.setBadgeBackgroundColor({ color: '#9333ea' }); } catch {}
      try { await chrome.action.setBadgeText({ text: 'DEV' }); } catch {}
      try { await chrome.action.setTitle({ title: 'Notion Magic Clipper — Dev' }); } catch {}
    } else {
      try { await chrome.action.setBadgeText({ text: '' }); } catch {}
      try { await chrome.action.setTitle({ title: 'Notion Magic Clipper' }); } catch {}
    }
  } catch {
    try { await chrome.action.setBadgeText({ text: '' }); } catch {}
  }
}

// Resolve backend base URL with localhost preference for unpacked/dev installs when backendUrl is unset
async function getBackendBase() {
  try {
    const { backendUrl } = await getConfig();
    if (backendUrl && typeof backendUrl === 'string') return backendUrl.replace(/\/$/, '');
    const isProdExtension = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id === PROD_EXTENSION_ID);
    if (!isProdExtension) {
      return 'http://localhost:3000';
    }
  } catch {}
  return 'https://magic-clipper.vercel.app';
}

try { chrome.runtime.onInstalled.addListener(() => { updateBadge(); }); } catch {}
try { chrome.runtime.onStartup.addListener(() => { updateBadge(); }); } catch {}
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.backendUrl)) updateBadge();
  });
} catch {}

// Kick once
try { updateBadge(); } catch {}

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
        'openai_reasoning_effort', // still used for backend proxy
        'openai_verbosity',        // still used for backend proxy
        'databasePrompts',
        'databaseSettings',
        'llmProvider',
        'llmModel',
        'workspaceTokens',
        'dbWorkspaceMap',
        'backendUrl'
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

// Note: LLM calls are proxied by backend now; local LLM helpers removed.
// Build a prompt to map page context to Notion properties
// legacy removed: buildPromptForProperties (prompt is now built on the backend)

// legacy removed: extractSchemaForPrompt (schema reduced server-side)

// legacy removed: buildBookmarkBlocks / stripForbiddenFieldsFromBlocks

// Normalize and sanitize LLM-provided blocks into a safe subset supported by Notion API
// legacy removed: sanitizeBlocks (block sanitation is done on the backend)

// Build simple paragraph blocks from a text sample
// legacy removed: blocksFromTextSample

// Extract the first valid JSON object from a free-form string.
// legacy removed: extractJsonObject

// Messaging handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'LIST_DATABASES') {
      try {
        dbgBg('LIST_DATABASES: query =', message.query);
        const { notionSearchQuery } = await getConfig();
        const base = await getBackendBase();
        const url = `${base}/api/databases/search?q=${encodeURIComponent(message.query ?? notionSearchQuery ?? '')}`;
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error(`Backend ${resp.status}`);
        const data = await resp.json();
        const bases = Array.isArray(data?.databases) ? data.databases : [];
        try {
          const map = {};
          if (Array.isArray(bases)) {
            for (const db of bases) {
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
        const { workspaceTokens, notionToken } = await getConfig();
        const tokensMap = workspaceTokens && typeof workspaceTokens === 'object' ? workspaceTokens : {};
        const tokenValues = Object.values(tokensMap);
        let list = [];
        if (tokenValues.length === 0) {
          if (!notionToken) throw new Error('Missing Notion token. Configure it.');
          list = await searchUntitledDatabases(notionToken);
        } else {
          const per = await Promise.all(tokenValues.map(async (tok) => {
            try { return await searchUntitledDatabases(tok); } catch { return []; }
          }));
          const byId = new Map();
          for (const arr of per) { for (const db of arr) { if (!byId.has(db.id)) byId.set(db.id, db); } }
          list = Array.from(byId.values());
        }
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
        const { databaseId, pageContext } = message;
        if (!databaseId) throw new Error('databaseId faltante');
        if (!pageContext) throw new Error('pageContext faltante');
        dbgBg('SAVE_TO_NOTION: start', { databaseId, url: pageContext?.url });
        const { backendUrl, llmProvider, llmModel, databasePrompts, databaseSettings } = await getConfig();
        const settingsForDb = (databaseSettings || {})[databaseId] || {};
        const legacyPrompt = (databasePrompts || {})[databaseId] || '';
        const customInstructions = (settingsForDb.prompt ?? legacyPrompt) || '';
        const saveArticle = settingsForDb.saveArticle !== false;
        const customizeContent = settingsForDb.customizeContent === true;
        const contentPrompt = typeof settingsForDb.contentPrompt === 'string' ? settingsForDb.contentPrompt.trim() : '';
        const { openai_reasoning_effort, openai_verbosity } = await getConfig();
        const base = backendUrl ? backendUrl.replace(/\/$/, '') : await getBackendBase();
        const url = `${base}/api/clip/save`;
        const payload = {
          databaseId,
          pageContext,
          customInstructions,
          provider: llmProvider || 'openai',
          model: llmModel || 'gpt-5-nano',
          saveArticle,
          customizeContent,
          contentPrompt,
          reasoning_effort: openai_reasoning_effort || 'low',
          verbosity: openai_verbosity || 'low'
        };
        try {
          const approxSize = (() => { try { return JSON.stringify(payload).length; } catch { return 0; }})();
          dbgBg('BACKEND_REQUEST', { url, method: 'POST', approxPayloadBytes: approxSize });
        } catch {}
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload)
        });
        try {
          dbgBg('BACKEND_RESPONSE_META', {
            status: resp.status,
            ok: resp.ok,
            contentType: resp.headers.get('content-type') || '',
            allow: resp.headers.get('allow') || '',
            vary: resp.headers.get('vary') || ''
          });
        } catch {}
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          try { dbgBg('BACKEND_RESPONSE_BODY_ERR', text.slice(0, 2000)); } catch {}
          throw new Error(`Backend ${resp.status}: ${text}`);
        }
        const json = await resp.json().catch(async () => {
          const t = await resp.text().catch(() => '');
          throw new Error(`Backend JSON parse failed. Body: ${t.slice(0, 500)}`);
        });
        const page = json?.page;
        const saveId = json?.saveId;
        const enqueued = !!json?.enqueued;
        if (!page) throw new Error('No page returned');
        try {
          if (Array.isArray(json?.uploadDiagnostics) && json.uploadDiagnostics.length) {
            try { window.lastUploadDiagnostics = json.uploadDiagnostics; } catch {}
            // Print full object without truncation
            console.log('[NotionMagicClipper] UPLOAD_DIAGNOSTICS (full)', JSON.parse(JSON.stringify(json.uploadDiagnostics)));
          }
        } catch {}
        // If the work is enqueued, poll the await endpoint to get the final Notion page URL
        if (enqueued && saveId) {
          try {
            const baseB = await getBackendBase();
            const awaitUrl = `${baseB}/api/clip/await?id=${encodeURIComponent(saveId)}`;
            const deadline = Date.now() + 90_000; // up to 90s
            let finalUrl = page?.url || page?.public_url || '';
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 1500));
              const r2 = await fetch(awaitUrl, { credentials: 'include' });
              if (!r2.ok) break;
              const j2 = await r2.json().catch(() => ({}));
              const save = j2?.save;
              if (save?.status === 'succeeded') {
                if (typeof save?.notion_page_url === 'string' && save.notion_page_url) {
                  finalUrl = save.notion_page_url;
                }
                break;
              }
              if (save?.status === 'failed') {
                throw new Error(save?.error || 'Background save failed');
              }
            }
            try {
              const dbTitle = '';
              await recordRecentSave({ url: finalUrl || (page?.url || page?.public_url || ''), ts: Date.now(), databaseId, databaseTitle: dbTitle, title: '', sourceUrl: pageContext.url || '' });
            } catch {}
            sendResponse({ ok: true, page: { ...page, url: finalUrl || page?.url }, uploadDiagnostics: json?.uploadDiagnostics || [], saveId });
            return;
          } catch (e) {
            // Fall back to returning the stub page
          }
        }
        // Non-enqueued (sync path) or polling failed – return immediate page
        try {
          const dbTitle = '';
          await recordRecentSave({ url: page?.url || page?.public_url || '', ts: Date.now(), databaseId, databaseTitle: dbTitle, title: '', sourceUrl: pageContext.url || '' });
        } catch {}
        sendResponse({ ok: true, page, uploadDiagnostics: json?.uploadDiagnostics || [], saveId });
      } catch (e) {
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
