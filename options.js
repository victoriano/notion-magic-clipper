// options.js

function get(keys) { return new Promise((resolve) => chrome.storage.local.get(keys, resolve)); }
function set(obj) { return new Promise((resolve) => chrome.storage.local.set(obj, resolve)); }

function parseModelValue(value) {
  const [provider, ...rest] = String(value || '').split(':');
  return { provider: provider || 'openai', model: rest.join(':') || 'gpt-5-nano' };
}

function updateReasoningVisibility(provider, model) {
  const reasoningCol = document.getElementById('reasoningCol');
  const verbosityCol = document.getElementById('verbosityCol');
  const isGPT5 = provider === 'openai' && /^gpt-5/i.test(model || '');
  if (reasoningCol) reasoningCol.style.display = isGPT5 ? 'block' : 'none';
  if (verbosityCol) verbosityCol.style.display = isGPT5 ? 'block' : 'none';
}

async function populateModelSelector({ openaiKey, googleApiKey, llmProvider, llmModel }) {
  const sel = document.getElementById('model');
  if (!sel) return;
  sel.innerHTML = '';
  const options = [];
  if (openaiKey) options.push({ value: 'openai:gpt-5-nano', label: 'OpenAI · GPT-5 Nano' });
  if (googleApiKey) options.push({ value: 'google:gemini-2.5-flash', label: 'Google · Gemini 2.5 Flash' });
  if (options.length === 0) options.push({ value: 'openai:gpt-5-nano', label: 'OpenAI · GPT-5 Nano' });
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  const desired = `${llmProvider || 'openai'}:${llmModel || 'gpt-5-nano'}`;
  const found = Array.from(sel.options).some((o) => o.value === desired);
  sel.value = found ? desired : options[0].value;
  const parsed = parseModelValue(sel.value);
  await set({ llmProvider: parsed.provider, llmModel: parsed.model });
  updateReasoningVisibility(parsed.provider, parsed.model);
  sel.addEventListener('change', async () => {
    const p = parseModelValue(sel.value);
    await set({ llmProvider: p.provider, llmModel: p.model });
    updateReasoningVisibility(p.provider, p.model);
  });
}

async function load() {
  const { notionToken, openaiKey, googleApiKey, openai_reasoning_effort, openai_verbosity, llmProvider, llmModel, backendUrl } = await get([
    'notionToken', 'openaiKey', 'googleApiKey', 'openai_reasoning_effort', 'openai_verbosity', 'llmProvider', 'llmModel', 'backendUrl'
  ]);
  if (notionToken) document.getElementById('notionToken').value = notionToken;
  if (openaiKey) document.getElementById('openaiKey').value = openaiKey;
  if (googleApiKey) document.getElementById('googleApiKey').value = googleApiKey;
  if (openai_reasoning_effort) document.getElementById('reasoning').value = openai_reasoning_effort;
  if (openai_verbosity) document.getElementById('verbosity').value = openai_verbosity;
  const effectiveBackendUrl = backendUrl || 'http://localhost:3000';
  const backendInput = document.getElementById('backendUrl');
  if (backendInput) backendInput.value = effectiveBackendUrl;
  await populateModelSelector({ openaiKey, googleApiKey, llmProvider, llmModel });
}

async function save() {
  const status = document.getElementById('status');
  status.textContent = '';
  const notionToken = document.getElementById('notionToken').value.trim();
  const openaiKey = document.getElementById('openaiKey').value.trim();
  const googleApiKey = (document.getElementById('googleApiKey')?.value || '').trim();
  const openai_reasoning_effort = document.getElementById('reasoning').value;
  const openai_verbosity = document.getElementById('verbosity').value;
  const modelSel = document.getElementById('model');
  const { provider: llmProvider, model: llmModel } = parseModelValue(modelSel ? modelSel.value : 'openai:gpt-5-nano');

  const backendUrl = (document.getElementById('backendUrl')?.value || '').trim();
  await set({ notionToken, openaiKey, googleApiKey, openai_reasoning_effort, openai_verbosity, llmProvider, llmModel, backendUrl });
  status.innerHTML = '<span class="success">Saved ✓</span>';
}

function openNotionOAuth() {
  const input = document.getElementById('backendUrl');
  const url = (input?.value || 'http://localhost:3000').trim();
  const startUrl = url.replace(/\/$/, '') + '/api/notion/start';
  window.open(startUrl, '_blank', 'noopener,noreferrer');
}

