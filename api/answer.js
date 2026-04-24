// ===== AI Router + Notion 查詢版 =====

const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_ID = process.env.NOTION_DB_ID;

// ===== Router =====
function detectIntent(text) {
  const t = text;

  if (/骨折|腫瘤|發炎|骨鬆/.test(t)) return "禁忌風險";
  if (/PD|長短腳|姿勢|判斷/.test(t)) return "判斷流程";
  if (/C[1-7]|T[1-9]|T1[0-2]|L[1-5]/.test(t)) return "分節查詢";
  if (/痛|痠|麻|卡|無力|頭痛|肩|腰/.test(t)) return "症狀查詢";
  if (/為什麼|原理|什麼是|半脫位|神經/.test(t)) return "核心觀念";
  if (/打一邊|不打痛點|多久|會痠/.test(t)) return "QA教學";

  return "其他";
}

// ===== 關鍵字 =====
function extractKeyword(text) {
  const list = ["C1","C2","C5","T6","L4","L5","頭痛","肩痛","腰痛","手麻","足底"];
  return list.find(k => text.includes(k)) || text;
}

// ===== 查 Notion =====
async function searchDB(intent, keyword) {
  const filters = [
    {
      property: "是否啟用",
      checkbox: { equals: true }
    }
  ];

  if (intent !== "其他") {
    filters.push({
      property: "類型",
      select: { equals: intent }
    });
  }

  if (intent === "分節查詢") {
    filters.push({
      property: "對應脊椎分節",
      rich_text: { contains: keyword }
    });
  }

  if (intent === "症狀查詢") {
    filters.push({
      property: "關鍵字",
      multi_select: { contains: keyword }
    });
  }

  const res = await notion.databases.query({
    database_id: DB_ID,
    filter: { and: filters },
    page_size: 3
  });

  return res.results;
}

// ===== 取文字 =====
function getText(p, key) {
  const prop = p[key];
  if (!prop) return "";

  if (prop.type === "title")
    return prop.title.map(t => t.plain_text).join("");

  if (prop.type === "rich_text")
    return prop.rich_text.map(t => t.plain_text).join("");

  if (prop.type === "select")
    return prop.select?.name || "";

  return "";
}

// ===== 組回覆 =====
function buildReply(page) {
  const p = page.properties;

  return `【${getText(p, "問題")}】

【教材重點】
${getText(p, "教材版回覆")}

【學員理解】
${getText(p, "AI教學說法")}

【臨床流程】
${getText(p, "臨床流程建議")}

【判斷方式】
${getText(p, "判斷流程")}

【溝通話術】
${getText(p, "客戶溝通話術")}

【安全提醒】
${getText(p, "風險提醒") || "此為教學用途，非醫療診斷"}`;
}

// ===== 主 API =====
module.exports = async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.json({ answer: "請輸入問題" });
    }

    const intent = detectIntent(question);
    const keyword = extractKeyword(question);

    const results = await searchDB(intent, keyword);

    if (!results.length) {
      return res.json({
        answer: "查無資料，請換關鍵字試試（例如：C1、手麻、PD）"
      });
    }

    const reply = buildReply(results[0]);

    return res.json({
      answer: reply,
      intent,
      keyword
    });

  } catch (e) {
    return res.json({ error: e.message });
  }
};
