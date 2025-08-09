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
    pre.innerHTML = `<div class="error">Faltan tokens. Configura tu <b>Token de Notion</b> y tu <b>OpenAI API key</b> en Opciones.</div>`;
  } else {
    pre.innerHTML = `<div class="success">Tokens configurados. Listo para guardar.</div>`;
  }
  app.style.display = 'block';
}

async function listDatabases(query) {
  const status = document.getElementById('status');
  status.textContent = 'Cargando bases de datos...';
  const res = await chrome.runtime.sendMessage({ type: 'LIST_DATABASES', query });
  if (!res?.ok) {
    status.textContent = res?.error || 'Error al listar bases de datos';
    return [];
  }
  status.textContent = '';
  return res.databases;
}

async function loadDatabases() {
  const search = document.getElementById('search');
  const sel = document.getElementById('databases');
  sel.innerHTML = '';
  const list = await listDatabases(search.value.trim());
  if (!list.length) {
    sel.innerHTML = '<option>(No hay bases de datos compartidas con tu integración)</option>';
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
}

async function getPageContext(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_CONTEXT' });
    if (!res?.ok) throw new Error(res?.error || 'No se pudo obtener el contexto de la página');
    return res.context;
  } catch (err) {
    const msg = String(err?.message || err || '');
    const receivingEnd = msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection');
    if (!receivingEnd) throw err;
    // Fallback: inject content script and retry
    await chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript.js'] });
    const res2 = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_CONTEXT' });
    if (!res2?.ok) throw new Error(res2?.error || 'No se pudo obtener el contexto tras inyectar el content script');
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
  const tab = await getCurrentTab();
  let context;
  try {
    context = await getPageContext(tab.id);
  } catch (e) {
    status.textContent = String(e.message || e);
    return;
  }
  status.textContent = 'Analizando contenido con GPT-5 Nano y guardando en Notion...';
  const note = document.getElementById('note').value.trim();
  const res = await chrome.runtime.sendMessage({
    type: 'SAVE_TO_NOTION',
    databaseId,
    pageContext: context,
    note
  });
  if (!res?.ok) {
    status.innerHTML = `<span class="error">${res?.error || 'Error al guardar'}</span>`;
    return;
  }
  const pageUrl = res?.page?.url || res?.page?.public_url;
  status.innerHTML = `<span class="success">Guardado correctamente ✅</span>` + (pageUrl ? `<div class="success-link"><a href="${pageUrl}" target="_blank" rel="noopener noreferrer">Abrir en Notion ↗</a></div>` : '');
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
}

main().catch((e) => {
  const status = document.getElementById('status');
  status.textContent = String(e?.message || e);
});
