// api/notion-search-test.js

const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const QA_DB_ID = process.env.NOTION_QA_DB_ID || process.env.NOTION_DB_ID || "";
const NOTION_VER = "2022-06-28";

module.exports = async function handler(req, res) {
  const keyword = String(req.query.q || "PD腳判斷").trim();

  try {
    const body = {
      filter: {
        and: [
          {
            property: "是否啟用",
            checkbox: {
              equals: true
            }
          },
          {
            property: "問題",
            title: {
              contains: keyword
            }
          }
        ]
      },
      page_size: 10
    };

    const r = await fetch(`https://api.notion.com/v1/databases/${QA_DB_ID}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_KEY}`,
        "Notion-Version": NOTION_VER,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const data = await r.json();

    return res.status(200).json({
      ok: r.ok,
      keyword,
      status: r.status,
      count: data.results ? data.results.length : 0,
      titles: (data.results || []).map(page => {
        const title = page.properties?.["問題"]?.title || [];
        return title.map(t => t.plain_text || "").join("").trim();
      }),
      raw_error: r.ok ? null : data
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message || String(e)
    });
  }
};
