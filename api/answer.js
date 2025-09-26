// api/answer.js
const { Client } = require("@notionhq/client");
const OpenAI = require("openai"); // 即使沒用也可保留，之後開啟就能用

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;
const GEN_MODE = (process.env.GEN_MODE || "off").toLowerCase(); // off | fallback | on
const openai = process.env.OPENAI_API_KEY && GEN_MODE === "on"
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function rtToText(p) {
  if (!p || !Array.isArray(p.rich_text)) return "";
  return p.rich_text.map(t => t.plain_text || "").join("").trim();
}

// 不用 OpenAI 的本地組稿（120~180字上下）
function fallbackPost({ topic, qTitle, edu, act, warn }) {
  const title = qTitle || `${topic}小提醒`;
  const blocks = [
    `${title}｜重點整理：`,
    edu ? edu : "",
    act ? `建議：${act}` : "",
    warn ? `注意：${warn}` : ""
  ].filter(Boolean);
  const text = blocks.join(" ");
  const tail = " 想針對你情況調整，私訊不老平衡骨架中心預約評估。";
  return (text + tail).slice(0, 220);
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

    // —— 查 Notion（Title → Rich text → 主題Select 保底）
    const key = q.length > 16 ? q.slice(0, 16) : q;
    let item, query;

    query = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: "問題", title: { contains: key } },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
    });
    item = query.results?.[0];

    if (!item) {
      query = await notion.databases.query({
        database_id: DB_ID,
        filter: { property: "問題", rich_text: { contains: key } },
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
      });
      item = query.results?.[0];
    }

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
        mode: "查詢",
        email,
        answer: "查不到相符條目，請改用其他關鍵字（例：肩頸痠痛怎麼放鬆）。",
        matched: null, version: null, updated_at: null
      });
    }

    const props = item.properties || {};
    const topic = props["主題"]?.select?.name || "";
    const qTitle = props["問題"]?.title?.[0]?.plain_text || "";
    const edu = rtToText(props["衛教版回覆"]);
    const pro = rtToText(props["專業版回覆"]); // 目前未用於創作，但可保留
    const act = rtToText(props["建議動作"]);
    const warn = rtToText(props["禁忌與注意"]);
    const ver = props["版本號"]?.rich_text?.[0]?.plain_text || "";
    const updated = item.last_edited_time;

    // —— 查詢模式：直接回知識庫
    if (mode === "查詢") {
      return res.json({
        mode: "查詢",
        email,
        answer: { 主題: topic, 問題: qTitle, 衛教版回覆: edu, 專業版回覆: pro, 建議動作: act, 禁忌與注意: warn },
        version: ver, updated_at: updated, matched: qTitle
      });
    }

    // —— 創作模式（暫停/保留）
    if (mode === "創作") {
      // 1) 關閉：只回本地組稿＋狀態
      if (GEN_MODE === "off") {
        const output = fallbackPost({ topic, qTitle, edu, act, warn });
        return res.json({
          mode: "創作",
          status: "disabled",
          note: "創作模式暫時關閉；下方為根據知識庫自動生成的精簡貼文。",
          email, answer: output, version: ver, updated_at: updated, matched: qTitle || key
        });
      }

      // 2) 僅本地組稿（不調用 OpenAI）
      if (GEN_MODE === "fallback" || !openai) {
        const output = fallbackPost({ topic, qTitle, edu, act, warn });
        return res.json({
          mode: "創作",
          status: "fallback",
          email, answer: output, version: ver, updated_at: updated, matched: qTitle || key
        });
      }

      // 3) 開啟：用 OpenAI 生成（失敗再退回本地）
      try {
        const prompt = `
你是「不老平衡骨架中心」AI 助理，口吻專業、溫暖、易懂。
用 120–180 字中文寫衛教貼文，最後加 1 句 CTA（例如：私訊我們預約評估）。
避免誇大與絕對語氣；提醒個別狀況應由專業評估。
[主題] ${topic}
[問題] ${qTitle || q}
[衛教版回覆] ${edu}
[建議動作] ${act}
[禁忌與注意] ${warn}`.trim();

        const g = await openai.responses.create({
          model: "gpt-4o-mini",
          input: prompt,
          max_output_tokens: 300
        });

        return res.json({
          mode: "創作",
          status: "ai",
          email,
          answer: (g.output_text || "").trim(),
          version: ver, updated_at: updated, matched: qTitle || key
        });
      } catch (e) {
        const output = fallbackPost({ topic, qTitle, edu, act, warn });
        return res.json({
          mode: "創作",
          status: "fallback_error",
          error: String(e?.message || e),
          email, answer: output, version: ver, updated_at: updated, matched: qTitle || key
        });
      }
    }

    // 其他未支援模式
    return res.status(400).json({ error: `unknown mode: ${mode}` });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
