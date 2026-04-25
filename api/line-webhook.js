// api/line-webhook.js
// 功能：綁定 Email、查會員狀態、簽到、心得、主題查詢、Router查詢、IG開頭文案
// 升級：新版 answer.js 若回傳 reply，LINE 直接推送 AI + 知識庫融合回答，不再轉成舊卡片

/* ====== 環境變數 ====== */
const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const MEMBER_DB  = process.env.NOTION_MEMBER_DB_ID || "";
const RECORD_DB  = process.env.RECORD_DB_ID || "";
const QA_DB_ID   = process.env.NOTION_QA_DB_ID || process.env.NOTION_DB_ID || "";
const NOTION_VER = "2022-06-28";
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

/* ====== 會員 DB 欄位 ====== */
const MEMBER_EMAIL_PROP  = "Email";
const MEMBER_LINE_PROP   = "LINE UserId";
const MEMBER_STATUS_PROP = "狀態";
const MEMBER_LEVEL_PROP  = "等級";
const MEMBER_EXPIRE_PROP = "有效日期";

const BLOCK_STATUS_NAMES = ["停用", "封鎖", "黑名單", "禁用"];
const CHECK_EXPIRE = true;

/* ====== QA DB 欄位 ====== */
const QA_QUESTION = "問題";
const QA_TOPIC    = "主題";
const QA_SEGMENT  = "對應脊椎分節";
const QA_REPLY    = "教材版回覆";
const QA_FLOW     = "臨床流程建議";
const QA_MERIDIAN = "經絡與補充";

/* ====== 紀錄 DB 欄位 ====== */
const REC_TITLE = "標題";
const REC_EMAIL = "Email";
const REC_UID   = "UserId";
const REC_CATE  = "類別";
const REC_BODY  = "內容";
const REC_DATE  = "日期";
const REC_SRC   = "來源";
const REC_AI    = "AI回覆";
const REC_SEG   = "對應脊椎分節";

const REC_AI_TYPE      = "AI判斷類型";
const REC_HIT          = "是否命中資料";
const REC_NEED_REVIEW  = "是否需要人工補充";
const REC_ADD_TO_KB    = "是否納入知識庫";
const REC_RISK         = "風險標記";
const REC_MATCHED_KB   = "命中知識庫標題";
const REC_ADMIN_NOTE   = "管理備註";

/* ====== 小工具 ====== */
const trim = (s) => String(s || "").trim();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
const normalizeText = (s) => trim(String(s || "").replace(/\u3000/g, " ").replace(/\s+/g, " "));

/* ====== 入口 ====== */
module.exports = async (req, res) => {
  try {
    //if (req.method === "GET") return res.status(200).send("OK");
    if (req.method === "GET") {
  return res.status(200).send("LINE WEBHOOK VERSION: AI_REPLY_DIRECT_V1_20260425");
}
    if (req.method !== "POST") return res.status(405).end();

    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const ev of events) {
      try {
        await handleEvent(ev);
      } catch (e) {
        console.error("[event_error]", e);
      }
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[handler_crash]", e);
    res.status(200).json({ ok: false, error: e?.message || "unknown_error" });
  }
};

