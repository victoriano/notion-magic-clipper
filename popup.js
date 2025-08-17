// popup.js

function getCurrentTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
}

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function formatModelLabel(provider, model) {
  if (provider === 'google' && /gemini-2\.5-flash/i.test(model || '')) return 'Google · Gemini 2.5 Flash';
  if (provider === 'openai' && /^gpt-5/i.test(model || '')) return 'OpenAI · GPT-5 Nano';
  if (provider && model) return `${provider}:${model}`;
  return 'Selected model';
}

// --- Combobox state ---
let dbList = [];
let dbFiltered = [];
let dbSelectedId = '';
let comboOpen = false;
let comboboxHandlersAttached = false;
let needsReloadDatabases = false;

function getDbElements() {
  return {
    trigger: document.getElementById('dbComboTrigger'),
    dropdown: document.getElementById('dbComboDropdown'),
    list: document.getElementById('dbComboList'),
    empty: document.getElementById('dbComboEmpty'),
    label: document.getElementById('dbComboLabel'),
    search: document.getElementById('dbComboSearch')
  };
}

function setComboOpen(open) {
  const { trigger, dropdown } = getDbElements();
  comboOpen = !!open;
  trigger.setAttribute('aria-expanded', comboOpen ? 'true' : 'false');
  dropdown.style.display = comboOpen ? 'block' : 'none';
  dropdown.setAttribute('aria-hidden', comboOpen ? 'false' : 'true');
  if (comboOpen) {
    // Focus search on open
    setTimeout(() => getDbElements().search?.focus(), 0);
  }
}

function renderDbList(items) {
  const { list, empty } = getDbElements();
  list.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  for (const db of items) {
    const row = document.createElement('div');
    row.className = 'cbx-item';
    row.setAttribute('role', 'option');
    row.dataset.id = db.id;
    const emoji = db.iconEmoji || '';
    const left = document.createElement('span');
    left.textContent = (emoji ? `${emoji} ` : '') + db.title;
    const check = document.createElement('span');
    check.textContent = '✓';
    check.className = 'cbx-check';
    row.appendChild(left);
    row.appendChild(check);
    if (dbSelectedId && dbSelectedId === db.id) row.setAttribute('aria-selected', 'true');
    row.addEventListener('click', () => {
      setSelectedDb(db.id);
      setComboOpen(false);
    });
    list.appendChild(row);
  }
}

function setSelectedDb(id) {
  dbSelectedId = id || '';
  const { label, list } = getDbElements();
  const found = dbList.find((d) => d.id === dbSelectedId);
  label.textContent = found ? `${found.iconEmoji ? found.iconEmoji + ' ' : ''}${found.title}` : 'Select database...';
  // update selection check
  Array.from(list.querySelectorAll('.cbx-item')).forEach((el) => {
    if (el.dataset.id === dbSelectedId) el.setAttribute('aria-selected', 'true');
    else el.removeAttribute('aria-selected');
  });
  // update settings link label
  const openBtn = document.getElementById('openDbSettings');
  if (openBtn) openBtn.textContent = 'Custom save format';
}

function filterDbList(term) {
  const t = String(term || '').toLowerCase();
  if (!t) {
    dbFiltered = dbList.slice();
  } else {
    dbFiltered = dbList.filter((d) => {
      const s = `${d.title} ${d.iconEmoji || ''}`.toLowerCase();
      return s.includes(t);
    });
  }
  renderDbList(dbFiltered);
}

function attachComboboxHandlers() {
  if (comboboxHandlersAttached) return;
  comboboxHandlersAttached = true;
  const { trigger, search, dropdown, list } = getDbElements();
  trigger.addEventListener('click', () => setComboOpen(!comboOpen));
  search.addEventListener('input', (e) => filterDbList(e.target.value));
  // Keyboard navigation
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setComboOpen(true);
    }
  });
  dropdown.addEventListener('keydown', (e) => {
    const items = Array.from(list.querySelectorAll('.cbx-item'));
    const currentIndex = items.findIndex((el) => el.dataset.id === dbSelectedId);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = items[Math.min(items.length - 1, currentIndex + 1)] || items[0];
      if (next) setSelectedDb(next.dataset.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = items[Math.max(0, currentIndex - 1)] || items[items.length - 1];
      if (prev) setSelectedDb(prev.dataset.id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      setComboOpen(false);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setComboOpen(false);
    }
  });
  // Close on outside click
  document.addEventListener('click', (e) => {
    const root = document.getElementById('dbCombobox');
    if (!root.contains(e.target)) setComboOpen(false);
  });
}

