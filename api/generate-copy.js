// /api/generate-copy.js  （Node 18+ / Vercel）
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL   = "gpt-4o-mini";
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const RECORD_DB_ID   = process.env.RECORD_DB_ID;

// === Prompt 函式要先宣告 ===
function buildPrompt(userTopic) {
  return [
    {
      role: "system",
      content:
        "你是一位溫柔、療癒、可信任的台灣行銷文案助手，請用 50–80 字寫 IG 貼文開頭，避免醫療/療效承諾字眼，結尾加 2–4 個 hashtag（繁體）。",
    },
    { role: "user", content: userTopic },
  ];
}

// === Notion 欄位 mapping ===
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

// === Notion 寫入函式 ===
async function writeNotion({ title, email, userId, content, aiText, source }) {
  const props = {};

  // 標題
  props[COL.title] = {
    title: [{ type: "text", text: { content: title || "AI 產文紀錄" } }],
  };

  // Email（Email 型別）
  if (COL.email && email) {
    props[COL.email] = { email };
  }

  // UserId、內容、AI回覆（Rich text）
  if (COL.userId)
    props[COL.userId] = { rich_text: [{ text: { content: userId || "" } }] };
  if (COL.content)
    props[COL.content] = { rich_text: [{ text: { content: content || "" } }] };
  if (COL.aiAnswer)
    props[COL.aiAnswer] = { rich_text: [{ text: { content: aiText || "" } }] };

  // 類別（Select）
  if (COL.category)
    props[COL.category] = { select: { name: "AI產文" } };

  // 日期（Date）
  if (COL.date)
    props[COL.date] = { date: { start: new Date().toISOString() } };

  // 來源（Select）
  if (COL.source)
    props[COL.source] = { select: { name: source || "API" } };

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

// === API Handler ===
export default async function handler(req, res) {
  try {
    // 健康檢查（GET）
    if (req.method === "GET") {
      return res
        .status(200)
        .json({ ok: true, hint: "POST { topic, userId, email? }" });
    }
    if (req.method !== "POST")
      return res.status(405).send("Method Not Allowed");

    const { topic, userId = "", email = "" } = req.body || {};
    if (!topic)
      return res.status(400).json({ ok: false, error: "缺少 topic" });

    // 呼叫 OpenAI 產文
    const started = Date.now();
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: buildPrompt(topic),
      temperature: 0.7,
    });
    const latency = Date.now() - started;
    const answer =
      completion.choices?.[0]?.message?.content?.trim() || "";
    const usage =
      completion.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };

    // 寫入 Notion
    await writeNotion({
      title: `行銷文案｜${topic.slice(0, 30)}`,
      email,
      userId,
      content: topic,
      aiText: answer,
      source: "API",
    });

    return res
      .status(200)
      .json({ ok: true, answer, tokens: usage, latency_ms: latency });
  } catch (err) {
    console.error("[generate-copy] error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "internal error" });
  }
}