/* ====== 主流程 ====== */
async function handleEvent(ev) {
  if (ev.type !== "message" || ev.message?.type !== "text") return;

  const text = normalizeText(ev.message.text);
  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";

   // ✅ 暫時測試用：確認 LINE 是否真的打到這支新版 webhook
  await replyText(replyToken, "🔥 NEW VERSION WEBHOOK 🔥");
  return;

  /* ===== 顯示全部 ===== */
  const mShowAll = /^顯示(全部|更多)(?:\s|$)(.+)$/i.exec(text);
  if (mShowAll) {
    const query = normalizeText(mShowAll[2] || "");
    const gate = await ensureMemberAllowed(userId);
    if (!gate.ok) {
      await replyText(replyToken, gate.hint);
      return;
    }

    await replyLoading(replyToken, `「${query}」資料彙整中…`);

    const mTopic = /^主題(?:\s|:|：)?\s*(.+)$/i.exec(query);
    if (mTopic) {
      const topic = normalizeText(mTopic[1]);
      const list = await queryQaByTopic(topic, 50);

      if (list.length > 0) {
        try {
          const flex = buildSymptomsCarousel(`主題：${topic}`, list, Math.min(12, list.length || 1));
          await pushFlex(userId, `主題：${topic}（全部）`, flex);
        } catch (e) {
          console.error("[showall_topic_flex_fallback]", e);
          const msg = formatSymptomsAll(`主題：${topic}`, list, 50);
          await pushText(userId, msg);
        }
        return;
      }

      const ans = await postJSON(ANSWER_URL, {
        message: topic,
        q: topic,
        question: topic,
        email: gate.email,
        userId
      }, 30000);

      if (ans?.reply) {
        await pushText(userId, ans.reply);
        return;
      }

      const routerList = coerceList(ans);
      try {
        const flex = buildSymptomsCarousel(topic, routerList, Math.min(12, routerList.length || 1));
        await pushFlex(userId, `查詢：「${topic}」（全部）`, flex);
      } catch (e) {
        console.error("[showall_topic_router_fallback]", e);
        await pushText(userId, formatSymptomsAll(topic, routerList, 50));
      }
      return;
    }

    const ans = await postJSON(ANSWER_URL, {
      message: query,
      q: query,
      question: query,
      email: gate.email,
      userId
    }, 30000);

    if (ans?.reply) {
      await pushText(userId, ans.reply);
      return;
    }

    const list = coerceList(ans);

    try {
      const flex = buildSymptomsCarousel(query, list, Math.min(12, list.length || 1));
      await pushFlex(userId, `查詢：「${query}」（全部）`, flex);
    } catch (e) {
      console.error("[showall_symptom_flex_fallback]", e);
      const msgAll = formatSymptomsAll(query, list, 50);
      await pushText(userId, msgAll);
    }
    return;
  }

  /* ===== help ===== */
  if (/^(help|幫助|\?|指令)$/i.test(text)) {
    await replyText(replyToken, helpText());
    return;
  }

  /* ===== 綁定 ===== */
  if (/^綁定\s+/i.test(text) || isEmail(text)) {
    let email = text;
    if (/^綁定\s+/i.test(email)) email = normalizeText(email.replace(/^綁定\s+/i, ""));

    if (!isEmail(email)) {
      await replyText(replyToken, "請輸入正確 Email，例如：綁定 test@example.com");
      return;
    }

    const ok = await bindEmailToLine(userId, email);

    await replyText(
      replyToken,
      ok
        ? `✅ 已綁定 Email：${email}\n之後可直接輸入關鍵字查詢、簽到或寫心得。`
        : "綁定失敗：找不到此 Email 的會員，或該帳號已綁定其他 LINE。"
    );
    return;
  }

  /* ===== 狀態 ===== */
  if (/^(我的)?狀態$/i.test(text)) {
    const info = await getMemberInfoByLineId(userId);
    if (!info) {
      await replyText(replyToken, "尚未綁定 Email。請輸入：綁定 your@email.com");
      return;
    }

    const expText = info.expire ? fmtDate(info.expire) : "（未設定）";
    await replyText(
      replyToken,
      `📇 會員狀態\nEmail：${info.email || "（未設定或空白）"}\n狀態：${info.status || "（未設定）"}\n等級：${info.level || "（未設定）"}\n有效日期：${expText}\nLINE 綁定：${info.lineBind || "（未設定）"}`
    );
    return;
  }

  /* ===== 簽到 ===== */
  if (/^(簽到|打卡)(?:\s|$)/.test(text)) {
    const gate = await ensureMemberAllowed(userId);
    if (!gate.ok) {
      await replyText(replyToken, gate.hint);
      return;
    }

    const content = normalizeText(text.replace(/^(簽到|打卡)(?:\s|$)/, "")) || "簽到";
    const pageId = await writeRecord({ email: gate.email, userId, category: "簽到", content });

    await replyText(replyToken, `✅ 已簽到！\n內容：${content}\n(記錄ID: ${shortId(pageId)})`);
    return;
  }

  /* ===== 心得 ===== */
  if (/^心得(?:\s|$)/.test(text)) {
    const gate = await ensureMemberAllowed(userId);
    if (!gate.ok) {
      await replyText(replyToken, gate.hint);
      return;
    }

    const content = normalizeText(text.replace(/^心得(?:\s|$)/, ""));
    if (!content) {
      await replyText(replyToken, "請在「心得」後面接文字，例如：心得 今天的頸胸交界手感更清楚了");
      return;
    }

    const pageId = await writeRecord({ email: gate.email, userId, category: "心得", content });
    await replyText(replyToken, `📝 已寫入心得！\n${content}\n(記錄ID: ${shortId(pageId)})`);
    return;
  }

  /* ===== AI 產文 ===== */
  if (/^文案(?:\s|$)/.test(text)) {
    const gate = await ensureMemberAllowed(userId);
    if (!gate.ok) {
      await replyText(replyToken, gate.hint);
      return;
    }

    const topic = normalizeText(text.replace(/^文案(?:\s|$)/, ""));
    if (!topic) {
      await replyText(replyToken, "請在「文案」後面接主題，例如：文案 Lifewave X39 逆齡保養開頭文案");
      return;
    }

    await replyLoading(replyToken, `「${topic}」文案生成中…`);

    try {
      const { answer, latency_ms } = await generateCopyText(topic);

      if (!answer) {
        await pushText(userId, "產文失敗，請稍後再試。");
        return;
      }

      const pageId = await writeRecord({
        email: gate.email,
        userId,
        category: "AI產文",
        content: topic,
        source: "API"
      });

      await patchRecordById(pageId, {
        tip: answer,
        seg: undefined,
        routerType: "AI產文",
        matched: true,
        needReview: false,
        risk: "無",
        matchedKb: "AI產文",
        adminNote: ""
      });

      const msg = ["🪄 IG 開頭文案：", "", answer, "", `（延遲 ${latency_ms} ms）`].join("\n");
      await pushText(userId, msg);
    } catch (e) {
      console.error("[copy_gen_error]", e);
      await pushText(userId, "產文服務目前暫時無法使用，請稍後再試。");
    }
    return;
  }

  /* ===== 主題查詢：只有明確輸入「主題 XXX」才走主題查詢 ===== */
  const mTopic = /^主題(?:\s|:|：)?\s*(.+)$/i.exec(text);
  if (mTopic) {
    const topic = normalizeText(mTopic[1]);
    const itemsAsTopic = await queryQaByTopic(topic, 10);

    if (itemsAsTopic.length > 0) {
      await doTopicSearch(replyToken, userId, topic, itemsAsTopic);
      return;
    }

    await doRouterSearch(replyToken, userId, topic, {
      originalText: text,
      category: "教材查詢"
    });
    return;
  }

  /* ===== 直接輸入關鍵字，一律交給 answer.js Router ===== */
  await doRouterSearch(replyToken, userId, text, {
    originalText: text,
    category: "症狀查詢"
  });
}

