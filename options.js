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

document.getElementById('saveBtn').addEventListener('click', save);
load();
