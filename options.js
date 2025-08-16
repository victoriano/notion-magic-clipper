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

// ---- Notion OAuth helpers ----
function buildNotionOAuthUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    owner: 'user',
    redirect_uri: redirectUri,
    state
  });
  return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;
}

async function exchangeNotionCodeForToken({ clientId, clientSecret, code, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  });
  const basic = btoa(`${clientId}:${clientSecret}`);
  const resp = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Notion-Version': '2022-06-28'
    },
    body
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Notion OAuth token exchange failed: ${text}`);
  }
  return resp.json();
}

function getExtensionRedirectUrl() {
  // Using chrome.identity redirect URL for extensions
  try {
    return chrome.identity.getRedirectURL('notion_oauth');
  } catch {
    // Fallback for environments without identity
    const id = chrome.runtime.id || 'ext';
    return `https://${id}.chromiumapp.org/notion_oauth`;
  }
}

async function renderOauthList() {
  const listEl = document.getElementById('notionOauthList');
  const status = document.getElementById('oauthStatus');
  const { notionOAuthConnections } = await get(['notionOAuthConnections']);
  const conns = Array.isArray(notionOAuthConnections) ? notionOAuthConnections : [];
  listEl.innerHTML = '';
  if (!conns.length) {
    status.textContent = 'No connected workspaces yet.';
    return;
  }
  status.textContent = '';
  for (let i = 0; i < conns.length; i++) {
    const c = conns[i];
    const li = document.createElement('li');
    const name = c.workspace_name || c.workspaceName || 'Workspace';
    const id = c.workspace_id || c.workspaceId || '';
    const span = document.createElement('span');
    span.textContent = `${name}${id ? ` (${id})` : ''}`;
    const btn = document.createElement('button');
    btn.textContent = 'Disconnect';
    btn.style.marginLeft = '8px';
    btn.addEventListener('click', async () => {
      const next = conns.slice(0, i).concat(conns.slice(i + 1));
      await set({ notionOAuthConnections: next });
      await renderOauthList();
    });
    li.appendChild(span);
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

async function connectNotionOAuth() {
  const status = document.getElementById('oauthStatus');
  status.textContent = '';
  const clientId = (document.getElementById('notionOAuthClientId')?.value || '').trim();
  const clientSecret = (document.getElementById('notionOAuthClientSecret')?.value || '').trim();
  if (!clientId || !clientSecret) {
    status.textContent = 'Client ID and Secret are required.';
    return;
  }
  const redirectUri = getExtensionRedirectUrl();
  const state = Math.random().toString(36).slice(2);
  const authUrl = buildNotionOAuthUrl(clientId, redirectUri, state);
  try {
    const responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (redirectedTo) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(redirectedTo);
      });
    });
    const u = new URL(responseUrl);
    const returnedState = u.searchParams.get('state');
    const code = u.searchParams.get('code');
    const error = u.searchParams.get('error');
    if (error) throw new Error(error);
    if (!code) throw new Error('No authorization code returned');
    if (returnedState !== state) throw new Error('State mismatch');
    const token = await exchangeNotionCodeForToken({ clientId, clientSecret, code, redirectUri });
    const entry = {
      access_token: token.access_token,
      workspace_id: token.workspace_id || token.workspace?.id,
      workspace_name: token.workspace_name || token.workspace?.name,
      workspace_icon: token.workspace_icon || token.workspace?.icon,
      bot_id: token.bot_id,
      owner: token.owner
    };
    const { notionOAuthConnections } = await get(['notionOAuthConnections']);
    const list = Array.isArray(notionOAuthConnections) ? notionOAuthConnections : [];
    // De-duplicate by workspace_id
    const exists = list.findIndex((x) => (x.workspace_id || x.workspaceId) === entry.workspace_id);
    if (exists >= 0) list.splice(exists, 1, entry);
    else list.push(entry);
    await set({ notionOAuthConnections: list, notionOAuthClientId: clientId, notionOAuthClientSecret: clientSecret });
    status.textContent = 'Connected ✓';
    status.classList.add('success');
    await renderOauthList();
  } catch (e) {
    status.textContent = String(e?.message || e);
    status.classList.remove('success');
  }
}

async function load() {
  const { notionToken, openaiKey, googleApiKey, openai_reasoning_effort, openai_verbosity, llmProvider, llmModel, notionOAuthClientId, notionOAuthClientSecret } = await get([
    'notionToken', 'openaiKey', 'googleApiKey', 'openai_reasoning_effort', 'openai_verbosity', 'llmProvider', 'llmModel', 'notionOAuthClientId', 'notionOAuthClientSecret'
  ]);
  if (notionToken) document.getElementById('notionToken').value = notionToken;
  if (openaiKey) document.getElementById('openaiKey').value = openaiKey;
  if (googleApiKey) document.getElementById('googleApiKey').value = googleApiKey;
  if (openai_reasoning_effort) document.getElementById('reasoning').value = openai_reasoning_effort;
  if (openai_verbosity) document.getElementById('verbosity').value = openai_verbosity;
  if (notionOAuthClientId) document.getElementById('notionOAuthClientId').value = notionOAuthClientId;
  if (notionOAuthClientSecret) document.getElementById('notionOAuthClientSecret').value = notionOAuthClientSecret;
  const redirectEl = document.getElementById('oauthRedirectInfo');
  if (redirectEl) redirectEl.textContent = `OAuth redirect URL: ${getExtensionRedirectUrl()}`;
  await populateModelSelector({ openaiKey, googleApiKey, llmProvider, llmModel });
  await renderOauthList();
  const connectBtn = document.getElementById('connectNotionOauth');
  if (connectBtn) connectBtn.addEventListener('click', connectNotionOAuth);
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
  const notionOAuthClientId = (document.getElementById('notionOAuthClientId')?.value || '').trim();
  const notionOAuthClientSecret = (document.getElementById('notionOAuthClientSecret')?.value || '').trim();

  await set({ notionToken, openaiKey, googleApiKey, openai_reasoning_effort, openai_verbosity, llmProvider, llmModel, notionOAuthClientId, notionOAuthClientSecret });
  status.innerHTML = '<span class="success">Saved ✓</span>';
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
  const { notionToken, notionOAuthConnections } = await get(['notionToken', 'notionOAuthConnections']);
  const oauthConns = Array.isArray(notionOAuthConnections) ? notionOAuthConnections : [];
  const token = notionToken || oauthConns[0]?.access_token; // best-effort fallback for direct calls from Options
  if (!token) throw new Error('Missing Notion token. Configure Integration token or connect via OAuth.');
  const headers = {
    Authorization: `Bearer ${token}`,
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
    const workspace = db.workspaceName ? ` / ${db.workspaceName}` : '';
    a.textContent = `${emoji ? emoji + ' ' : ''}${db.title}${workspace}`;
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
      const hasPrompt = !!text;
      // Update badge color/text (badge not available here, so we won't update it)
    });
    clearBtn.addEventListener('click', async () => {
      ta.value = '';
      const map = await getDatabaseSettings();
      const prev = map[db.id] || { saveArticle: true, customizeContent: false };
      map[db.id] = { prompt: '', saveArticle: prev.saveArticle !== false, customizeContent: false, contentPrompt: '' };
      await setDatabaseSettings(map);
      mini.textContent = 'Cleared';
      mini.style.color = '#666';
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
load();