/* ====== Router 查詢子流程 ====== */
async function doRouterSearch(replyToken, userId, queryText, options = {}) {
  const gate = await ensureMemberAllowed(userId);
  if (!gate.ok) {
    await replyText(replyToken, gate.hint);
    return;
  }

  const contentForRecord = options.originalText || queryText;
  const category = options.category || "症狀查詢";

  const pageId = await writeRecord({
    email: gate.email,
    userId,
    category,
    content: contentForRecord
  });

  await replyLoading(replyToken, `「${queryText}」查詢中，請稍候…`);

  const ans = await postJSON(ANSWER_URL, {
    message: queryText,
    q: queryText,
    question: queryText,
    email: gate.email,
    userId
  }, 30000);

  console.log("[answer_response]", JSON.stringify(ans, null, 2));
  console.log("[WEBHOOK_VERSION]", "AI_REPLY_DIRECT_V1_20260425");

  // ✅ 新版 answer.js：優先吃 reply
  if (ans?.reply) {
    const debug = ans?.debug || {};
    const matched = Number(debug?.knowledge_count || 0) > 0;

    await patchRecordById(pageId, {
      seg: "",
      tip: ans.reply,
      routerType: debug?.answer_mode || "AI知識庫融合",
      matched,
      needReview: !matched,
      risk: "無",
      matchedKb: debug?.normalized_question || queryText,
      adminNote: matched
        ? ""
        : "新版 AI 知識庫融合回覆：未命中啟用中知識庫資料，建議檢查關鍵字或新增教材。"
    });

    await pushText(userId, ans.reply);

    if (ans?.debug) {
      console.log("[answer_debug]", JSON.stringify(ans.debug, null, 2));
    }

    return;
  }

  // 舊版相容：如果 answer.js 還是回傳 results/items/answer，才走卡片
  const list = coerceList(ans);
  const first = list[0] || ans?.answer || {};

  const segFirst = getField(first, ["對應脊椎分節", "segments", "segment"]) || "";
  const tipFirst = getField(first, ["教材版回覆", "教材重點", "tips", "summary", "reply", "AI回覆"]) || "";
  const titleFirst = getField(first, ["問題", "question", "query"]) || "";
  const routerType = ans?.intent || getField(first, ["類型", "type", "intent", "AI判斷類型"]) || "未分類";
  const matched = list.length > 0;
  const risk = getRiskLabel(routerType, first);

  await patchRecordById(pageId, {
    seg: segFirst,
    tip: tipFirst,
    routerType,
    matched,
    needReview: !matched,
    risk,
    matchedKb: titleFirst,
    adminNote: matched ? "" : "系統未命中資料，建議檢查關鍵字或新增教材條目。"
  });

  try {
    const flex = buildSymptomsCarousel(queryText, list, 3);
    await pushFlex(userId, `查詢：「${queryText}」`, flex);

    if (list.length > 3) {
      await pushText(userId, "\n提示：輸入「顯示全部 關鍵字」可看更多");
    }
  } catch (e) {
    console.error("[router_push_fallback]", e);
    const out = formatSymptomsMessage(queryText, list, 3);
    await pushText(userId, out.text);
  }
}

