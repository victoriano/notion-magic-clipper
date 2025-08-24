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
  // update settings link label without destroying icon
  const openBtnLabel = document.getElementById('openDbSettingsLabel');
  if (openBtnLabel) openBtnLabel.textContent = 'Custom save format';
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
  const cfg = await getStorage(['notionToken', 'llmProvider', 'llmModel', 'backendUrl', 'workspaceTokens']);
  const prodBackend = 'https://magic-clipper.vercel.app';
  // Decide default backend only if none is set
  if (!cfg.backendUrl) {
    // Heuristic: prefer localhost during unpacked/dev usage.
    const PROD_EXTENSION_ID = 'gohplijlpngkipjghachaaepbdlfabhk'; // set to your Web Store ID; leave as-is if unknown
    const isProdExtension = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id === PROD_EXTENSION_ID);
    const chosen = isProdExtension ? prodBackend : 'http://localhost:3000';
    await setStorage({ backendUrl: chosen });
    cfg.backendUrl = chosen;
  }
  const provider = cfg.llmProvider || 'openai';
  const model = cfg.llmModel || 'gpt-5-nano';
  const tokensMap = cfg.workspaceTokens && typeof cfg.workspaceTokens === 'object' ? cfg.workspaceTokens : {};
  const hasNotion = Object.keys(tokensMap).length > 0 || !!cfg.notionToken;
  const ok = hasNotion; // account connected is sufficient to turn green
  if (indicator) {
    indicator.classList.toggle('ok', ok);
    indicator.classList.toggle('err', !ok);
    indicator.title = ok ? 'Account connected' : 'Not connected — click to configure';
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
  const backendInput = document.getElementById('tBackendUrl');
  const workspaceInput = document.getElementById('tWorkspaceId');
  const advancedBackendRow = document.getElementById('advancedBackendRow');
  const advancedBackendUrl = document.getElementById('advancedBackendUrl');
  const accountInfo = document.getElementById('accountInfo');
  const logoutBtn = document.getElementById('logoutBtn');
  const connectWorkspaceBtn = document.getElementById('connectWorkspaceBtn');

  const { notionToken, llmProvider, llmModel, backendUrl, workspaceId } = await getStorage(['notionToken', 'llmProvider', 'llmModel', 'backendUrl', 'workspaceId']);
  if (notionInput) notionInput.value = notionToken || '';
  if (backendInput) backendInput.value = (backendUrl || defaultBackendBase);
  if (workspaceInput) workspaceInput.value = workspaceId || '';
  // Hide backend + legacy token UI by default; show only if a dev flag is set
  const showAdvanced = /\bdev=1\b/i.test(location.search) || (await getStorage(['showAdvanced']))?.showAdvanced === true;
  if (advancedBackendRow) advancedBackendRow.style.display = showAdvanced ? 'flex' : 'none';
  if (advancedBackendUrl) advancedBackendUrl.style.display = showAdvanced ? 'block' : 'none';
  const legacyToken = document.getElementById('legacyToken');
  if (legacyToken) legacyToken.style.display = showAdvanced ? 'block' : 'none';

  async function refreshAccountAndWorkspaces() {
    try {
      const base = (backendInput?.value || 'http://localhost:3000').replace(/\/$/, '');
      const me = await fetch(`${base}/api/auth/me`, { credentials: 'include' });
      if (me.ok) {
        const j = await me.json();
        if (accountInfo) accountInfo.textContent = j.email ? `Logged in as ${j.email}` : 'Logged in';
        if (logoutBtn) logoutBtn.style.display = 'inline-flex';
        if (connectWorkspaceBtn) connectWorkspaceBtn.style.display = 'inline-flex';
        if (startNotionLogin) startNotionLogin.style.display = 'none';
        await setStorage({ authLoggedIn: true });
      } else {
        if (accountInfo) accountInfo.textContent = 'Not logged in';
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (connectWorkspaceBtn) connectWorkspaceBtn.style.display = 'none';
        if (startNotionLogin) startNotionLogin.style.display = 'inline-flex';
        await setStorage({ authLoggedIn: false });
      }
      await refreshLinkedWorkspaces();
      await precheck({ preserveViews: true });
    } catch {}
  }
  await refreshAccountAndWorkspaces();

  // Populate linked workspaces list
  async function refreshLinkedWorkspaces() {
    const list = document.getElementById('linkedWorkspaces');
    if (!list) return;
    list.innerHTML = '';
    try {
      const base = (backendInput?.value || 'http://localhost:3000').replace(/\/$/, '');
      const res = await fetch(`${base}/api/notion/workspaces`, { credentials: 'include' });
      if (!res.ok) { list.innerHTML = '<li style="color:#999">No workspaces (not logged in)</li>'; return; }
      const data = await res.json();
      const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
      if (!workspaces.length) { list.innerHTML = '<li style="color:#999">No workspaces linked</li>'; return; }
      for (const w of workspaces) {
        const li = document.createElement('li');
        li.style.display = 'flex'; li.style.alignItems = 'center'; li.style.gap = '14px'; li.style.marginBottom = '8px';
        const span = document.createElement('span');
        const acct = w.account_email || w.account_name ? ` — ${w.account_name || w.account_email}` : '';
        span.textContent = `${w.workspace_name || 'Untitled'}${acct}`;
        if (w.account_email) span.title = w.account_email;
        const btn = document.createElement('button');
        btn.className = 'btn btn-outline'; btn.textContent = 'Disconnect';
        btn.addEventListener('click', async () => {
          const ok = confirm('Disconnect this workspace?');
          if (!ok) return;
          const r = await fetch(`${base}/api/notion/connection?workspace_id=${encodeURIComponent(w.workspace_id)}`, { method: 'DELETE', credentials: 'include' });
          if (r.ok) { await setStorage({ workspaceTokens: {} }); await refreshLinkedWorkspaces(); await precheck({ preserveViews: true }); }
        });
        li.appendChild(span); li.appendChild(btn);
        list.appendChild(li);
      }
    } catch { list.innerHTML = '<li style="color:#999">Failed to load</li>'; }
  }
  await refreshLinkedWorkspaces();

  // Populate model selector based on available keys
  const options = [
    { value: 'openai:gpt-5-nano', label: 'OpenAI · GPT-5 Nano' },
    { value: 'google:gemini-2.5-flash', label: 'Google · Gemini 2.5 Flash' },
  ];
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
  // GPT-5 options show/hide
  const gpt5Options = document.getElementById('gpt5Options');
  const tGpt5Reasoning = document.getElementById('tGpt5Reasoning');
  const tGpt5Verbosity = document.getElementById('tGpt5Verbosity');
  const showGpt5 = () => {
    try {
      const val = String(tModel?.value || '').toLowerCase();
      const isGpt5 = val.startsWith('openai:gpt-5');
      if (gpt5Options) gpt5Options.style.display = isGpt5 ? 'block' : 'none';
    } catch {}
  };
  showGpt5();
  if (tModel) tModel.addEventListener('change', showGpt5);
  // Load saved GPT-5 prefs
  try {
    const { openai_reasoning_effort, openai_verbosity } = await getStorage(['openai_reasoning_effort', 'openai_verbosity']);
    if (tGpt5Reasoning && typeof openai_reasoning_effort === 'string') tGpt5Reasoning.value = openai_reasoning_effort;
    if (tGpt5Verbosity && typeof openai_verbosity === 'string') tGpt5Verbosity.value = openai_verbosity;
  } catch {}
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
  const stored = await getStorage(['recentSaves', 'lastDatabaseId', 'backendUrl', 'workspaceTokens']);
  const backendBase = (stored.backendUrl || defaultBackendBase).replace(/\/$/, '');
  let tokensMap = stored.workspaceTokens && typeof stored.workspaceTokens === 'object' ? stored.workspaceTokens : {};
  if (!Object.keys(tokensMap).length) {
    try {
      const res = await fetch(`${backendBase}/api/notion/workspaces`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data.workspaces) ? data.workspaces : [];
        const entries = await Promise.all(list.map(async (w) => {
          try {
            const r = await fetch(`${backendBase}/api/notion/token?workspace_id=${encodeURIComponent(w.workspace_id)}`, { credentials: 'include' });
            if (!r.ok) throw new Error('token');
            const j = await r.json();
            return [w.workspace_id, j.access_token];
          } catch { return null; }
        }));
        tokensMap = entries.filter(Boolean).reduce((acc, [id, tok]) => { acc[id] = tok; return acc; }, {});
        if (Object.keys(tokensMap).length) await setStorage({ workspaceTokens: tokensMap });
      }
    } catch {}
  }

  let merged = [];
  const tokenValues = Object.values(tokensMap);
  if (!tokenValues.length) {
    merged = await listDatabases('');
  } else {
    const perWorkspace = await Promise.all(tokenValues.map(async (tok) => {
      try {
        const body = { query: '', filter: { property: 'object', value: 'database' }, sort: { direction: 'ascending', timestamp: 'last_edited_time' } };
        const resp = await fetch('https://api.notion.com/v1/search', { method: 'POST', headers: { 'Authorization': `Bearer ${tok}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!resp.ok) throw new Error('notion');
        const data = await resp.json();
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
    for (const list of perWorkspace) { for (const db of list) { if (!byId.has(db.id)) byId.set(db.id, db); } }
    merged = Array.from(byId.values());
  }
  dbList = Array.isArray(merged) ? merged.slice() : [];
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
  // Reveal dependent UI only after databases are ready
  try {
    const noteRow = document.getElementById('noteRow');
    const customSaveRow = document.getElementById('customSaveRow');
    const saveRow = document.getElementById('saveRow');
    if (noteRow) noteRow.style.display = 'none'; // start collapsed by default
    if (customSaveRow) customSaveRow.style.display = 'block';
    if (saveRow) saveRow.style.display = 'flex';
  } catch {}
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
  const startNotionOAuth = null; // removed explicit button; login flow chains to connect
  const startNotionLogin = document.getElementById('startNotionLogin');
  const fetchTokenFromBackend = document.getElementById('fetchTokenFromBackend');
  const tokensStatus = document.getElementById('tokensStatus');
  const tModel = document.getElementById('tModel');
  const appView = document.getElementById('app');
  const tokensClear = document.getElementById('tokensClear');
  const dbSettingsView = document.getElementById('dbSettingsView');
  // Track the last visible view to return from history
  let lastView = 'app';
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
  if (tokensClear) tokensClear.addEventListener('click', async () => {
    try {
      await setStorage({
        notionToken: '',
        workspaceTokens: {},
        workspaceId: '',
        llmProvider: 'openai',
        llmModel: 'gpt-5-nano',
        databaseSettings: {},
        databasePrompts: {},
        recentSaves: [],
        lastDatabaseId: ''
      });
      tokensStatus.textContent = 'Local data cleared ✓';
      tokensStatus.classList.add('success');
      await precheck({ preserveViews: true });
      needsReloadDatabases = true;
    } catch (e) {
      tokensStatus.textContent = 'Failed to clear';
    }
  });
  if (tokensSave) tokensSave.addEventListener('click', async () => {
    tokensStatus.textContent = '';
    tokensStatus.classList.remove('success');
    const notionToken = document.getElementById('tNotionToken')?.value?.trim() || '';
    const backendUrl = document.getElementById('tBackendUrl').value.trim();
    const workspaceId = document.getElementById('tWorkspaceId').value.trim();
    const [provider, ...rest] = String(tModel?.value || 'openai:gpt-5-nano').split(':');
    const llmProvider = provider || 'openai';
    const llmModel = rest.join(':') || 'gpt-5-nano';
    const gpt5Reasoning = document.getElementById('tGpt5Reasoning')?.value || 'low';
    const gpt5Verbosity = document.getElementById('tGpt5Verbosity')?.value || 'low';
    await setStorage({
      notionToken,
      llmProvider,
      llmModel,
      backendUrl,
      workspaceId,
      openai_reasoning_effort: gpt5Reasoning,
      openai_verbosity: gpt5Verbosity,
    });
    tokensStatus.textContent = 'Saved ✓';
    tokensStatus.classList.add('success');
    await precheck({ preserveViews: true });
    needsReloadDatabases = true;
  });

  async function ensureLoggedIn(base) {
    try {
      const res = await fetch(`${base}/api/notion/workspaces`, { credentials: 'include' });
      return res.status !== 401;
    } catch { return false; }
  }

  // no-op: connect step is chained after login callback

  if (startNotionLogin) startNotionLogin.addEventListener('click', async () => {
    const { backendUrl } = await getStorage(['backendUrl']);
    const base = backendUrl || 'https://magic-clipper.vercel.app';
    const url = String(base).replace(/\/$/, '') + '/api/auth/notion/start';
    try {
      // Create the auth tab
      const tab = await chrome.tabs.create({ url, active: true });
      // Poll the session endpoint if Supabase redirects with access_token in URL.
      const poll = setInterval(async () => {
        try {
          const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          const current = tabs && tabs[0];
          if (!current || !current.url) return;
          if (current.url.includes('/auth/callback') && current.url.includes('access_token=')) {
            try {
              const u = new URL(current.url);
              const access_token = u.searchParams.get('access_token');
              if (access_token) {
                await fetch(`${base.replace(/\/$/, '')}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token }), credentials: 'include' });
                await refreshAccountAndWorkspaces();
              }
            } catch {}
          }
        } catch {}
      }, 1000);
      setTimeout(() => clearInterval(poll), 20000);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  });

  if (connectWorkspaceBtn) connectWorkspaceBtn.addEventListener('click', async () => {
    console.log('[NotionMagicClipper][Popup] Connect another workspace clicked');
    const { backendUrl } = await getStorage(['backendUrl']);
    const base = (backendUrl || 'https://magic-clipper.vercel.app').replace(/\/$/, '');
    const startUrl = base + '/api/notion/start';
    try { await chrome.tabs.create({ url: startUrl, active: true }); }
    catch { window.open(startUrl, '_blank', 'noopener,noreferrer'); }
  });

  // Toggle extra context
  const toggleNoteBtn = document.getElementById('toggleNoteBtn');
  if (toggleNoteBtn) toggleNoteBtn.addEventListener('click', () => {
    const noteRow = document.getElementById('noteRow');
    if (!noteRow) return;
    const shown = getComputedStyle(noteRow).display !== 'none';
    noteRow.style.display = shown ? 'none' : 'block';
  });

  if (logoutBtn) logoutBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      console.log('[NotionMagicClipper][Popup] Logout clicked');
      const { backendUrl } = await getStorage(['backendUrl']);
      const base = (backendUrl || 'https://magic-clipper.vercel.app').replace(/\/$/, '');
      const resp = await fetch(`${base}/api/auth/logout`, { method: 'POST', credentials: 'include' });
      console.log('[NotionMagicClipper][Popup] Logout response', resp.status);
      await setStorage({ workspaceTokens: {}, notionToken: '' });
      if (accountInfo) accountInfo.textContent = 'Not logged in';
      logoutBtn.style.display = 'none';
      tokensStatus.textContent = 'Logged out';
      const list = document.getElementById('linkedWorkspaces');
      if (list) list.innerHTML = '<li style="color:#999">No workspaces (not logged in)</li>';
      if (connectWorkspaceBtn) connectWorkspaceBtn.style.display = 'none';
      if (startNotionLogin) startNotionLogin.style.display = 'inline-flex';
      await refreshAccountAndWorkspaces();
    } catch {}
  });

  async function handleFetchTokenFromBackend() {
    console.log('[NotionMagicClipper][Popup] Fetch from backend clicked');
    if (tokensStatus) tokensStatus.textContent = 'Fetching token from backend…';
    const { backendUrl } = await getStorage(['backendUrl']);
    let wsId = (document.getElementById('tWorkspaceId')?.value || '').trim();
    const base = (backendUrl || 'https://magic-clipper.vercel.app').replace(/\/$/, '');
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
  // Untitled databases view
  const openUntitledBtn = document.getElementById('openUntitled');
  const untitledView = document.getElementById('untitledView');
  const untitledList = document.getElementById('untitledList');
  const untitledStatus = document.getElementById('untitledStatus');
  const untitledBack = document.getElementById('untitledBack');

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
    // Determine which view is currently visible
    try {
      const appVisible = getComputedStyle(appView).display !== 'none';
      const tokensVisible = getComputedStyle(tokensView).display !== 'none';
      const dbSettingsVisible = getComputedStyle(dbSettingsView).display !== 'none';
      if (tokensVisible) lastView = 'tokens';
      else if (dbSettingsVisible) lastView = 'dbSettings';
      else lastView = 'app';
    } catch {
      if (tokensView && tokensView.style.display !== 'none') lastView = 'tokens';
      else if (dbSettingsView && dbSettingsView.style.display !== 'none') lastView = 'dbSettings';
      else lastView = 'app';
    }

    // Hide all other views and show history
    if (appView) appView.style.display = 'none';
    if (tokensView) tokensView.style.display = 'none';
    if (dbSettingsView) dbSettingsView.style.display = 'none';
    historyView.style.display = 'block';
    await loadHistory();
  });
  backBtn.addEventListener('click', () => {
    historyView.style.display = 'none';
    if (lastView === 'tokens') tokensView.style.display = 'block';
    else if (lastView === 'dbSettings') dbSettingsView.style.display = 'block';
    else appView.style.display = 'block';
  });

  async function loadUntitled() {
    untitledStatus.textContent = 'Searching untitled databases...';
    untitledList.innerHTML = '';
    try {
      let items = [];
      try {
        const res = await chrome.runtime.sendMessage({ type: 'LIST_UNTITLED_DATABASES' });
        if (!res?.ok) throw new Error(res?.error || 'Search error (background)');
        items = res.databases || [];
      } catch (err) {
        // Fallback: query Notion directly via Options helper if background fails
        items = [];
      }
      untitledStatus.textContent = `Found ${items.length} untitled databases`;
      for (const db of items) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = db.url || `https://www.notion.so/${String(db.id || '').replace(/-/g, '')}`;
        a.textContent = db.title ? `${db.title}` : `${db.id}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.appendChild(a);
        untitledList.appendChild(li);
      }
    } catch (e) {
      untitledStatus.textContent = String(e?.message || e);
    }
  }

  if (openUntitledBtn) openUntitledBtn.addEventListener('click', async () => {
    try {
      const appVisible = getComputedStyle(appView).display !== 'none';
      const tokensVisible = getComputedStyle(tokensView).display !== 'none';
      const dbSettingsVisible = getComputedStyle(dbSettingsView).display !== 'none';
      if (tokensVisible) lastView = 'tokens';
      else if (dbSettingsVisible) lastView = 'dbSettings';
      else lastView = 'app';
    } catch { lastView = 'app'; }
    if (appView) appView.style.display = 'none';
    if (tokensView) tokensView.style.display = 'none';
    if (dbSettingsView) dbSettingsView.style.display = 'none';
    untitledView.style.display = 'block';
    await loadUntitled();
  });
  if (untitledBack) untitledBack.addEventListener('click', () => {
    untitledView.style.display = 'none';
    if (lastView === 'tokens') tokensView.style.display = 'block';
    else if (lastView === 'dbSettings') dbSettingsView.style.display = 'block';
    else appView.style.display = 'block';
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
