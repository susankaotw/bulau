// api/answer.js
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

function rtToText(p) {
  if (!p || !Array.isArray(p.rich_text)) return "";
  return p.rich_text.map(t => t.plain_text || "").join("").trim();
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }
    if (!process.env.NOTION_TOKEN || !DB_ID) {
      return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DB_ID" });
    }

    const { email = "", question = "" } = req.body || {};
    const q = String(question || "").trim();
    if (!q) return res.status(400).json({ error: "question is required" });

    // MVP：用「問題」欄位做包含搜尋，並以最後編輯時間排序
    const key = q.length > 16 ? q.slice(0, 16) : q;
    const query = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: "問題", rich_text: { contains: key } },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
    });

    const item = query.results?.[0];
    if (!item) {
      return res.json({
        mode: "查詢",
        email,
        answer: "查不到相符條目，請換個問法（如：改成『肩頸痠痛怎麼放鬆』）。",
        matched: null,
        version: null,
        updated_at: null
      });
    }

    const props = item.properties || {};
    const topic = props["主題"]?.select?.name || "";
    const qTitle = props["問題"]?.title?.[0]?.plain_text || "";
    const edu = rtToText(props["衛教版回覆"]);
    const pro = rtToText(props["專業版回覆"]);
    const act = rtToText(props["建議動作"]);
    const warn = rtToText(props["禁忌與注意"]);
    const ver = props["版本號"]?.rich_text?.[0]?.plain_text || "";
    const updated = item.last_edited_time;

    return res.json({
      mode: "查詢",
      email,
      answer: {
        主題: topic,
        問題: qTitle,
        衛教版回覆: edu,
        專業版回覆: pro,
        建議動作: act,
        禁忌與注意: warn
      },
      version: ver,
      updated_at: updated,
      matched: qTitle
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