/* ====== 主題查詢子流程 ====== */
async function doTopicSearch(replyToken, userId, topicRaw, itemsOptional) {
  const topic = normalizeText(topicRaw);
  const gate = await ensureMemberAllowed(userId);
  if (!gate.ok) {
    await replyText(replyToken, gate.hint);
    return;
  }

  await replyLoading(replyToken, `主題「${topic}」查詢中…`);

  const pageId = await writeRecord({
    email: gate.email,
    userId,
    category: "教材查詢",
    content: `主題 ${topic}`
  });

  const items = Array.isArray(itemsOptional) ? itemsOptional : await queryQaByTopic(topic, 10);
  const first = items[0] || {};
  const segFirst = getField(first, ["對應脊椎分節"]) || "";
  const tipFirst = getField(first, ["教材版回覆", "教材重點"]) || "";
  const titleFirst = getField(first, ["問題"]) || "";

  await patchRecordById(pageId, {
    seg: segFirst,
    tip: tipFirst,
    routerType: "教材查詢",
    matched: items.length > 0,
    needReview: items.length === 0,
    risk: "無",
    matchedKb: titleFirst,
    adminNote: items.length > 0 ? "" : "主題查詢未命中資料。"
  });

  try {
    const flex = buildSymptomsCarousel(`主題：${topic}`, items, 4);
    await pushFlex(userId, `主題：${topic}`, flex);

    if ((items || []).length > 4) {
      await pushText(userId, "\n提示：輸入「顯示全部 主題 XXX」可看更多");
    }
  } catch (e) {
    console.error("[topic_push_fallback]", e);
    const out = formatSymptomsMessage(`主題：${topic}`, items, 4);
    await pushText(userId, out.text);
  }
}

/* ====== QA_DB 查詢 ====== */
async function queryQaByTopic(topic, limit = 10) {
  if (!QA_DB_ID || !topic) return [];

  const r = await notionQueryDatabase(QA_DB_ID, {
    filter: {
      and: [
        { property: QA_TOPIC, select: { equals: topic } },
        { property: "是否啟用", checkbox: { equals: true } }
      ]
    },
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    page_size: limit
  });

  const pages = Array.isArray(r?.results) ? r.results : [];
  return pages.filter(isPageEnabled).map(pageToItem);
}

function isPageEnabled(page) {
  const prop = page?.properties?.["是否啟用"];

  if (!prop) return false;

  if (prop.type === "checkbox") {
    return prop.checkbox === true;
  }

  if (prop.type === "select") {
    return ["啟用", "使用", "是", "YES", "true"].includes(prop.select?.name || "");
  }

  if (prop.type === "status") {
    return ["啟用", "使用", "是", "YES", "true"].includes(prop.status?.name || "");
  }

  return false;
}

function pageToItem(page) {
  const p = page?.properties || {};
  const tText = (prop) => (prop?.title || []).map(t => t?.plain_text || "").join("").trim();
  const rText = (prop) => (prop?.rich_text || []).map(t => t?.plain_text || "").join("").trim();

  return {
    問題: tText(p[QA_QUESTION]) || rText(p[QA_QUESTION]) || "",
    主題: p[QA_TOPIC]?.select?.name || "",
    類型: p["類型"]?.select?.name || p[QA_TOPIC]?.select?.name || "教材查詢",
    對應脊椎分節: rText(p[QA_SEGMENT]) || "",
    教材版回覆: rText(p[QA_REPLY]) || "",
    教材重點: rText(p[QA_REPLY]) || "",
    臨床流程建議: rText(p[QA_FLOW]) || "",
    經絡與補充: rText(p[QA_MERIDIAN]) || "",
  };
}

/* ====== 症狀回覆格式 ====== */
function coerceList(ans) {
  if (Array.isArray(ans?.results)) return ans.results;
  if (Array.isArray(ans?.items)) return ans.items;

  // ✅ 新版 answer.js 是直接回 reply，不要硬轉成舊卡片
  if (ans?.reply) return [];

  if (ans?.answer && typeof ans.answer === "object") return [ans.answer];

  return [];
}

function getCardType(it) {
  return getField(it, ["類型", "type", "intent", "AI判斷類型"]) ||
         getField(it, ["主題", "topic"]) ||
         "查詢結果";
}

