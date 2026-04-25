import { Client } from "@notionhq/client";
import fs from "fs";
import path from "path";

const notion = new Client({
  auth: process.env.NOTION_API_KEY || process.env.NOTION_TOKEN,
});

const QA_DB_ID =
  process.env.NOTION_QA_DB_ID ||
  process.env.NOTION_DB_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function readPrompt(fileName) {
  const filePath = path.join(process.cwd(), "prompts", fileName);
  return fs.readFileSync(filePath, "utf8");
}

function getPlainText(property) {
  if (!property) return "";

  if (property.type === "title") {
    return property.title?.map((t) => t.plain_text).join("") || "";
  }

  if (property.type === "rich_text") {
    return property.rich_text?.map((t) => t.plain_text).join("") || "";
  }

  if (property.type === "select") {
    return property.select?.name || "";
  }

  if (property.type === "status") {
    return property.status?.name || "";
  }

  if (property.type === "multi_select") {
    return property.multi_select?.map((x) => x.name).join("、") || "";
  }

  if (property.type === "checkbox") {
    return property.checkbox ? "true" : "false";
  }

  return "";
}

function isEnabledPage(page) {
  const props = page.properties || {};

  const status =
    getPlainText(props["狀態"]) ||
    getPlainText(props["啟用狀態"]) ||
    getPlainText(props["使用狀態"]);

  const disabledCheckbox =
    props["不使用"]?.type === "checkbox"
      ? props["不使用"].checkbox
      : false;

  const enabledCheckbox =
    props["啟用"]?.type === "checkbox"
      ? props["啟用"].checkbox
      : null;

  if (disabledCheckbox === true) return false;
  if (enabledCheckbox === false) return false;

  if (status) {
    const disabledWords = [
      "停用",
      "不使用",
      "禁用",
      "封鎖",
      "下架",
      "隱藏",
      "草稿",
    ];

    if (disabledWords.some((word) => status.includes(word))) {
      return false;
    }
  }

  return true;
}

function getPageFields(page) {
  const props = page.properties || {};

  return {
    question:
      getPlainText(props["問題"]) ||
      getPlainText(props["標題"]) ||
      getPlainText(props["Name"]),

    topic:
      getPlainText(props["主題"]) ||
      getPlainText(props["分類"]),

    spine:
      getPlainText(props["對應脊椎分節"]),

    teachingAnswer:
      getPlainText(props["教材版回覆"]) ||
      getPlainText(props["回答"]) ||
      getPlainText(props["答案"]),

    clinicalSuggestion:
      getPlainText(props["臨床流程建議"]),

    meridian:
      getPlainText(props["經絡與補充"]),

    keywords:
      getPlainText(props["關鍵字"]) ||
      getPlainText(props["keyword"]) ||
      getPlainText(props["keywords"]),

    status:
      getPlainText(props["狀態"]) ||
      getPlainText(props["啟用狀態"]) ||
      getPlainText(props["使用狀態"]),

    disabled:
      props["不使用"]?.type === "checkbox"
        ? props["不使用"].checkbox
        : false,
  };
}

async function callOpenAI(messages, options = {}) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model || "gpt-4o-mini",
      messages,
      temperature: options.temperature ?? 0.2,
      response_format: options.response_format,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("OpenAI error:", data);
    throw new Error(data?.error?.message || "OpenAI API error");
  }

  return data.choices?.[0]?.message?.content || "";
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("JSON parse failed:", text);
    return fallback;
  }
}

async function analyzeQuery(userMessage) {
  const prompt = readPrompt("knowledge-query.md");

  const content = await callOpenAI(
    [
      { role: "system", content: prompt },
      { role: "user", content: userMessage },
    ],
    {
      temperature: 0.1,
      response_format: { type: "json_object" },
    }
  );

  const parsed = safeJsonParse(content, null);

  if (!parsed) {
    return {
      normalized_question: userMessage,
      need_knowledge_base: true,
      query_keywords: [userMessage],
      answer_mode: "general",
      audience: "customer",
      only_enabled: true,
      safety_level: "normal",
    };
  }

  return {
    normalized_question: parsed.normalized_question || userMessage,
    need_knowledge_base: parsed.need_knowledge_base !== false,
    query_keywords: Array.isArray(parsed.query_keywords)
      ? parsed.query_keywords
      : [userMessage],
    answer_mode: parsed.answer_mode || "general",
    audience: parsed.audience || "customer",
    only_enabled: parsed.only_enabled !== false,
    safety_level: parsed.safety_level || "normal",
  };
}

