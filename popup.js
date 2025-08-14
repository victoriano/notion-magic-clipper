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

async function precheck() {
  const pre = document.getElementById('precheck');
  const app = document.getElementById('app');
  const cfg = await getStorage(['notionToken', 'openaiKey', 'googleApiKey', 'llmProvider', 'llmModel']);
  const provider = cfg.llmProvider || 'openai';
  const model = cfg.llmModel || 'gpt-5-nano';
  const hasNotion = !!cfg.notionToken;
  const hasOpenAI = !!cfg.openaiKey;
  const hasGoogle = !!cfg.googleApiKey;
  let hasLLM = false;
  if (provider === 'openai') hasLLM = hasOpenAI;
  else if (provider === 'google') hasLLM = hasGoogle;
  else hasLLM = hasOpenAI || hasGoogle; // fallback if unknown provider
  if (!hasNotion || !hasLLM) {
    pre.innerHTML = `<div class="error">${!hasNotion ? 'Notion token missing. ' : ''}${!hasLLM ? 'LLM key missing for selected provider.' : ''} Open <b>Options</b> to configure.</div>`;
  } else {
    pre.innerHTML = `<div class="success">Tokens configured. Ready to save.</div>`;
  }
  app.style.display = 'block';
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] precheck complete`);
}

async function listDatabases(query) {
  const status = document.getElementById('status');
  status.textContent = 'Loading databases...';
  const res = await chrome.runtime.sendMessage({ type: 'LIST_DATABASES', query });
  if (!res?.ok) {
    status.textContent = res?.error || 'Error listing databases';
    return [];
  }
  status.textContent = '';
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
  const search = document.getElementById('search');
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Loading databases…`);
  const [list, stored] = await Promise.all([
    listDatabases(search.value.trim()),
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

  document.getElementById('refresh').addEventListener('click', loadDatabases);
  document.getElementById('search').addEventListener('change', async (e) => {
    await setStorage({ notionSearchQuery: e.target.value });
    await loadDatabases();
  });
  document.getElementById('save').addEventListener('click', save);
  document.getElementById('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // History view navigation
  const openHistoryBtn = document.getElementById('openHistory');
  const historyView = document.getElementById('historyView');
  const appView = document.getElementById('app');
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
}

main().catch((e) => {
  const status = document.getElementById('status');
  status.textContent = String(e?.message || e);
});