function formatSymptomsMessage(query, items, showN = 3) {
  const arr = items || [];
  const shown = arr.slice(0, showN);
  const moreCount = Math.max(0, arr.length - shown.length);
  const lines = [`🔎 查詢：「${query}」`];

  if (!shown.length) {
    lines.push(
      "", "#1 查詢結果",
      "・問題：—",
      "・教材重點：—",
      "・對應脊椎分節：—",
      "・臨床流程建議：—",
      "・經絡與補充：—",
      "・AI回覆：—",
      ""
    );
  } else {
    shown.forEach((it, idx) => {
      const cardType = getCardType(it);
      const q = getField(it, ["question", "問題", "query"]) || query;
      const key1 = getField(it, ["教材版回覆", "教材重點", "tips", "summary", "reply"]) || "—";
      const seg = getField(it, ["對應脊椎分節", "segments", "segment"]) || "—";
      const flow = getField(it, ["臨床流程建議", "flow", "process", "判斷流程"]) || "—";
      const mer = getField(it, ["經絡與補充", "meridians", "meridian", "經絡", "經絡強補充", "客戶溝通話術"]) || "—";
      const ai = getField(it, ["AI回覆", "ai_reply", "ai", "answer", "AI教學說法"]) || "—";

      lines.push(
        `${idx === 0 ? "\n" : ""}#${idx + 1} ${cardType}`,
        `・問題：${q}`,
        `・教材重點：${key1}`,
        `・對應脊椎分節：${seg}`,
        `・臨床流程建議：${flow}`,
        `・經絡與補充：${mer}`,
        `・AI回覆：${ai}`,
        ""
      );
    });
  }

  if (moreCount > 0) {
    lines.push("", `（還有 ${moreCount} 筆。你可輸入「顯示全部 …」查看全部。）`);
  }

  return { text: lines.join("\n"), moreCount };
}

function formatSymptomsAll(query, items, limit = 50) {
  const arr = (items || []).slice(0, limit);
  const lines = [`🔎 查詢：「${query}」`];

  if (!arr.length) {
    lines.push(
      "", "#1 查詢結果",
      "・問題：—",
      "・教材重點：—",
      "・對應脊椎分節：—",
      "・臨床流程建議：—",
      "・經絡與補充：—",
      "・AI回覆：—",
      ""
    );
  } else {
    arr.forEach((it, idx) => {
      const cardType = getCardType(it);
      const q = getField(it, ["question", "問題", "query"]) || query;
      const key1 = getField(it, ["教材版回覆", "教材重點", "tips", "summary", "reply"]) || "—";
      const seg = getField(it, ["對應脊椎分節", "segments", "segment"]) || "—";
      const flow = getField(it, ["臨床流程建議", "flow", "process", "判斷流程"]) || "—";
      const mer = getField(it, ["經絡與補充", "meridians", "meridian", "經絡", "經絡強補充", "客戶溝通話術"]) || "—";
      const ai = getField(it, ["AI回覆", "ai_reply", "ai", "answer", "AI教學說法"]) || "—";

      lines.push(
        `${idx === 0 ? "\n" : ""}#${idx + 1} ${cardType}`,
        `・問題：${q}`,
        `・教材重點：${key1}`,
        `・對應脊椎分節：${seg}`,
        `・臨床流程建議：${flow}`,
        `・經絡與補充：${mer}`,
        `・AI回覆：${ai}`,
        ""
      );
    });
  }

  return lines.join("\n");
}

function getField(obj, keys) {
  if (!obj) return "";
  for (const k of keys) {
    if (obj[k]) return String(obj[k]);
  }
  return "";
}

function getRiskLabel(routerType, first) {
  const riskText = getField(first, ["風險提醒", "risk", "風險標記"]) || "";
  const contraindication = getField(first, ["禁忌標記"]) || "";

  if (routerType === "禁忌風險") return "注意";
  if (/禁止|高風險|就醫|骨折|腫瘤|急性|感染/.test(`${riskText} ${contraindication}`)) return "紅旗";
  if (/注意|觀察|不適|風險/.test(`${riskText} ${contraindication}`)) return "注意";
  return "無";
}

/* ====== 會員狀態守門 ====== */
async function ensureMemberAllowed(userId) {
  const info = await getMemberInfoByLineId(userId);

  if (!info || !isEmail(info.email)) {
    return {
      ok: false,
      email: "",
      hint: "尚未綁定 Email。請輸入「綁定 你的Email」，例如：綁定 test@example.com"
    };
  }

  const statusName = String(info.status || "").trim();

  if (statusName && BLOCK_STATUS_NAMES.includes(statusName)) {
    return {
      ok: false,
      email: info.email,
      hint: `此帳號狀態為「${statusName}」，暫停使用查詢/簽到/心得功能。`
    };
  }

  if (CHECK_EXPIRE && info.expire) {
    const expDate = new Date(info.expire);
    const today = new Date(new Date().toDateString());

    if (String(expDate) !== "Invalid Date" && expDate < today) {
      return {
        ok: false,
        email: info.email,
        hint: `此帳號已過有效日期（${fmtDate(info.expire)}）。`
      };
    }
  }

  return { ok: true, email: info.email, status: info.status, expire: info.expire };
}

