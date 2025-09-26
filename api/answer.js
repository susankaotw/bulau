// api/answer.js
const { Client } = require("@notionhq/client");
const OpenAI = require("openai");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function rtToText(p) {
  if (!p || !Array.isArray(p.rich_text)) return "";
  return p.rich_text.map(t => t.plain_text || "").join("").trim();
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    if (!process.env.NOTION_TOKEN || !DB_ID) {
      return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DB_ID" });
    }

    const { email = "", question, 問題, mode = "查詢" } = req.body || {};
    const q = String(question ?? 問題 ?? "").trim();
    if (!q) return res.status(400).json({ error: "question is required" });

    // —— 查詢 Notion：Title → Rich text → 主題 Select（保底）
    const key = q.length > 16 ? q.slice(0, 16) : q;
    let item, query;

    // 1) Title
    query = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: "問題", title: { contains: key } },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
    });
    item = query.results?.[0];

    // 2) Rich text
    if (!item) {
      query = await notion.databases.query({
        database_id: DB_ID,
        filter: { property: "問題", rich_text: { contains: key } },
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
      });
      item = query.results?.[0];
    }

    // 3) 主題保底
    if (!item) {
      const topicGuess = /肩|頸/.test(q) ? "肩頸"
                        : /腰|下背/.test(q) ? "腰背"
                        : /膝|腿|下肢/.test(q) ? "下肢"
                        : /手|肘|上肢/.test(q) ? "上肢"
                        : null;
      if (topicGuess) {
        query = await notion.databases.query({
          database_id: DB_ID,
          filter: { property: "主題", select: { equals: topicGuess } },
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
        });
        item = query.results?.[0];
      }
    }

    if (!item) {
      return res.json({
        mode, email,
        answer: "查不到相符條目，請改關鍵字再試（如：『肩頸痠痛怎麼放鬆』）。",
        matched: null, version: null, updated_at: null
      });
    }

    // —— 取欄位
    const props = item.properties || {};
    const topic = props["主題"]?.select?.name || "";
    const qTitle = props["問題"]?.title?.[0]?.plain_text || "";
    const edu = rtToText(props["衛教版回覆"]);
    const pro = rtToText(props["專業版回覆"]);
    const act = rtToText(props["建議動作"]);
    const warn = rtToText(props["禁忌與注意"]);
    const ver = props["版本號"]?.rich_text?.[0]?.plain_text || "";
    const updated = item.last_edited_time;

    // —— 查詢模式（或尚未設定 OPENAI_API_KEY）
    if (mode === "查詢" || !openai) {
      return res.json({
        mode: "查詢",
        email,
        answer: { 主題: topic, 問題: qTitle, 衛教版回覆: edu, 專業版回覆: pro, 建議動作: act, 禁忌與注意: warn },
        version: ver, updated_at: updated, matched: qTitle
      });
    }

    // —— 創作模式（生成 120–180 字貼文，附 CTA）
    const prompt = `
你是「不老平衡骨架中心」AI 助理，口吻專業、溫暖、易懂。
根據下列知識生成一段 120–180 字的中文衛教貼文，最後加 1 句 CTA（例如：私訊我們預約評估）。
避免誇大療效與絕對語氣；提醒個別狀況應由專業評估。
[主題] ${topic}
[問題] ${qTitle || q}
[衛教版回覆] ${edu}
[建議動作] ${act}
[禁忌與注意] ${warn}`.trim();

    const g = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt
    });

    return res.json({
      mode: "創作",
      email,
      answer: g.output_text,
      version: ver, updated_at: updated, matched: qTitle || key
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
