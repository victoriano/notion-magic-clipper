// utils/listAllDatabases.js
// Utility to list all databases accessible with the provided token

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/**
 * Fetch all databases accessible using the given token.
 * @param {string} notionToken
 * @param {{ pageSize?: number, query?: string }} [options]
 * @returns {Promise<Array<{ id: string, title: string, url: string }>>}
 */
export async function searchAllDatabases(notionToken, options = {}) {
  if (!notionToken || typeof notionToken !== 'string') {
    throw new Error('Notion token is required');
  }
  const pageSize = typeof options.pageSize === 'number' && options.pageSize > 0 ? options.pageSize : 100;
  const query = typeof options.query === 'string' ? options.query : '';

  const headers = {
    Authorization: `Bearer ${notionToken}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };

  let cursor = null;
  const all = [];
  do {
    const body = {
      query,
      filter: { property: 'object', value: 'database' },
      page_size: pageSize,
      ...(cursor ? { start_cursor: cursor } : {})
    };
    const resp = await fetch(`${NOTION_API_BASE}/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Notion API ${resp.status}: ${text}`);
    }
    const data = await resp.json();
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


