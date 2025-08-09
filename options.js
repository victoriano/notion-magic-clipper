// options.js

function get(keys) { return new Promise((resolve) => chrome.storage.local.get(keys, resolve)); }
function set(obj) { return new Promise((resolve) => chrome.storage.local.set(obj, resolve)); }

async function load() {
  const { notionToken, openaiKey, openai_reasoning_effort, openai_verbosity } = await get([
    'notionToken', 'openaiKey', 'openai_reasoning_effort', 'openai_verbosity'
  ]);
  if (notionToken) document.getElementById('notionToken').value = notionToken;
  if (openaiKey) document.getElementById('openaiKey').value = openaiKey;
  if (openai_reasoning_effort) document.getElementById('reasoning').value = openai_reasoning_effort;
  if (openai_verbosity) document.getElementById('verbosity').value = openai_verbosity;
}

async function save() {
  const status = document.getElementById('status');
  status.textContent = '';
  const notionToken = document.getElementById('notionToken').value.trim();
  const openaiKey = document.getElementById('openaiKey').value.trim();
  const openai_reasoning_effort = document.getElementById('reasoning').value;
  const openai_verbosity = document.getElementById('verbosity').value;

  await set({ notionToken, openaiKey, openai_reasoning_effort, openai_verbosity });
  status.innerHTML = '<span class="success">Guardado ✓</span>';
}

async function listUntitled() {
  const status = document.getElementById('untitledStatus');
  const listEl = document.getElementById('untitledList');
  status.textContent = 'Buscando bases de datos sin título...';
  listEl.innerHTML = '';
  try {
    let items;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'LIST_UNTITLED_DATABASES' });
      if (!res?.ok) throw new Error(res?.error || 'Error al buscar (background)');
      items = res.databases || [];
    } catch (err) {
      // Fallback: query Notion directly from the Options page (avoids background lifetime issues)
      items = await searchUntitledDatabasesDirect();
    }
    status.textContent = `Encontradas ${items.length} bases sin título`;
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
  status.textContent = 'Buscando todas las bases de datos...';
  listEl.innerHTML = '';
  try {
    let items;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'LIST_ALL_DATABASES', query });
      if (!res?.ok) throw new Error(res?.error || 'Error al listar (background)');
      items = res.databases || [];
    } catch (err) {
      // Fallback: fetch directly from Options page
      items = await searchAllDatabasesDirect(query);
    }
    // Sync prompts with current accessible databases (drop missing, add new as empty)
    const prompts = await syncPromptsWithDatabases(items);

    status.textContent = `Encontradas ${items.length} bases`;
    renderAllDatabasesList(listEl, items, prompts);
  } catch (e) {
    status.textContent = String(e?.message || e);
  }
}

// ---- Direct Notion fetch fallbacks (Options page) ----
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

async function notionFetchFromOptions(path, options = {}) {
  const { notionToken } = await get(['notionToken']);
  if (!notionToken) throw new Error('Falta el token de Notion. Configúralo y guarda los cambios.');
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
      const title = (item?.title || []).map((t) => t?.plain_text || '').join('') || '(Sin título)';
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
  return all.filter((d) => !d.title || d.title.trim().length === 0 || d.title === '(Sin título)');
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

function renderAllDatabasesList(container, items, prompts) {
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
    const hasPrompt = (prompts[db.id] || '').trim().length > 0;
    const badge = document.createElement('span');
    badge.textContent = hasPrompt ? ' · prompt guardado' : '';
    badge.style.color = hasPrompt ? '#0b7a0b' : '#666';
    badge.style.fontSize = '12px';

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Editar prompt';
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
    ta.placeholder = 'Instrucciones personalizadas para esta base (cómo mapear, qué propiedades priorizar, etc.)';
    ta.value = prompts[db.id] || '';
    const actions = document.createElement('div');
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Guardar';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Borrar';
    clearBtn.style.marginLeft = '8px';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Cerrar';
    closeBtn.style.marginLeft = '8px';
    const mini = document.createElement('span');
    mini.style.marginLeft = '8px';

    actions.appendChild(saveBtn);
    actions.appendChild(clearBtn);
    actions.appendChild(closeBtn);
    actions.appendChild(mini);
    panel.appendChild(ta);
    panel.appendChild(actions);
    li.appendChild(panel);

    editBtn.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    saveBtn.addEventListener('click', async () => {
      const text = ta.value.trim();
      const current = await getDatabasePrompts();
      current[db.id] = text;
      await setDatabasePrompts(current);
      mini.textContent = 'Guardado ✓';
      mini.style.color = '#0b7a0b';
      badge.textContent = text ? ' · prompt guardado' : '';
      badge.style.color = text ? '#0b7a0b' : '#666';
    });
    clearBtn.addEventListener('click', async () => {
      ta.value = '';
      const current = await getDatabasePrompts();
      current[db.id] = '';
      await setDatabasePrompts(current);
      mini.textContent = 'Borrado';
      mini.style.color = '#666';
      badge.textContent = '';
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
