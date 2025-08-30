// utils/untitledDatabases.js
// Utility to find Notion databases that have an empty title

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Search all databases shared with the integration and return those with an empty title
 * @param {string} notionToken - Notion internal integration token (secret_... or ntn_...)
 * @param {{ pageSize?: number }} [options]
 * @returns {Promise<Array<{ id: string, url: string }>>}
 */
export async function searchUntitledDatabases(notionToken, options = {}) {
  if (!notionToken || typeof notionToken !== "string") {
    throw new Error("Notion token is required");
  }
  const pageSize =
    typeof options.pageSize === "number" && options.pageSize > 0 ? options.pageSize : 100;

  const headers = {
    Authorization: `Bearer ${notionToken}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  let cursor = null;
  const untitled = [];
  do {
    const body = {
      filter: { property: "object", value: "database" },
      page_size: pageSize,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const resp = await fetch(`${NOTION_API_BASE}/search`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Notion API ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    const results = Array.isArray(data.results) ? data.results : [];
    for (const item of results) {
      const title = (item?.title || []).map((t) => t?.plain_text || "").join("");
      if (!title || title.trim().length === 0) {
        const id = item.id;
        const url = item.url || `https://www.notion.so/${String(id || "").replace(/-/g, "")}`;
        untitled.push({ id, url });
      }
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  return untitled;
}

/**
 * Format the list as markdown bullet points
 * @param {Array<{ id: string, url: string }>} list
 */
export function formatUntitledListAsMarkdown(list) {
  return (list || []).map((x) => `- ${x.id}: ${x.url}`).join("\n");
}
