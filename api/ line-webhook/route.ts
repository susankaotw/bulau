import { NextRequest, NextResponse } from "next/server";

/** ===== env ===== */
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const GUARD_URL  = process.env.BULAU_GUARD_URL  || "https://bulau.vercel.app/api/guard";
const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const NOTION_API_KEY = process.env.NOTION_API_KEY!;
const RECORD_DB_ID   = process.env.RECORD_DB_ID!;

/** ===== webhook ===== */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const events: any[] = Array.isArray(body?.events) ? body.events : [];

    // 逐則處理，但不要阻塞回應
    const tasks = events.map((ev) => handleEvent(ev));
    // 做到回覆就好；寫 Notion 放在子流程，不 await（降低延遲）
    await Promise.allSettled(tasks.map(t => t.catch(() => {})));

    // 回 200 給 LINE
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[/api/line-webhook] error:", e?.message || e);
    // 仍回 200，避免 LINE 重送
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}

/** ===== 單則事件處理 ===== */
async function handleEvent(ev: any) {
  if (ev.type !== "message" || ev.message?.type !== "text") return;

  const replyToken: string = ev.replyToken;
  const userId: string = ev.source?.userId || "";
  const textRaw: string = ev.message?.text || "";
  const q = normalize(textRaw);

  // 1) 以 userId 換 email
  const email = await getEmailByUid(userId);
  if (!email) {
    await replyText(replyToken, "❗尚未綁定 Email，請輸入：綁定 email your@mail.com");
    return;
  }

  // 2) 查答案（同時帶 q & question，避免欄位名差異）
  const ans = await postJSON(ANSWER_URL, { q, question: q, email });
  const results = Array.isArray(ans?.results) ? ans.results : [];

  let msg = "";
  let seg = "—";
  let tip = "—";
  let mer = "—";

  if (results.length) {
    const r = results[0] || {};
    seg = r.segments || r.segment || "—";
    tip = r.tips || r.summary || r.reply || "—";
    mer = (Array.isArray(r.meridians) && r.meridians.length) ? r.meridians.join("、") : "—";
    msg = [
      `🔎 查詢：「${q}」`,
      `對應脊椎分節：${seg}`,
      `經絡與補充：${mer}`,
      `教材重點：${tip}`
    ].join("\n");
  } else if (ans?.answer?.臨床流程建議) {
    seg = ans.answer.對應脊椎分節 || "—";
    tip = ans.answer.臨床流程建議 || "—";
    msg = `🔎 查詢：「${q}」\n建議分節：${seg}\n臨床流程：${tip}`;
  } else {
    msg = `找不到「${q}」的教材內容。\n可改試：肩頸、頭暈、胸悶、胃痛、腰痠。`;
  }

  // 3) 先回使用者
  await replyText(replyToken, msg);

  // 4) 背景寫入紀錄（不 await）
  void writeRecord({
    email, userId, category: "症狀查詢", content: textRaw,
    seg, tip, statusCode: typeof ans?.http === "number" ? String(ans.http) : "200"
  }).catch((e) => console.error("[writeRecord]", e?.message || e));
}

/** ===== 小工具們 ===== */
function normalize(s: string) {
  if (!s) return "";
  let t = String(s).replace(/\u3000/g, " ").replace(/\s+/g, "");
  if (t === "肩") t = "肩頸";
  return t;
}

async function getEmailByUid(uid: string): Promise<string> {
  if (!uid) return "";
  try {
    const r = await postJSON(GUARD_URL, { uid });
    if (r?.ok && r?.email) return String(r.email).trim().toLowerCase();
    return "";
  } catch { return ""; }
}

async function postJSON(url: string, body: any) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  let json: any;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  if (!r.ok) json.http = r.status;
  return json;
}

async function replyText(replyToken: string, text: string) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: String(text).slice(0, 4900) }],
    }),
  });
}

/** ===== Notion 寫入：不老會員紀錄 DB ===== */
async function writeRecord(opts: {
  email: string; userId: string; category: string; content: string;
  seg?: string; tip?: string; statusCode?: string;
}) {
  if (!NOTION_API_KEY || !RECORD_DB_ID) return; // 未設定就略過
  const nowISO = new Date().toISOString();

  const payload = {
    parent: { database_id: RECORD_DB_ID },
    properties: {
      "標題": { title: [{ text: { content: `${opts.category}｜${toTW(nowISO)}` } }] },
      "Email": { email: opts.email },
      "UserId": { rich_text: [{ text: { content: opts.userId } }] },
      "類別": { select: { name: opts.category } },
      "內容": { rich_text: [{ text: { content: opts.content } }] },
      "日期": { date: { start: nowISO } },
      "來源": { rich_text: [{ text: { content: "LINE" } }] },
      // 下面三個是選配欄位，有就寫入
      ...(opts.seg ? { "對應脊椎分節": { rich_text: [{ text: { content: opts.seg } }] } } : {}),
      ...(opts.tip ? { "AI回覆": { rich_text: [{ text: { content: opts.tip.slice(0, 2000) } }] } } : {}),
      ...(opts.statusCode ? { "API回應碼": { rich_text: [{ text: { content: opts.statusCode } }] } } : {}),
    }
  };

  await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

function toTW(iso: string) {
  try {
    return new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  } catch { return iso; }
}
