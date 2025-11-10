// /api/generate-copy.js  （Node 18+ / Vercel）
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL   = "gpt-4o-mini";
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const RECORD_DB_ID   = process.env.RECORD_DB_ID;

// 依你「不老會員紀錄DB」欄位名做 mapping（右側要與 Notion 完全一致）
const COL = {
  title: "標題",
  email: "Email",
  userId: "UserId",
  category: "類別",
  content: "內容",
  date: "日期",
  source: "來源",
  aiAnswer: "AI回覆",
};

// ✅ 對應：Email=Email 型別、來源=Select 型別
async function writeNotion({ title, email, userId, content, aiText, source }) {
  const props = {};

  // 標題（Title）
  props[COL.title] = {
    title: [{ type: "text", text: { content: title || "AI 產文紀錄" } }],
  };

  // Email（Email 型別 → 用 { email }）
  if (COL.email && email) {
    props[COL.email] = { email };
  }

  // UserId / 內容 / AI回覆（Rich text）
  if (COL.userId)  props[COL.userId]  = { rich_text: [{ text: { content: userId || "" } }] };
  if (COL.content) props[COL.content] = { rich_text: [{ text: { content: content || "" } }] };
  if (COL.aiAnswer)props[COL.aiAnswer]= { rich_text: [{ text: { content: aiText || "" } }] };

  // 類別（Select）→ 先在 Notion 建好「AI產文」選項
  if (COL.category) props[COL.category] = { select: { name: "AI產文" } };

  // 日期（Date）
  if (COL.date) props[COL.date] = { date: { start: new Date().toISOString() } };

  // 來源（Select）→ 你的表是 Select，所以保持 select
  if (COL.source) props[COL.source] = { select: { name: source || "API" } };

  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: RECORD_DB_ID },
      properties: props,
    }),
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`[Notion] ${data?.message || r.status}`);
  return data;
}


export default async function handler(req, res) {
  try {
    // 健康檢查（GET）
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, hint: "POST { topic, userId, email? }" });
    }
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const { topic, userId = "", email = "" } = req.body || {};
    if (!topic) return res.status(400).json({ ok: false, error: "缺少 topic" });

    // 呼叫 OpenAI 產文
    const started = Date.now();
    const c = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: prompt(topic),
      temperature: 0.7,
    });
    const latency = Date.now() - started;
    const answer  = c.choices?.[0]?.message?.content?.trim() || "";
    const usage   = c.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // 回寫 Notion
    await writeNotion({
      title: `行銷文案｜${topic.slice(0, 30)}`,
      email,
      userId,
      content: topic,
      aiText: answer,
      source: "API",
    });

    return res.status(200).json({ ok: true, answer, tokens: usage, latency_ms: latency });
  } catch (err) {
    console.error("[generate-copy] error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "internal error" });
  }
}
