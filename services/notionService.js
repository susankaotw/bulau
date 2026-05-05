const { safeText } = require("./textUtils");

const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const NOTION_VER = "2022-06-28";

async function notionQueryDatabase(dbId, body) {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body || {})
  });

  try {
    return await r.json();
  } catch {
    return {};
  }
}

async function notionPatchPage(pageId, data) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data || {})
  });

  if (!r.ok) console.error("[notionPatchPage]", r.status, await safeText(r));
  return r.ok;
}

async function notionCreatePage(dbId, properties) {
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties
    })
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) console.error("[notionCreatePage]", r.status, j);

  return { ok: r.ok, json: j, status: r.status };
}

async function notionGetPage(pageId) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    }
  });

  try {
    return await r.json();
  } catch {
    return {};
  }
}

module.exports = {
  notionQueryDatabase,
  notionCreatePage,
  notionPatchPage,
  notionGetPage
};