async function getMemberInfoByLineId(userId) {
  if (!MEMBER_DB || !userId) return null;

  const r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: MEMBER_LINE_PROP, rich_text: { equals: userId } },
    page_size: 1
  });

  if (!r?.results?.length) return null;

  const p = r.results[0]?.properties || {};
  const email = readPropEmail(p, MEMBER_EMAIL_PROP);
  const status = p[MEMBER_STATUS_PROP]?.select?.name || "";
  const level = p[MEMBER_LEVEL_PROP]?.select?.name || "";
  const expire = p[MEMBER_EXPIRE_PROP]?.date?.start || "";
  const lineBind = (p[MEMBER_LINE_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();

  return { email, status, level, expire, lineBind };
}

async function bindEmailToLine(userId, email) {
  if (!MEMBER_DB || !userId || !isEmail(email)) return false;

  let r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: MEMBER_EMAIL_PROP, email: { equals: email } },
    page_size: 1
  });

  if (!r?.results?.length) {
    r = await notionQueryDatabase(MEMBER_DB, {
      filter: { property: MEMBER_EMAIL_PROP, rich_text: { equals: email } },
      page_size: 1
    });
  }

  if (!r?.results?.length) {
    r = await notionQueryDatabase(MEMBER_DB, {
      filter: { property: MEMBER_EMAIL_PROP, title: { equals: email } },
      page_size: 1
    });
  }

  if (!r?.results?.length) return false;

  const page = r.results[0];
  const pageId = page.id;
  const props = page.properties || {};
  const existing = (props[MEMBER_LINE_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();

  if (existing) return existing === userId;

  return await notionPatchPage(pageId, {
    properties: {
      [MEMBER_LINE_PROP]: {
        rich_text: [{ text: { content: userId } }]
      }
    }
  });
}

/* ====== Notion 共用 ====== */
async function notionQueryDatabase(dbId, body) {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body || {})
  });

  try {
    return await r.json();
  } catch {
    return {};
  }
}

async function notionPatchPage(pageId, data) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data || {})
  });

  if (!r.ok) console.error("[notionPatchPage]", r.status, await safeText(r));
  return r.ok;
}

async function notionCreatePage(dbId, properties) {
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties
    })
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) console.error("[notionCreatePage]", r.status, j);

  return { ok: r.ok, json: j, status: r.status };
}

/* ====== 紀錄 DB 寫入／回填 ====== */
async function writeRecord({ email, userId, category, content, source = "LINE" }) {
  const nowISO = new Date().toISOString();
  const nowTW = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

  const props = {
    [REC_TITLE]: { title: [{ text: { content: `${category}｜${nowTW}` } }] },
    [REC_EMAIL]: { email },
    [REC_UID]: { rich_text: [{ text: { content: userId } }] },
    [REC_CATE]: { select: { name: category } },
    [REC_BODY]: { rich_text: [{ text: { content } }] },
    [REC_DATE]: { date: { start: nowISO } },
    [REC_SRC]: { rich_text: [{ text: { content: source } }] }
  };

  const { ok, json } = await notionCreatePage(RECORD_DB, props);

  if (!ok) console.error("[writeRecord] create failed", json);
  return json?.id || "";
}

async function patchRecordById(pageId, {
  seg,
  tip,
  routerType,
  matched,
  needReview,
  risk,
  matchedKb,
  adminNote
}) {
  if (!pageId) return;

  const page = await notionGetPage(pageId);
  const propsNow = page?.properties || {};
  const outProps = {};

  if (typeof seg !== "undefined" && propsNow[REC_SEG]) {
    outProps[REC_SEG] = buildPropValueByType(propsNow[REC_SEG], seg ?? "");
  }

  if (typeof tip !== "undefined" && propsNow[REC_AI]) {
    outProps[REC_AI] = buildPropValueByType(propsNow[REC_AI], tip ?? "");
  }

  if (typeof routerType !== "undefined" && propsNow[REC_AI_TYPE]) {
    outProps[REC_AI_TYPE] = buildPropValueByType(propsNow[REC_AI_TYPE], routerType ?? "");
  }

  if (typeof matched !== "undefined" && propsNow[REC_HIT]) {
    outProps[REC_HIT] = buildPropValueByType(propsNow[REC_HIT], Boolean(matched));
  }

  if (typeof needReview !== "undefined" && propsNow[REC_NEED_REVIEW]) {
    outProps[REC_NEED_REVIEW] = buildPropValueByType(propsNow[REC_NEED_REVIEW], Boolean(needReview));
  }

  if (propsNow[REC_ADD_TO_KB]) {
    outProps[REC_ADD_TO_KB] = buildPropValueByType(propsNow[REC_ADD_TO_KB], false);
  }

  if (typeof risk !== "undefined" && propsNow[REC_RISK]) {
    outProps[REC_RISK] = buildPropValueByType(propsNow[REC_RISK], risk || "無");
  }

  if (typeof matchedKb !== "undefined" && propsNow[REC_MATCHED_KB]) {
    outProps[REC_MATCHED_KB] = buildPropValueByType(propsNow[REC_MATCHED_KB], matchedKb || "");
  }

  if (typeof adminNote !== "undefined" && propsNow[REC_ADMIN_NOTE]) {
    outProps[REC_ADMIN_NOTE] = buildPropValueByType(propsNow[REC_ADMIN_NOTE], adminNote || "");
  }

  const keys = Object.keys(outProps);

  if (!keys.length) {
    console.warn("[patchRecordById] no matched properties to update");
    return;
  }

  const ok = await notionPatchPage(pageId, { properties: outProps });

  if (!ok) console.error("[patchRecordById] failed", outProps);
}

