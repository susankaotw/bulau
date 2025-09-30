// api/answer.js
// 不老平衡骨架中心｜查詢版（支援多筆）

const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

const rtText = (prop) =>
  (prop?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
const titleText = (prop) =>
  (prop?.title || []).map(t => t?.plain_text || "").join("").trim();

function guessTopic(q) {
  if (!q) return null;
  if (/肩|頸/.test(q)) return "症狀對應";
  if (/手|臂|肘|上肢/.test(q)) return "上肢";
  if (/腰|背|下背/.test(q)) return "腰背";
  if (/膝|腿|下肢/.test(q)) return "下肢";
  return null;
}

function pageToItem(page) {
  const p = page.properties || {};
  return {
    主題: p["主題"]?.select?.name || "",
    問題: titleText(p["問題"]) || rtText(p["問題"]) || "",
    教材版回覆: rtText(p["教材版回覆"]),
    臨床流程建議: rtText(p["臨床流程建議"]),
    對應脊椎分節: rtText(p["對應脊椎分節"]),
    經絡與補充: rtText(p["經絡與補充"]),
    version: p["版本號"]?.rich_text?.[0]?.plain_text || rtText(p["版本號"]) || "v1.0.0",
    updated_at: page.last_edited_time,
    id: page.id
  };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    if (!process.env.NOTION_TOKEN || !DB_ID) {
      return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DB_ID" });
    }

    const { email = "", question, 問題 } = req.body || {};
    const q = String(question ?? 問題 ?? "").trim();
    if (!q) return res.status(400).json({ error: "question is required" });

    const key = q.length > 16 ? q.slice(0, 16) : q;

    // 依序嘗試：Title → Rich text → 主題保底；取第一個有結果的集合
    let results = [];
    let resp = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: "問題", title: { contains: key } },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 10
    });
    results = resp.results;

    if (!results?.length) {
      resp = await notion.databases.query({
        database_id: DB_ID,
        filter: { property: "問題", rich_text: { contains: key } },
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 10
      });
      results = resp.results;
    }

    if (!results?.length) {
      const topic = guessTopic(q);
      if (topic) {
        resp = await notion.databases.query({
          database_id: DB_ID,
          filter: { property: "主題", select: { equals: topic } },
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
          page_size: 10
        });
        results = resp.results;
      }
    }

    if (!results?.length) {
      return res.json({
        mode: "查詢",
        email,
        answer: "查不到相符條目，請改用其他關鍵字（例：肩頸痠痛、手舉不起來）。",
        matched: null, version: null, updated_at: null, count: 0, items: []
      });
    }

    // 取前 N 筆（你可調整）
    const N = 5;
    const items = results.slice(0, N).map(pageToItem);

    // 相容舊前端：帶第一筆在 answer/version/updated_at
    return res.json({
      mode: "查詢",
      email,
      matched: key,
      count: items.length,
      items,
      answer: items[0],                 // 供舊版使用
      version: items[0].version,        // 供舊版使用
      updated_at: items[0].updated_at   // 供舊版使用
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