async function listUntitled() {
  const status = document.getElementById('untitledStatus');
  const listEl = document.getElementById('untitledList');
  status.textContent = 'Searching untitled databases...';
  listEl.innerHTML = '';
  try {
    let items;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'LIST_UNTITLED_DATABASES' });
      if (!res?.ok) throw new Error(res?.error || 'Search error (background)');
      items = res.databases || [];
    } catch (err) {
      // Fallback: query Notion directly from the Options page (avoids background lifetime issues)
      items = await searchUntitledDatabasesDirect();
    }
    status.textContent = `Found ${items.length} untitled databases`;
    if (!items.length) return;
    for (const db of items) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = db.url;
      a.textContent = `${db.id}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      li.appendChild(a);
      listEl.appendChild(li);
    }
  } catch (e) {
    status.textContent = String(e?.message || e);
  }
}

async function listAllDatabasesFromOptions() {
  const status = document.getElementById('allStatus');
  const listEl = document.getElementById('allList');
  const queryInput = document.getElementById('allDbQuery');
  const query = (queryInput?.value || '').trim();
  status.textContent = 'Fetching all databases...';
  listEl.innerHTML = '';
  try {
    let items;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'LIST_ALL_DATABASES', query });
      if (!res?.ok) throw new Error(res?.error || 'List error (background)');
      items = res.databases || [];
    } catch (err) {
      // Fallback: fetch directly from Options page
      items = await searchAllDatabasesDirect(query);
    }
    // Sync settings with current accessible databases (drop missing, add new as defaults)
    const settings = await syncSettingsWithDatabases(items);

    status.textContent = `Found ${items.length} databases`;
    renderAllDatabasesList(listEl, items, settings);
  } catch (e) {
    status.textContent = String(e?.message || e);
  }
}

// ---- Direct Notion fetch fallbacks (Options page) ----
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

async function notionFetchFromOptions(path, options = {}) {
  const { notionToken } = await get(['notionToken']);
  if (!notionToken) throw new Error('Missing Notion token. Configure it and save changes.');
  const headers = {
    Authorization: `Bearer ${notionToken}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const resp = await fetch(`${NOTION_API_BASE}${path}`, { ...options, headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Notion API ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function searchAllDatabasesDirect(query = '') {
  let cursor = null;
  const all = [];
  do {
    const body = {
      query,
      filter: { property: 'object', value: 'database' },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    };
    const data = await notionFetchFromOptions('/search', { method: 'POST', body: JSON.stringify(body) });
    const results = Array.isArray(data.results) ? data.results : [];
    for (const item of results) {
      const title = (item?.title || []).map((t) => t?.plain_text || '').join('') || '(Untitled)';
      const url = item.url || `https://www.notion.so/${String(item.id || '').replace(/-/g, '')}`;
      const iconEmoji = item?.icon?.type === 'emoji' ? item.icon.emoji : undefined;
      all.push({ id: item.id, title, url, iconEmoji });
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return all;
}

async function searchUntitledDatabasesDirect() {
  const all = await searchAllDatabasesDirect('');
  return all.filter((d) => !d.title || d.title.trim().length === 0 || d.title === '(Untitled)');
}

// ---- Prompts storage helpers ----
async function getDatabasePrompts() {
  const { databasePrompts } = await get(['databasePrompts']);
  return databasePrompts && typeof databasePrompts === 'object' ? databasePrompts : {};
}

async function setDatabasePrompts(map) {
  await set({ databasePrompts: map });
}

async function syncPromptsWithDatabases(databases) {
  const existing = await getDatabasePrompts();
  const next = {};
  for (const db of databases || []) {
    next[db.id] = Object.prototype.hasOwnProperty.call(existing, db.id) ? existing[db.id] : '';
  }
  await setDatabasePrompts(next);
  return next;
}

// ---- Unified per-database settings (prompt + saveArticle flag) ----
async function getDatabaseSettings() {
  const { databaseSettings } = await get(['databaseSettings']);
  return databaseSettings && typeof databaseSettings === 'object' ? databaseSettings : {};
}

async function setDatabaseSettings(map) {
  await set({ databaseSettings: map });
}

async function syncSettingsWithDatabases(databases) {
  const [existingSettings, legacyPrompts] = await Promise.all([
    getDatabaseSettings(),
    getDatabasePrompts()
  ]);
  const next = {};
  for (const db of databases || []) {
    const prev = existingSettings[db.id] || {};
    const prompt = typeof prev.prompt === 'string' ? prev.prompt : (legacyPrompts[db.id] || '');
    const saveArticle = prev.saveArticle !== false; // default true
    const customizeContent = prev.customizeContent === true; // default false
    const contentPrompt = typeof prev.contentPrompt === 'string' ? prev.contentPrompt : '';
    next[db.id] = { prompt, saveArticle, customizeContent, contentPrompt };
  }
  await setDatabaseSettings(next);
  return next;
}

function renderAllDatabasesList(container, items, settings) {
  container.innerHTML = '';
  for (const db of items) {
    const li = document.createElement('li');
    const top = document.createElement('div');
    const a = document.createElement('a');
    a.href = db.url;
    const emoji = db.iconEmoji || '';
    a.textContent = `${emoji ? emoji + ' ' : ''}${db.title}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const current = (settings && settings[db.id]) || { prompt: '', saveArticle: true, customizeContent: false, contentPrompt: '' };
    const hasPrompt = (current.prompt || '').trim().length > 0;
    const badge = document.createElement('span');
    badge.textContent = hasPrompt ? ' · prompt saved' : '';
    badge.style.color = hasPrompt ? '#0b7a0b' : '#666';
    badge.style.fontSize = '12px';

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit prompt';
    editBtn.style.marginLeft = '8px';

    top.appendChild(a);
    top.appendChild(editBtn);
    top.appendChild(badge);
    li.appendChild(top);

    const panel = document.createElement('div');
    panel.style.display = 'none';
    panel.style.marginTop = '8px';
    const ta = document.createElement('textarea');
    ta.rows = 4;
    ta.style.width = '100%';
    ta.placeholder = 'Custom instructions for this database (how to map, which properties to prioritize, etc.)';
    ta.value = current.prompt || '';

    const behavior = document.createElement('label');
    behavior.style.display = 'flex';
    behavior.style.alignItems = 'center';
    behavior.style.gap = '6px';
    behavior.style.marginTop = '6px';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = current.saveArticle !== false; // default true
    const txt = document.createElement('span');
    txt.textContent = 'Save article content as page content (default on)';
    behavior.appendChild(chk);
    behavior.appendChild(txt);

    const customize = document.createElement('label');
    customize.style.display = (chk.checked ? 'flex' : 'none');
    customize.style.alignItems = 'center';
    customize.style.gap = '6px';
    customize.style.marginTop = '6px';
    const customizeChk = document.createElement('input');
    customizeChk.type = 'checkbox';
    customizeChk.checked = current.customizeContent === true;
    const customizeTxt = document.createElement('span');
    customizeTxt.textContent = 'Customize content page';
    customize.appendChild(customizeChk);
    customize.appendChild(customizeTxt);

    const contentTa = document.createElement('textarea');
    contentTa.rows = 3;
    contentTa.style.width = '100%';
    contentTa.placeholder = 'Content customization for article children (e.g., write a concise summary with key points, extract pricing table, etc.)';
    contentTa.value = current.contentPrompt || '';
    contentTa.style.display = (chk.checked && customizeChk.checked ? 'block' : 'none');
    const actions = document.createElement('div');
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    clearBtn.style.marginLeft = '8px';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.marginLeft = '8px';
    const mini = document.createElement('span');
    mini.style.marginLeft = '8px';

    actions.appendChild(saveBtn);
    actions.appendChild(clearBtn);
    actions.appendChild(closeBtn);
    actions.appendChild(mini);
    panel.appendChild(ta);
    panel.appendChild(behavior);
    panel.appendChild(customize);
    panel.appendChild(contentTa);
    panel.appendChild(actions);
    li.appendChild(panel);

    editBtn.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    chk.addEventListener('change', () => {
      customize.style.display = chk.checked ? 'flex' : 'none';
      contentTa.style.display = (chk.checked && customizeChk.checked ? 'block' : 'none');
    });
    customizeChk.addEventListener('change', () => {
      contentTa.style.display = (chk.checked && customizeChk.checked ? 'block' : 'none');
    });
    saveBtn.addEventListener('click', async () => {
      const text = ta.value.trim();
      const map = await getDatabaseSettings();
      map[db.id] = { prompt: text, saveArticle: !!chk.checked, customizeContent: !!customizeChk.checked, contentPrompt: contentTa.value.trim() };
      await setDatabaseSettings(map);
      mini.textContent = 'Saved ✓';
      mini.style.color = '#0b7a0b';
      badge.textContent = text ? ' · prompt saved' : '';
      badge.style.color = text ? '#0b7a0b' : '#666';
    });
    clearBtn.addEventListener('click', async () => {
      ta.value = '';
      const map = await getDatabaseSettings();
      const prev = map[db.id] || { saveArticle: true, customizeContent: false };
      map[db.id] = { prompt: '', saveArticle: prev.saveArticle !== false, customizeContent: false, contentPrompt: '' };
      await setDatabaseSettings(map);
      mini.textContent = 'Cleared';
      mini.style.color = '#666';
      badge.textContent = '';
      customizeChk.checked = false;
      contentTa.value = '';
      contentTa.style.display = 'none';
      customize.style.display = chk.checked ? 'flex' : 'none';
    });
    closeBtn.addEventListener('click', () => {
      panel.style.display = 'none';
    });

    container.appendChild(li);
  }
}

document.getElementById('saveBtn').addEventListener('click', save);
document.getElementById('listUntitledBtn').addEventListener('click', listUntitled);
document.getElementById('listAllBtn').addEventListener('click', listAllDatabasesFromOptions);
document.getElementById('notionOauthBtn')?.addEventListener('click', openNotionOAuth);
load();