/* ====== Notion 輔助 ====== */
async function notionGetPage(pageId) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    }
  });

  try {
    return await r.json();
  } catch {
    return {};
  }
}

function buildPropValueByType(propItem, value) {
  if (!propItem || !propItem.type) {
    return { rich_text: [{ text: { content: String(value ?? "").slice(0, 1900) } }] };
  }

  switch (propItem.type) {
    case "title":
      return { title: [{ text: { content: String(value ?? "").slice(0, 1900) } }] };

    case "rich_text":
      return { rich_text: [{ text: { content: String(value ?? "").slice(0, 1900) } }] };

    case "select":
      return {
        select: {
          name: String(value ?? "").split(/[、,，\s]/).filter(Boolean)[0] || "—"
        }
      };

    case "multi_select":
      return {
        multi_select: String(value ?? "")
          .split(/[、,，\s]/)
          .filter(Boolean)
          .slice(0, 20)
          .map(n => ({ name: n }))
      };

    case "checkbox":
      return { checkbox: Boolean(value) };

    case "email":
      return { email: String(value ?? "") };

    case "date":
      return { date: { start: String(value || new Date().toISOString()) } };

    default:
      return { rich_text: [{ text: { content: String(value ?? "").slice(0, 1900) } }] };
  }
}

/* ====== OpenAI（產 IG 開頭文案） ====== */
async function getOpenAIClient() {
  if (!OPENAI_API_KEY) throw new Error("缺少 OPENAI_API_KEY");
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey: OPENAI_API_KEY });
}

function buildCopyPrompt(userTopic) {
  return [
    {
      role: "system",
      content: "你是一位溫柔、療癒、可信任的台灣行銷文案助手，請用 50–80 字寫 IG 貼文開頭，避免醫療/療效承諾字眼，結尾加 2–4 個 hashtag（繁體）。"
    },
    {
      role: "user",
      content: String(userTopic || "").trim()
    }
  ];
}

async function generateCopyText(topic) {
  const client = await getOpenAIClient();
  const started = Date.now();

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: buildCopyPrompt(topic),
    temperature: 0.7
  });

  const answer = completion?.choices?.[0]?.message?.content?.trim() || "";
  const latency = Date.now() - started;
  const tokens = completion?.usage || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };

  return { answer, latency_ms: latency, tokens };
}

/* ====== Flex 卡片 ====== */
function buildSymptomBubble(it, idx, queryLabel) {
  const q = getField(it, ["question", "問題", "query"]) || queryLabel || "查詢結果";

  const cardType =
    getField(it, ["類型", "type", "intent", "AI判斷類型"]) ||
    getField(it, ["主題", "topic"]) ||
    "查詢結果";

  const key1 = getField(it, ["教材版回覆", "教材重點", "tips", "summary", "reply"]) || "—";
  const seg = getField(it, ["對應脊椎分節", "segments", "segment"]) || "—";
  const flow = getField(it, ["臨床流程建議", "flow", "process", "判斷流程"]) || "—";
  const mer = getField(it, ["經絡與補充", "meridians", "meridian", "經絡", "經絡強補充", "客戶溝通話術"]) || "—";
  const ai = getField(it, ["AI回覆", "ai_reply", "ai", "answer", "AI教學說法"]) || "—";

  const lim = (s, n = 180) => String(s || "").length > n
    ? String(s).slice(0, n - 1) + "…"
    : String(s || "");

  return {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        { type: "text", text: `#${idx + 1} ${cardType}`, weight: "bold", size: "sm" },
        { type: "text", text: lim(q, 60), wrap: true, size: "md" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "6px",
      contents: [
        row("教材重點", lim(key1)),
        row("脊椎分節", lim(seg, 60)),
        row("臨床流程", lim(flow)),
        row("經絡補充", lim(mer)),
        { type: "separator", margin: "md" },
        row("AI回覆", lim(ai))
      ]
    }
  };

  function row(label, value) {
    return {
      type: "box",
      layout: "baseline",
      spacing: "sm",
      contents: [
        { type: "text", text: label, color: "#888888", size: "sm", flex: 2 },
        { type: "text", text: value || "—", wrap: true, size: "sm", flex: 5 }
      ]
    };
  }
}

