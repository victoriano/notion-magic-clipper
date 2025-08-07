// background.js (service worker)
// Handles Notion API and OpenAI API calls, and coordinates saving pages

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28'; // latest per Notion docs
const OPENAI_API_BASE = 'https://api.openai.com/v1';
const GPT5_NANO_MODEL = 'gpt-5-nano';

// Helpers to get/set tokens in storage
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        'notionToken',
        'openaiKey',
        'notionSearchQuery',
        'openai_reasoning_effort',
        'openai_verbosity'
      ],
      (res) => resolve(res)
    );
  });
}

// Notion API helpers
async function notionFetch(path, options = {}) {
  const { notionToken } = await getConfig();
  if (!notionToken) throw new Error('Falta el token de Notion. Configúralo en Opciones.');

  const headers = {
    'Authorization': `Bearer ${notionToken}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const resp = await fetch(`${NOTION_API_BASE}${path}`, {
    ...options,
    headers
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Notion API ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function listDatabases(query = '') {
  // Uses /v1/search with filter for databases
  const body = {
    query,
    filter: { property: 'object', value: 'database' },
    sort: { direction: 'ascending', timestamp: 'last_edited_time' }
  };
  const data = await notionFetch('/search', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  // Map to simple structure
  const results = (data.results || []).map((item) => {
    const title = (item.title || [])
      .map((t) => t.plain_text)
      .join('') || '(Sin título)';
    return { id: item.id, title };
  });
  return results;
}

async function getDatabase(databaseId) {
  return notionFetch(`/databases/${databaseId}`);
}

async function createPageInDatabase(databaseId, properties, pageContentBlocks = []) {
  const body = {
    parent: { database_id: databaseId },
    properties,
    ...(pageContentBlocks.length ? { children: pageContentBlocks } : {})
  };
  return notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

// OpenAI API helper
async function openaiChat(messages, { model = GPT5_NANO_MODEL, temperature = 0.2, reasoning_effort = 'low', verbosity = 'low' } = {}) {
  const { openaiKey } = await getConfig();
  if (!openaiKey) throw new Error('Falta la API key de OpenAI. Configúrala en Opciones.');

  const headers = {
    'Authorization': `Bearer ${openaiKey}`,
    'Content-Type': 'application/json'
  };
  // Use Chat Completions for widest compatibility
  const resp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature,
      // New GPT-5 parameters if supported on chat endpoint
      reasoning_effort,
      verbosity
    })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OpenAI API ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Respuesta vacía del modelo.');
  return content;
}

// Build a prompt to map page context to Notion properties
function buildPromptForProperties(schema, pageContext) {
  const { url, title, meta, selectionText, textSample } = pageContext;
  const schemaStr = JSON.stringify(schema, null, 2);
  const contextStr = JSON.stringify({ url, title, meta, selectionText, textSample }, null, 2);
  return [
    {
      role: 'system',
      content:
        'Eres un asistente que genera valores de propiedades de Notion dados un esquema de base de datos y el contexto de una página web. Devuelve únicamente JSON válido con la clave "properties" exactamente en el formato de la API de Notion para crear páginas. No incluyas comentarios, texto adicional ni explicaciones.'
    },
    {
      role: 'user',
      content:
        `Esquema de la base de datos (propiedades):\n${schemaStr}\n\nContexto de la página:\n${contextStr}\n\nInstrucciones:\n- Rellena tantas propiedades como sea posible según el contexto.\n- Debe haber exactamente una propiedad de tipo "title" y debes establecer su valor con el mejor título posible.\n- Para propiedades de tipo select/multi_select, usa exclusivamente opciones existentes (coincidencia por nombre). Si no hay coincidencias claras, omite la propiedad.\n- Para dates, si no hay fecha específica en el contenido, puedes usar la fecha/hora actual.\n- Para url, establece la URL de la página si existe una propiedad apropiada.\n- Omite propiedades que no puedas determinar (no inventes valores).\n- NO incluyas propiedades de solo lectura (rollup, created_time, etc.).\n- Devuelve solo un objeto JSON con la forma { "properties": { ... } }.`
    }
  ];
}

function extractSchemaForPrompt(database) {
  // Reduce database object to just properties relevant for the LLM: name, type, options
  const props = database.properties || {};
  const simplified = {};
  Object.entries(props).forEach(([name, def]) => {
    const base = { type: def.type };
    if (def.type === 'select' || def.type === 'multi_select') {
      base.options = def[def.type]?.options?.map((o) => o.name) || [];
    }
    if (def.type === 'title' || def.type === 'rich_text' || def.type === 'url' || def.type === 'email' || def.type === 'phone_number') {
      // nothing else to add
    }
    if (def.type === 'number') {
      base.format = def.number?.format || 'number';
    }
    if (def.type === 'date') {
      base.allow_time = true;
    }
    // people, files, relation, rollup etc. can be omitted or noted
    simplified[name] = base;
  });
  return simplified;
}

function buildBookmarkBlocks(url, note) {
  const blocks = [];
  if (note) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: note } }]
      }
    });
  }
  if (url) {
    blocks.push({
      object: 'block',
      type: 'bookmark',
      bookmark: { url }
    });
  }
  return blocks;
}

// Messaging handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'LIST_DATABASES') {
      try {
        const { notionSearchQuery } = await getConfig();
        const bases = await listDatabases(message.query ?? notionSearchQuery ?? '');
        sendResponse({ ok: true, databases: bases });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (message?.type === 'SAVE_TO_NOTION') {
      try {
        const { databaseId, pageContext, note } = message;
        if (!databaseId) throw new Error('databaseId faltante');
        if (!pageContext) throw new Error('pageContext faltante');

        const db = await getDatabase(databaseId);
        const schemaForLLM = extractSchemaForPrompt(db);
        const prompt = buildPromptForProperties(schemaForLLM, pageContext);

        const { openai_reasoning_effort, openai_verbosity } = await getConfig();
        const content = await openaiChat(prompt, {
          model: GPT5_NANO_MODEL,
          reasoning_effort: openai_reasoning_effort || 'low',
          verbosity: openai_verbosity || 'low',
          temperature: 0.1
        });

        // Parse JSON block from content
        let parsed;
        try {
          // Try to find a JSON object in the string
          const match = content.match(/\{[\s\S]*\}/);
          parsed = match ? JSON.parse(match[0]) : JSON.parse(content);
        } catch (err) {
          throw new Error('El modelo no devolvió JSON válido para propiedades.');
        }

        if (!parsed || typeof parsed !== 'object' || !parsed.properties) {
          throw new Error('Falta la clave "properties" en la salida del modelo.');
        }

        // Ensure title property is set; if not, attempt fallback to first title
        const titlePropName = Object.entries(db.properties || {}).find(([, def]) => def.type === 'title')?.[0];
        if (titlePropName && !parsed.properties[titlePropName]) {
          parsed.properties[titlePropName] = {
            title: [ { type: 'text', text: { content: pageContext.title || pageContext.meta?.['og:title'] || pageContext.url || 'Sin título' } } ]
          };
        }
        // Ensure a URL property is set if schema has one and model omitted it
        const urlPropName = Object.entries(db.properties || {}).find(([, def]) => def.type === 'url')?.[0];
        if (urlPropName && !parsed.properties[urlPropName] && pageContext.url) {
          parsed.properties[urlPropName] = { url: pageContext.url };
        }

        const blocks = buildBookmarkBlocks(pageContext.url, note);
        const created = await createPageInDatabase(databaseId, parsed.properties, blocks);
        sendResponse({ ok: true, page: created });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }
  })();
  // Indicate async response
  return true;
});