async function queryNotionKnowledge(queryInfo) {
  if (!QA_DB_ID) {
    console.warn("Missing NOTION_QA_DB_ID or NOTION_DB_ID");
    return [];
  }

  const keywords = [
    queryInfo.normalized_question,
    ...(queryInfo.query_keywords || []),
  ]
    .filter(Boolean)
    .map((x) => String(x).trim())
    .filter((x, index, arr) => x && arr.indexOf(x) === index)
    .slice(0, 8);

  const resultsMap = new Map();

  for (const keyword of keywords) {
    const response = await notion.databases.query({
      database_id: QA_DB_ID,
      page_size: 10,
      filter: {
        or: [
          {
            property: "問題",
            title: {
              contains: keyword,
            },
          },
          {
            property: "教材版回覆",
            rich_text: {
              contains: keyword,
            },
          },
          {
            property: "主題",
            select: {
              equals: keyword,
            },
          },
          {
            property: "對應脊椎分節",
            rich_text: {
              contains: keyword,
            },
          },
        ],
      },
    });

    for (const page of response.results || []) {
      if (!isEnabledPage(page)) continue;
      resultsMap.set(page.id, page);
    }
  }

  const pages = Array.from(resultsMap.values());

  return pages.map(getPageFields).filter((item) => {
    return (
      item.question ||
      item.teachingAnswer ||
      item.clinicalSuggestion ||
      item.meridian
    );
  });
}

function formatKnowledgeForAI(items) {
  if (!items || items.length === 0) {
    return "目前沒有查到啟用中的知識庫資料。";
  }

  return items
    .map((item, index) => {
      return `
【資料 ${index + 1}】
問題：${item.question || "未填"}
主題：${item.topic || "未填"}
對應脊椎分節：${item.spine || "未填"}
教材版回覆：${item.teachingAnswer || "未填"}
臨床流程建議：${item.clinicalSuggestion || "未填"}
經絡與補充：${item.meridian || "未填"}
關鍵字：${item.keywords || "未填"}
`;
    })
    .join("\n");
}

async function generateFinalAnswer(userMessage, queryInfo, knowledgeItems) {
  const prompt = readPrompt("knowledge-answer.md");
  const knowledgeText = formatKnowledgeForAI(knowledgeItems);

  const userContent = `
使用者原始問題：
${userMessage}

查詢理解結果：
${JSON.stringify(queryInfo, null, 2)}

啟用中的知識庫資料：
${knowledgeText}
`;

  const answer = await callOpenAI(
    [
      { role: "system", content: prompt },
      { role: "user", content: userContent },
    ],
    {
      temperature: 0.4,
    }
  );

  return answer.trim();
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed",
      });
    }

    const userMessage =
      req.body?.message ||
      req.body?.text ||
      req.body?.question ||
      "";

    if (!userMessage || typeof userMessage !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Missing message",
      });
    }

    const queryInfo = await analyzeQuery(userMessage);

    const knowledgeItems = queryInfo.need_knowledge_base
      ? await queryNotionKnowledge(queryInfo)
      : [];

    const reply = await generateFinalAnswer(
      userMessage,
      queryInfo,
      knowledgeItems
    );

    return res.status(200).json({
      ok: true,
      reply,
      debug: {
        normalized_question: queryInfo.normalized_question,
        query_keywords: queryInfo.query_keywords,
        answer_mode: queryInfo.answer_mode,
        knowledge_count: knowledgeItems.length,
      },
    });
  } catch (error) {
    console.error("answer.js error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Internal server error",
    });
  }
}