async function precheck(opts = {}) {
  const pre = document.getElementById('precheck');
  const app = document.getElementById('app');
  const indicator = document.getElementById('statusIndicator');
  const cfg = await getStorage(['notionToken', 'openaiKey', 'googleApiKey', 'llmProvider', 'llmModel', 'backendUrl']);
  const provider = cfg.llmProvider || 'openai';
  const model = cfg.llmModel || 'gpt-5-nano';
  const hasNotion = !!cfg.notionToken;
  const hasOpenAI = !!cfg.openaiKey;
  const hasGoogle = !!cfg.googleApiKey;
  let hasLLM = false;
  if (provider === 'openai') hasLLM = hasOpenAI;
  else if (provider === 'google') hasLLM = hasGoogle;
  else hasLLM = hasOpenAI || hasGoogle; // fallback if unknown provider
  const ok = hasNotion && hasLLM;
  if (indicator) {
    indicator.classList.toggle('ok', ok);
    indicator.classList.toggle('err', !ok);
    indicator.title = ok ? 'Tokens configured' : 'Tokens missing — click to configure';
    indicator.setAttribute('aria-label', indicator.title);
  }
  if (!opts.preserveViews) app.style.display = 'block';
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] precheck complete`);
}

// Open the Tokens configuration view from anywhere
async function openTokensView() {
  const tokensView = document.getElementById('tokensView');
  const tokensStatus = document.getElementById('tokensStatus');
  const tModel = document.getElementById('tModel');
  const appView = document.getElementById('app');
  const notionInput = document.getElementById('tNotionToken');
  const openaiInput = document.getElementById('tOpenAI');
  const googleInput = document.getElementById('tGoogle');
  const backendInput = document.getElementById('tBackendUrl');
  const workspaceInput = document.getElementById('tWorkspaceId');
  const advancedBackendRow = document.getElementById('advancedBackendRow');
  const advancedBackendUrl = document.getElementById('advancedBackendUrl');

  const { notionToken, openaiKey, googleApiKey, llmProvider, llmModel, backendUrl, workspaceId } = await getStorage(['notionToken', 'openaiKey', 'googleApiKey', 'llmProvider', 'llmModel', 'backendUrl', 'workspaceId']);
  if (notionInput) notionInput.value = notionToken || '';
  if (openaiInput) openaiInput.value = openaiKey || '';
  if (googleInput) googleInput.value = googleApiKey || '';
  if (backendInput) backendInput.value = (backendUrl || 'http://localhost:3000');
  if (workspaceInput) workspaceInput.value = workspaceId || '';
  // Hide backend UI by default; show only if a dev flag is set
  const showAdvanced = /\bdev=1\b/i.test(location.search) || (await getStorage(['showAdvanced']))?.showAdvanced === true;
  if (advancedBackendRow) advancedBackendRow.style.display = showAdvanced ? 'flex' : 'none';
  if (advancedBackendUrl) advancedBackendUrl.style.display = showAdvanced ? 'block' : 'none';

  // Populate model selector based on available keys
  const options = [];
  if (openaiKey) options.push({ value: 'openai:gpt-5-nano', label: 'OpenAI · GPT-5 Nano' });
  if (googleApiKey) options.push({ value: 'google:gemini-2.5-flash', label: 'Google · Gemini 2.5 Flash' });
  if (options.length === 0) options.push({ value: 'openai:gpt-5-nano', label: 'OpenAI · GPT-5 Nano' });
  if (tModel) {
    tModel.innerHTML = '';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label; tModel.appendChild(opt);
    }
    const desired = `${llmProvider || 'openai'}:${llmModel || 'gpt-5-nano'}`;
    const found = Array.from(tModel.options).some((o) => o.value === desired);
    tModel.value = found ? desired : options[0].value;
  }
  if (appView) appView.style.display = 'none';
  if (tokensStatus) tokensStatus.textContent = '';
  if (tokensView) tokensView.style.display = 'block';
}

// Expose for fallback handlers (module scope isn't global in type="module")
try { window.openTokensView = openTokensView; } catch {}

async function listDatabases(query) {
  const status = document.getElementById('status');
  if (status) status.textContent = '';
  // Show loading state inside the combobox label and disable trigger
  try {
    const { label, trigger } = getDbElements();
    if (label) label.textContent = 'Loading databases...';
    if (trigger) { trigger.disabled = true; trigger.setAttribute('aria-busy', 'true'); }
  } catch {}
  const res = await chrome.runtime.sendMessage({ type: 'LIST_DATABASES', query });
  if (!res?.ok) {
    const err = res?.error || '';
    if (/Missing Notion token/i.test(err)) {
      status.innerHTML = 'Missing Notion token. <a href="#" id="openTokensFromStatus">Configure it</a>.';
      const link = document.getElementById('openTokensFromStatus');
      if (link) link.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof window !== 'undefined' && typeof window.openTokensView === 'function') {
          window.openTokensView();
        } else {
          const ind = document.getElementById('statusIndicator');
          if (ind) ind.click();
        }
      });
    } else {
      status.textContent = err || 'Error listing databases';
    }
    // Re-enable combobox trigger and restore label
    try {
      const { label, trigger } = getDbElements();
      if (label) label.textContent = 'Select database...';
      if (trigger) { trigger.disabled = false; trigger.removeAttribute('aria-busy'); }
    } catch {}
    return [];
  }
  if (status) status.textContent = '';
  // Clear loading state
  try {
    const { trigger } = getDbElements();
    if (trigger) { trigger.disabled = false; trigger.removeAttribute('aria-busy'); }
  } catch {}
  return res.databases;
}

function orderDatabasesByRecentUsage(list, recentSaves, lastDatabaseId) {
  const byIdLatestTs = new Map();
  for (const it of Array.isArray(recentSaves) ? recentSaves : []) {
    if (!it?.databaseId) continue;
    const ts = typeof it.ts === 'number' ? it.ts : 0;
    const prev = byIdLatestTs.get(it.databaseId) || 0;
    if (ts > prev) byIdLatestTs.set(it.databaseId, ts);
  }
  const scored = list.map((d) => {
    const score = byIdLatestTs.get(d.id) || 0;
    const lastBoost = d.id === lastDatabaseId ? 1 : 0; // tie-breaker
    return { d, score, lastBoost };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.lastBoost !== a.lastBoost) return b.lastBoost - a.lastBoost;
    return String(a.d.title || '').localeCompare(String(b.d.title || ''));
  });
  return scored.map((s) => s.d);
}

async function loadDatabases() {
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Loading databases…`);
  const [list, stored] = await Promise.all([
    listDatabases(''),
    getStorage(['recentSaves', 'lastDatabaseId'])
  ]);
  dbList = Array.isArray(list) ? list.slice() : [];
  // Order by recent usage; boost lastDatabaseId
  dbList = orderDatabasesByRecentUsage(dbList, stored.recentSaves || [], stored.lastDatabaseId || '');
  dbFiltered = dbList.slice();
  renderDbList(dbFiltered);
  attachComboboxHandlers();
  // Preselect last used or first
  const pre = stored.lastDatabaseId && dbList.find((d) => d.id === stored.lastDatabaseId) ? stored.lastDatabaseId : (dbList[0]?.id || '');
  setSelectedDb(pre);
  // Restore label if nothing selected
  if (!pre) {
    try { const { label } = getDbElements(); if (label) label.textContent = 'Select database...'; } catch {}
  }
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Databases loaded:`, dbList.length);
}

async function getPageContext(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_CONTEXT' });
    if (!res?.ok) throw new Error(res?.error || 'Could not get page context');
    return res.context;
  } catch (err) {
    const msg = String(err?.message || err || '');
    const receivingEnd = msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection');
    if (!receivingEnd) throw err;
    // Fallback: inject vendor readability and content script in order, then retry
    await chrome.scripting.executeScript({ target: { tabId }, files: [
      'vendor/readability/JSDOMParser.js',
      'vendor/readability/Readability.js',
      'vendor/readability/Readability-readerable.js',
      'contentScript.js'
    ] });
    const res2 = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_CONTEXT' });
    if (!res2?.ok) throw new Error(res2?.error || 'Could not get context after injecting content script');
    return res2.context;
  }
}

async function save() {
  const status = document.getElementById('status');
  status.textContent = '';
  const { llmProvider, llmModel } = await getStorage(['llmProvider', 'llmModel']);
  const databaseId = dbSelectedId;
  if (!databaseId) {
    status.textContent = 'Debes seleccionar una base de datos.';
    return;
  }
  // Record when the save was initiated by the user
  const startedAt = Date.now();
  const tab = await getCurrentTab();
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Save clicked. Getting page context…`);
  let context;
  try {
    context = await getPageContext(tab.id);
  } catch (e) {
    status.textContent = String(e.message || e);
    return;
  }
  (function logContext(ctx) {
    try {
      console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Page context (full):`, structuredClone(ctx));
    } catch {
      console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Page context (full):`, ctx);
    }
    console.log(
      `[NotionMagicClipper][Popup ${new Date().toISOString()}] Context counts:`,
      {
        headings: ctx.headings?.length || 0,
        listItems: ctx.listItems?.length || 0,
        shortSpans: ctx.shortSpans?.length || 0,
        attrTexts: ctx.attrTexts?.length || 0,
        images: ctx.images?.length || 0
      }
    );
  })(context);
  const label = formatModelLabel(llmProvider || 'openai', llmModel || 'gpt-5-nano');
  status.textContent = `Analyzing content with ${label} and saving to Notion...`;
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Got page context. Sending SAVE_TO_NOTION…`);
  const note = document.getElementById('note').value.trim();
  const res = await chrome.runtime.sendMessage({
    type: 'SAVE_TO_NOTION',
    databaseId,
    pageContext: context,
    note,
    startedAt,
    llmProvider,
    llmModel
  });
  if (!res?.ok) {
    console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Save failed:`, res?.error);
    status.innerHTML = `<span class="error">${res?.error || 'Error saving'}</span>`;
    return;
  }
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Save success. Page created.`);
  const pageUrl = res?.page?.url || res?.page?.public_url;
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  status.innerHTML = `<span class="success">Saved successfully in ${seconds} seconds ✅</span>` + (pageUrl ? `<div class="success-link"><a href="${pageUrl}" target="_blank" rel="noopener noreferrer">Open in Notion ↗</a></div>` : '');
  // Remember last used database for next session and ordering boost
  await setStorage({ lastDatabaseId: databaseId });
}

async function main() {
  await precheck();
  await loadDatabases();

  // removed top search/refresh controls
  document.getElementById('save').addEventListener('click', save);
  // full Options link moved to tokens view

  // Inline tokens mini-page
  const indicator = document.getElementById('statusIndicator');
  const tokensView = document.getElementById('tokensView');
  const tokensBack = document.getElementById('tokensBack');
  const tokensSave = document.getElementById('tokensSave');
  const startNotionOAuth = document.getElementById('startNotionOAuth');
  const fetchTokenFromBackend = document.getElementById('fetchTokenFromBackend');
  const tokensOpenOptions = document.getElementById('tokensOpenOptions');
  const tokensStatus = document.getElementById('tokensStatus');
  const tModel = document.getElementById('tModel');
  const appView = document.getElementById('app');
  const dbSettingsView = document.getElementById('dbSettingsView');
  const openDbSettings = document.getElementById('openDbSettings');
  const dbsBack = document.getElementById('dbsBack');
  const dbsSave = document.getElementById('dbsSave');
  const dbsClear = document.getElementById('dbsClear');
  const dbsStatus = document.getElementById('dbsStatus');
  const dbsPrompt = document.getElementById('dbsPrompt');
  const dbsSaveArticle = document.getElementById('dbsSaveArticle');
  const dbsCustomize = document.getElementById('dbsCustomize');
  const dbsCustomizeLabel = document.getElementById('dbsCustomizeLabel');
  const dbsContentPrompt = document.getElementById('dbsContentPrompt');
  const dbSettingsDbName = document.getElementById('dbSettingsDbName');
  if (indicator) {
    indicator.addEventListener('click', async () => { await openTokensView(); });
  }
  if (tokensBack) tokensBack.addEventListener('click', async () => {
    tokensView.style.display = 'none';
    appView.style.display = 'block';
    if (needsReloadDatabases) {
      needsReloadDatabases = false;
      await loadDatabases();
    }
  });
  if (tokensOpenOptions) tokensOpenOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  if (tokensSave) tokensSave.addEventListener('click', async () => {
    tokensStatus.textContent = '';
    tokensStatus.classList.remove('success');
    const notionToken = document.getElementById('tNotionToken').value.trim();
    const openaiKey = document.getElementById('tOpenAI').value.trim();
    const googleApiKey = document.getElementById('tGoogle').value.trim();
    const backendUrl = document.getElementById('tBackendUrl').value.trim();
    const workspaceId = document.getElementById('tWorkspaceId').value.trim();
    const [provider, ...rest] = String(tModel?.value || 'openai:gpt-5-nano').split(':');
    const llmProvider = provider || 'openai';
    const llmModel = rest.join(':') || 'gpt-5-nano';
    await setStorage({ notionToken, openaiKey, googleApiKey, llmProvider, llmModel, backendUrl, workspaceId });
    tokensStatus.textContent = 'Saved ✓';
    tokensStatus.classList.add('success');
    await precheck({ preserveViews: true });
    needsReloadDatabases = true;
  });

  if (startNotionOAuth) startNotionOAuth.addEventListener('click', async () => {
    const { backendUrl } = await getStorage(['backendUrl']);
    const base = backendUrl || 'http://localhost:3000';
    const startUrl = String(base).replace(/\/$/, '') + '/api/notion/start';
    try {
      await chrome.tabs.create({ url: startUrl, active: true });
    } catch {
      window.open(startUrl, '_blank', 'noopener,noreferrer');
    }
  });

  async function handleFetchTokenFromBackend() {
    console.log('[NotionMagicClipper][Popup] Fetch from backend clicked');
    if (tokensStatus) tokensStatus.textContent = 'Fetching token from backend…';
    const { backendUrl } = await getStorage(['backendUrl']);
    let wsId = (document.getElementById('tWorkspaceId')?.value || '').trim();
    const base = (backendUrl || 'http://localhost:3000').replace(/\/$/, '');
    if (!wsId) {
      try {
        const tab = await getCurrentTab();
        const u = new URL(tab?.url || '');
        const fromTab = u.searchParams.get('workspace_id');
        if (fromTab) {
          wsId = fromTab;
          const input = document.getElementById('tWorkspaceId');
          if (input) input.value = wsId;
          await setStorage({ workspaceId: wsId });
        }
      } catch {}
    }
    if (!wsId) { if (tokensStatus) tokensStatus.textContent = 'Enter workspace ID from the redirect URL (tip: open the /connected tab and click this again).'; return; }
    const url = `${base}/api/notion/token?workspace_id=${encodeURIComponent(wsId)}`;
    console.log('[NotionMagicClipper][Popup] Fetch URL:', url);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (!json?.access_token) throw new Error('Token not found for this workspace');
      document.getElementById('tNotionToken').value = json.access_token;
      await setStorage({ notionToken: json.access_token, workspaceId: wsId });
      if (tokensStatus) { tokensStatus.textContent = 'Fetched from backend ✓'; tokensStatus.classList.add('success'); }
      await precheck({ preserveViews: true });
      needsReloadDatabases = true;
    } catch (e) {
      console.error('[NotionMagicClipper][Popup] Fetch from backend failed', e);
      if (tokensStatus) tokensStatus.textContent = `Fetch failed: ${String(e?.message || e)}`;
    }
  }
  if (fetchTokenFromBackend) fetchTokenFromBackend.addEventListener('click', handleFetchTokenFromBackend);
  try { window.fetchFromBackend = handleFetchTokenFromBackend; } catch {}

  // Database settings mini-page
  function updateCustomizeVisibility() {
    if (!dbsSaveArticle || !dbsCustomize || !dbsCustomizeLabel || !dbsContentPrompt) return;
    const checked = dbsSaveArticle.checked;
    dbsCustomizeLabel.style.display = checked ? 'flex' : 'none';
    dbsContentPrompt.style.display = (checked && dbsCustomize.checked) ? 'block' : 'none';
  }
  if (dbsSaveArticle) dbsSaveArticle.addEventListener('change', updateCustomizeVisibility);
  if (dbsCustomize) dbsCustomize.addEventListener('change', updateCustomizeVisibility);
  if (openDbSettings) openDbSettings.addEventListener('click', async () => {
    dbsStatus.textContent = '';
    const currentDb = dbList.find((d) => d.id === dbSelectedId);
    // clickable link to Notion database
    if (currentDb && currentDb.url) {
      dbSettingsDbName.innerHTML = `<a href="${currentDb.url}" target="_blank" rel="noopener noreferrer">${currentDb.iconEmoji ? currentDb.iconEmoji + ' ' : ''}${currentDb.title} ↗</a>`;
    } else {
      dbSettingsDbName.textContent = currentDb ? `${currentDb.iconEmoji ? currentDb.iconEmoji + ' ' : ''}${currentDb.title}` : '';
    }
    const { databaseSettings } = await getStorage(['databaseSettings']);
    const settingsForDb = (databaseSettings || {})[dbSelectedId] || {};
    dbsPrompt.value = settingsForDb.prompt || '';
    dbsSaveArticle.checked = settingsForDb.saveArticle !== false;
    dbsCustomize.checked = settingsForDb.customizeContent === true;
    dbsContentPrompt.value = settingsForDb.contentPrompt || '';
    updateCustomizeVisibility();
    appView.style.display = 'none';
    dbSettingsView.style.display = 'block';
  });
  if (dbsBack) dbsBack.addEventListener('click', () => { dbSettingsView.style.display = 'none'; appView.style.display = 'block'; });
  if (dbsSave) dbsSave.addEventListener('click', async () => {
    const { databaseSettings } = await getStorage(['databaseSettings']);
    const map = (databaseSettings && typeof databaseSettings === 'object') ? databaseSettings : {};
    map[dbSelectedId] = {
      prompt: (dbsPrompt.value || '').trim(),
      saveArticle: !!dbsSaveArticle.checked,
      customizeContent: !!dbsCustomize.checked,
      contentPrompt: (dbsContentPrompt.value || '').trim()
    };
    await setStorage({ databaseSettings: map });
    dbsStatus.textContent = 'Saved ✓';
    dbsStatus.classList.add('success');
  });
  if (dbsClear) dbsClear.addEventListener('click', async () => {
    const { databaseSettings } = await getStorage(['databaseSettings']);
    const map = (databaseSettings && typeof databaseSettings === 'object') ? databaseSettings : {};
    map[dbSelectedId] = { prompt: '', saveArticle: true, customizeContent: false, contentPrompt: '' };
    await setStorage({ databaseSettings: map });
    dbsPrompt.value = '';
    dbsSaveArticle.checked = true;
    dbsCustomize.checked = false;
    dbsContentPrompt.value = '';
    updateCustomizeVisibility();
    dbsStatus.textContent = 'Cleared';
    dbsStatus.classList.remove('success');
  });

  // History view navigation
  const openHistoryBtn = document.getElementById('openHistory');
  const historyView = document.getElementById('historyView');
  const historyList = document.getElementById('historyList');
  const historyStatus = document.getElementById('historyStatus');
  const backBtn = document.getElementById('backToMain');
  const clearBtn = document.getElementById('clearHistory');

  async function loadHistory() {
    historyStatus.textContent = '';
    historyList.innerHTML = '';
    const { recentSaves } = await getStorage(['recentSaves']);
    const items = Array.isArray(recentSaves) ? recentSaves : [];
    if (!items.length) {
      historyStatus.textContent = 'No recent saves yet.';
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const notionLink = document.createElement('a');
      notionLink.href = it.url || '#';
      notionLink.textContent = (it.title ? it.title + ' – ' : '') + (it.databaseTitle ? it.databaseTitle : 'Notion');
      notionLink.target = '_blank';
      notionLink.rel = 'noopener noreferrer';

      const sourceLink = document.createElement('a');
      sourceLink.href = it.sourceUrl || '#';
      sourceLink.textContent = ' 🔗';
      sourceLink.title = 'Open original page';
      sourceLink.style.marginLeft = '6px';
      sourceLink.target = '_blank';
      sourceLink.rel = 'noopener noreferrer';

      const time = document.createElement('span');
      const d = new Date(typeof it.ts === 'number' ? it.ts : Date.now());
      const took = typeof it.durationMs === 'number' ? `  ·  ${Math.round(it.durationMs / 1000)}s` : '';
      time.textContent = '  ·  ' + d.toLocaleString() + took;
      time.style.color = '#666';

      li.appendChild(notionLink);
      if (it.sourceUrl) li.appendChild(sourceLink);
      li.appendChild(time);
      historyList.appendChild(li);
    }
  }

  openHistoryBtn.addEventListener('click', async () => {
    appView.style.display = 'none';
    historyView.style.display = 'block';
    await loadHistory();
  });
  backBtn.addEventListener('click', () => {
    historyView.style.display = 'none';
    appView.style.display = 'block';
  });
  clearBtn.addEventListener('click', async () => {
    await setStorage({ recentSaves: [] });
    await loadHistory();
  });

  // Enter to save (Intro). Shift+Enter inserts a newline in textarea
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const appViewVisible = (() => {
      const appViewEl = document.getElementById('app');
      if (!appViewEl) return false;
      try { return getComputedStyle(appViewEl).display !== 'none'; } catch { return appViewEl.style.display !== 'none'; }
    })();
    if (!appViewVisible) return; // only on main view
    const target = e.target;
    // ignore combobox search
    if (target && target.id === 'dbComboSearch') return;
    // In textarea (#note) Enter submits; Shift+Enter handled above to insert newline
    e.preventDefault();
    save();
  });
}

main().catch((e) => {
  const status = document.getElementById('status');
  status.textContent = String(e?.message || e);
});