function buildSymptomsCarousel(queryLabel, items = [], showN = 3) {
  const arr = (items || []).slice(0, Math.min(showN, 12));
  const bubbles = arr.map((it, i) => buildSymptomBubble(it, i, queryLabel));

  return {
    type: "carousel",
    contents: bubbles.length ? bubbles : [buildSymptomBubble({}, 0, queryLabel)]
  };
}

/* ====== LINE 回覆 / Push ====== */
async function replyFlex(replyToken, altText, flexContents, quickList = []) {
  if (!LINE_TOKEN) {
    console.warn("[replyFlex] missing LINE_CHANNEL_ACCESS_TOKEN");
    return;
  }

  const items = (quickList || [])
    .map(q => ({
      type: "action",
      action: {
        type: "message",
        label: q.label,
        text: q.text
      }
    }))
    .slice(0, 12);

  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{
        type: "flex",
        altText: String(altText || "查詢結果"),
        contents: flexContents,
        quickReply: items.length ? { items } : undefined
      }]
    })
  });

  if (!r.ok) console.error("[replyFlex]", r.status, await safeText(r));
}

async function replyText(replyToken, text) {
  if (!LINE_TOKEN) {
    console.warn("[replyText] missing LINE_CHANNEL_ACCESS_TOKEN");
    return;
  }

  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{
        type: "text",
        text: String(text || "").slice(0, 4900)
      }]
    })
  });

  if (!r.ok) console.error("[replyText]", r.status, await safeText(r));
}

async function replyLoading(replyToken, label = "正在查詢…") {
  const bubble = {
    type: "bubble",
    size: "kilo",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: "⌛ 作業中", weight: "bold" },
        {
          type: "text",
          text: String(label).slice(0, 120),
          wrap: true,
          size: "sm",
          color: "#666666"
        }
      ]
    }
  };

  return replyFlex(replyToken, "系統處理中", {
    type: "carousel",
    contents: [bubble]
  });
}

async function pushText(toUserId, text) {
  if (!LINE_TOKEN) {
    console.warn("[pushText] missing LINE_CHANNEL_ACCESS_TOKEN");
    return;
  }

  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({
      to: toUserId,
      messages: [{
        type: "text",
        text: String(text || "").slice(0, 4900)
      }]
    })
  });

  if (!r.ok) console.error("[pushText]", r.status, await safeText(r));
}

async function pushFlex(toUserId, altText, flexContents) {
  if (!LINE_TOKEN) {
    console.warn("[pushFlex] missing LINE_CHANNEL_ACCESS_TOKEN");
    return;
  }

  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({
      to: toUserId,
      messages: [{
        type: "flex",
        altText: String(altText || "查詢結果"),
        contents: flexContents
      }]
    })
  });

  if (!r.ok) console.error("[pushFlex]", r.status, await safeText(r));
}

/* ====== HTTP / 其他 ====== */
async function postJSON(url, body, timeoutMs = 30000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body || {}),
      signal: ac.signal
    });

    const txt = await r.text();
    let json;

    try {
      json = JSON.parse(txt);
    } catch {
      json = { raw: txt };
    }

    json.http = r.status;
    return json;
  } catch (e) {
    console.error("[postJSON]", e?.message || e);
    return {
      ok: false,
      error: e?.message || "fetch_failed"
    };
  } finally {
    clearTimeout(id);
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function readPropEmail(props, key) {
  if (!props || !key || !props[key]) return "";

  const e1 = props[key]?.email || "";
  if (e1 && isEmail(e1)) return e1.trim();

  const e2 = (props[key]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  if (e2 && isEmail(e2)) return e2;

  const e3 = (props[key]?.title || []).map(t => t?.plain_text || "").join("").trim();
  if (e3 && isEmail(e3)) return e3;

  return "";
}

/* ====== 說明 ====== */
function helpText() {
  return [
    "可用指令：",
    "• 綁定 your@email.com",
    "• 狀態 / 我的狀態",
    "• 簽到 [內容]",
    "• 心得 你的心得……",
    "• 文案 你的主題（自動生 IG 開頭）",
    "• 主題 基礎理論",
    "• 顯示全部 主題 基礎理論",
    "• 直接輸入教材問題或症狀關鍵字（例：半脫位、PD怎麼判斷、C1、手麻、為什麼不打痛點）"
  ].join("\n");
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

function shortId(id) {
  return id ? id.replace(/-/g, "").slice(0, 8) : "";
}
