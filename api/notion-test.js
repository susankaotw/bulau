// api/notion-test.js
// 功能：測試 Vercel 是否能成功連到 Notion QA 資料庫

const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const QA_DB_ID = process.env.NOTION_QA_DB_ID || process.env.NOTION_DB_ID || "";
const NOTION_VER = "2022-06-28";

module.exports = async function handler(req, res) {
  try {
    if (!NOTION_KEY) {
      return res.status(500).json({
        ok: false,
        step: "check_env",
        error: "缺少 NOTION_API_KEY 或 NOTION_TOKEN"
      });
    }

    if (!QA_DB_ID) {
      return res.status(500).json({
        ok: false,
        step: "check_env",
        error: "缺少 NOTION_QA_DB_ID 或 NOTION_DB_ID"
      });
    }

    // 1. 測試讀取 database metadata
    const dbRes = await fetch(`https://api.notion.com/v1/databases/${QA_DB_ID}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${NOTION_KEY}`,
        "Notion-Version": NOTION_VER,
        "Content-Type": "application/json"
      }
    });

    const dbJson = await dbRes.json().catch(() => ({}));

    if (!dbRes.ok) {
      return res.status(500).json({
        ok: false,
        step: "read_database",
        database_id: QA_DB_ID,
        status: dbRes.status,
        notion_error: dbJson,
        hint: "如果 status 是 404，通常是資料庫 ID 錯，或 Notion 資料庫沒有分享給 Integration。"
      });
    }

    // 2. 測試 query database
    const queryRes = await fetch(`https://api.notion.com/v1/databases/${QA_DB_ID}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_KEY}`,
        "Notion-Version": NOTION_VER,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        page_size: 3
      })
    });

    const queryJson = await queryRes.json().catch(() => ({}));

    if (!queryRes.ok) {
      return res.status(500).json({
        ok: false,
        step: "query_database",
        database_id: QA_DB_ID,
        status: queryRes.status,
        notion_error: queryJson,
        hint: "資料庫 metadata 讀得到，但 query 失敗，通常是權限或欄位結構問題。"
      });
    }

    const properties = Object.keys(dbJson.properties || {});
    const sampleTitles = (queryJson.results || []).map(page => {
      const props = page.properties || {};
      const titleProp = Object.values(props).find(p => p.type === "title");

      if (!titleProp || !Array.isArray(titleProp.title)) return "";

      return titleProp.title.map(t => t.plain_text || "").join("").trim();
    });

    return res.status(200).json({
      ok: true,
      message: "✅ Notion QA 資料庫連線成功",
      database_id: QA_DB_ID,
      database_title: getDbTitle(dbJson),
      property_names: properties,
      sample_count: queryJson.results ? queryJson.results.length : 0,
      sample_titles: sampleTitles
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      step: "server_error",
      error: error.message || String(error)
    });
  }
};

function getDbTitle(dbJson) {
  if (!dbJson || !Array.isArray(dbJson.title)) return "";

  return dbJson.title.map(t => t.plain_text || "").join("").trim();
}
