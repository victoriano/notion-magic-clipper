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
    const res = await chrome.runtime.sendMessage({ type: 'LIST_UNTITLED_DATABASES' });
    if (!res?.ok) throw new Error(res?.error || 'Error al buscar bases sin título');
    const items = res.databases || [];
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

document.getElementById('saveBtn').addEventListener('click', save);
document.getElementById('listUntitledBtn').addEventListener('click', listUntitled);
load();
