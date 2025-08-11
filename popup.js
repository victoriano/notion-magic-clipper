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

async function precheck() {
  const pre = document.getElementById('precheck');
  const app = document.getElementById('app');
  const cfg = await getStorage(['notionToken', 'openaiKey']);
  if (!cfg.notionToken || !cfg.openaiKey) {
    pre.innerHTML = `<div class="error">Tokens missing. Set your <b>Notion Token</b> and <b>OpenAI API key</b> in Options.</div>`;
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

async function loadDatabases() {
  const search = document.getElementById('search');
  const sel = document.getElementById('databases');
  sel.innerHTML = '';
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Loading databases…`);
  const list = await listDatabases(search.value.trim());
  if (!list.length) {
    sel.innerHTML = '<option>(No databases are shared with your integration)</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  list.forEach((db) => {
    const opt = document.createElement('option');
    opt.value = db.id;
    const emoji = db.iconEmoji || '';
    opt.textContent = (emoji ? `${emoji} ` : '') + db.title;
    sel.appendChild(opt);
  });
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Databases loaded:`, list.length);
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
    // Fallback: inject content script and retry
    await chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript.js'] });
    const res2 = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_CONTEXT' });
    if (!res2?.ok) throw new Error(res2?.error || 'Could not get context after injecting content script');
    return res2.context;
  }
}

async function save() {
  const status = document.getElementById('status');
  status.textContent = '';
  const dbSel = document.getElementById('databases');
  const databaseId = dbSel.value;
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
  // Pretty/safe log of the full page context for inspection
  (function logContext(ctx) {
    function sanitizeForLog(value, depth = 0) {
      const MAX_DEPTH = 3;
      const MAX_STRING = 300;
      const MAX_ARRAY = 10;
      if (value == null) return value;
      if (typeof value === 'string') {
        return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
      }
      if (typeof value !== 'object') return value;
      if (depth >= MAX_DEPTH) return '…';
      if (Array.isArray(value)) {
        return value
          .slice(0, MAX_ARRAY)
          .map((v) => sanitizeForLog(v, depth + 1))
          .concat(value.length > MAX_ARRAY ? ['…'] : []);
      }
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = sanitizeForLog(v, depth + 1);
      }
      return out;
    }
    console.log(
      `[NotionMagicClipper][Popup ${new Date().toISOString()}] Page context:`,
      sanitizeForLog(ctx)
    );
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
  status.textContent = 'Analyzing content with GPT-5 Nano and saving to Notion...';
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Got page context. Sending SAVE_TO_NOTION…`);
  const note = document.getElementById('note').value.trim();
  const res = await chrome.runtime.sendMessage({
    type: 'SAVE_TO_NOTION',
    databaseId,
    pageContext: context,
    note,
    startedAt
  });
  if (!res?.ok) {
    console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Save failed:`, res?.error);
    status.innerHTML = `<span class="error">${res?.error || 'Error saving'}</span>`;
    return;
  }
  console.log(`[NotionMagicClipper][Popup ${new Date().toISOString()}] Save success. Page created.`);
  const pageUrl = res?.page?.url || res?.page?.public_url;
  status.innerHTML = `<span class="success">Saved successfully ✅</span>` + (pageUrl ? `<div class="success-link"><a href="${pageUrl}" target="_blank" rel="noopener noreferrer">Open in Notion ↗</a></div>` : '');
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
