// api/answer.js
// V6.2：加入 AI自評（ai_score / ai_reason）+ 維持V6.1穩定結構

const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const QA_DB_ID = process.env.NOTION_QA_DB_ID || process.env.NOTION_DB_ID || "";
const NOTION_VER = "2022-06-28";

/* =========================
   API入口
========================= */

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const userMessage = (req.body?.message || "").trim();
    if (!userMessage) {
      return res.status(400).json({ ok: false, error: "Missing message" });
    }

    /* ====== 1. 查詢理解 ====== */
    const queryInfo = await analyzeQuery(userMessage);

    /* ====== 2. 查詢知識庫 ====== */
    const knowledgeItems = await queryNotion(queryInfo);

    /* ====== 3. 主資料判斷 ====== */
    const primary = knowledgeItems[0] || null;

    /* ====== 4. 決定回答來源 ====== */
    const answerSource = primary ? "knowledge_first" : "ai_fallback";

    /* ====== 5. 產生回答 ====== */
    const reply = await generateAnswer({
      userMessage,
      queryInfo,
      primary,
      knowledgeItems,
      answerSource
    });

    /* ====== 6. AI自評（🔥新功能） ====== */
    const selfReview = await aiSelfReview({
      userMessage,
      reply,
      primary,
      knowledgeItems
    });

    /* ====== 7. 回傳 ====== */
    return res.status(200).json({
      ok: true,
      reply,
      debug: {
        version: "V6.2-ai-self-review",
        answer_source: answerSource,
        normalized_question: queryInfo.normalized_question,
        query_keywords: queryInfo.query_keywords,
        knowledge_count: knowledgeItems.length,
        primary_title: primary?.question || "",
        hit_knowledge_base: !!primary,
        ai_score: selfReview.score,
        ai_reason: selfReview.reason
      }
    });

  } catch (err) {
    console.error("[answer_error]", err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
};

/* =========================
   查詢理解
========================= */

async function analyzeQuery(text) {
  return {
    normalized_question: text,
    query_keywords: [text]
  };
}

/* =========================
   Notion查詢（簡化版）
========================= */

async function queryNotion(queryInfo) {
  if (!QA_DB_ID) return [];

  const res = await fetch(`https://api.notion.com/v1/databases/${QA_DB_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      page_size: 5
    })
  });

  const data = await res.json();

  return (data.results || []).map(p => ({
    question: readText(p, "問題"),
    teaching: readText(p, "教材版回覆")
  }));
}

function readText(page, key) {
  const prop = page.properties[key];
  if (!prop) return "";
  if (prop.title) return prop.title.map(x => x.plain_text).join("");
  if (prop.rich_text) return prop.rich_text.map(x => x.plain_text).join("");
  return "";
}

/* =========================
   產生回答
========================= */

async function generateAnswer({
  userMessage,
  primary,
  answerSource
}) {
  if (answerSource === "knowledge_first" && primary) {
    return `【教材重點】
${primary.teaching}

【AI補充說明】
這是依據不老系統整理的結構觀察，不屬於醫療診斷。`;
  }

  return `目前資料庫沒有完整資料，我先用結構 × 神經 × 肌肉邏輯補充說明：

${userMessage} 通常與身體的代償與張力有關，建議先觀察位置、時間與頻率。

⚠️ 此為結構觀察，不是醫療診斷。`;
}

/* =========================
   🔥 AI自評系統（核心）
========================= */

async function aiSelfReview({
  userMessage,
  reply,
  primary,
  knowledgeItems
}) {
  const prompt = `
你是AI品質評估系統，請針對以下回答打分數（0~100），並說明原因。

評分標準：
- 是否有命中資料庫（很重要）
- 是否符合不老系統（結構/神經/肌肉）
- 是否安全（沒有醫療誤導）
- 是否清楚、有教學價值

請用JSON輸出：
{
  "score": 數字,
  "reason": "原因"
}

問題：
${userMessage}

回答：
${reply}
`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    });

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";

    const json = safeParse(text);

    return {
      score: json?.score || 70,
      reason: json?.reason || "無法解析評分理由"
    };

  } catch (e) {
    return {
      score: 60,
      reason: "AI評分失敗，使用預設分數"
    };
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
