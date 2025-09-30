// api/answer.js
// 不老平衡骨架中心｜查詢版（對應新版 Notion 欄位）
// － 只做查詢，不啟用創作（生成）；保留與前端相容的鍵名輸出
// － 支援 question/問題 任一鍵；查詢：Title → RichText → 主題保底

const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

// 取文字的小工具
const rtText = (prop) =>
  (prop?.rich_text || [])
    .map((t) => t?.plain_text || "")
    .join("")
    .trim();

const titleText = (prop) =>
  (prop?.title || [])
    .map((t) => t?.plain_text || "")
    .join("")
    .trim();

// 簡單主題猜測（保底）
function guessTopic(q) {
  if (!q) return null;
  if (/肩|頸/.test(q)) return "症狀對應"; // 你目前的主題是「症狀對應」
  if (/手|臂|肘|上肢/.test(q)) return "上肢";
  if (/腰|背|下背/.test(q)) return "腰背";
  if (/膝|腿|下肢/.test(q)) return "下肢";
  return null;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }
    if (!process.env.NOTION_TOKEN || !DB_ID) {
      return res
        .status(500)
        .json({ error: "Missing NOTION_TOKEN or NOTION_DB_ID" });
    }

    const { email = "", question, 問題, mode = "查詢" } = req.body || {};
    const q = String(question ?? 問題 ?? "").trim();
    if (!q) return res.status(400).json({ error: "question is required" });

    const key = q.length > 16 ? q.slice(0, 16) : q;

    // 1) 先用 Title（問題）查
    let resp = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: "問題", title: { contains: key } },
      sorts: [
        { timestamp: "last_edited_time", direction: "descending" },
      ],
      page_size: 5,
    });

    let item = resp.results?.[0];

    // 2) 沒有就用 Rich Text（萬一「問題」被設成 Rich text）
    if (!item) {
      resp = await notion.databases.query({
        database_id: DB_ID,
        filter: { property: "問題", rich_text: { contains: key } },
        sorts: [
          { timestamp: "last_edited_time", direction: "descending" },
        ],
        page_size: 5,
      });
      item = resp.results?.[0];
    }

    // 3) 仍沒有就用主題保底（選用）
    if (!item) {
      const topic = guessTopic(q);
      if (topic) {
        resp = await notion.databases.query({
          database_id: DB_ID,
          filter: { property: "主題", select: { equals: topic } },
          sorts: [
            { timestamp: "last_edited_time", direction: "descending" },
          ],
          page_size: 5,
        });
        item = resp.results?.[0];
      }
    }

    if (!item) {
      return res.json({
        mode: "查詢",
        email,
        answer:
          "查不到相符條目，請改用其它關鍵字（例：肩頸痠痛、手舉不起來）。",
        matched: null,
        version: null,
        updated_at: null,
      });
    }

    const p = item.properties || {};
    const out = {
      // 與前端相容的鍵名（沿用舊版）
      主題: p["主題"]?.select?.name || "",
      問題: titleText(p["問題"]) || rtText(p["問題"]) || "",
      衛教版回覆: rtText(p["教材版回覆"]), // ← 新欄位映射
      專業版回覆: rtText(p["臨床流程建議"]), // ← 新欄位映射
      建議動作: rtText(p["對應脊椎分節"]), // ← 新欄位映射
      禁忌與注意: rtText(p["經絡與補充"]), // ← 新欄位映射

      // 保留原始欄位（方便未來前端改名）
      raw: {
        教材版回覆: rtText(p["教材版回覆"]),
        臨床流程建議: rtText(p["臨床流程建議"]),
        經絡與補充: rtText(p["經絡與補充"]),
        對應脊椎分節: rtText(p["對應脊椎分節"]),
      },
    };

    const version =
      p["版本號"]?.rich_text?.[0]?.plain_text ||
      rtText(p["版本號"]) ||
      "";
    const updated_at = item.last_edited_time;

    return res.json({
      mode: "查詢",
      email,
      answer: out,
      version: version || "v1.0.0",
      updated_at,
      matched: out.問題 || key,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
