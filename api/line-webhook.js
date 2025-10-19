// api/line-webhook.js
// 功能：綁定、查會員狀態、簽到、心得、症狀查詢（呼叫 ANSWER_URL）
// 修正：中文指令不用 \b；支援 Email 欄為 Email/RichText/Title；
// 新增：症狀查詢回覆格式化為多段列點（與你截圖一致）

const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const RECORD_DB  = process.env.RECORD_DB_ID || "";
const MEMBER_DB  = process.env.NOTION_MEMBER_DB_ID || "";
const NOTION_VER = "2022-06-28";
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

const EMAIL_PROP = process.env.MEMBER_EMAIL_PROP || "Email";        // 你的 Email 欄名（會員 DB 現為 Title）
const LINE_PROP  = process.env.MEMBER_LINE_PROP  || "LINE UserId";  // 你的 LINE 欄名

const trim = (s) => String(s || "").trim();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
function normalizeText(input) {
  return trim(String(input || "")
    .replace(/\u3000/g, " ") // 全形空白 → 半形
    .replace(/\s+/g, " ")    // 多空白縮一格
  );
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const action = String(req.query?.action || "");
      if (action === "health")     return res.status(200).json(await doHealthCheck());
      if (action === "test-write") return res.status(200).json(await testMinimalWrite());
      return res.status(200).send("OK");
    }
    if (req.method !== "POST") return res.status(405).json({ ok:false, reason:"method_not_allowed" });

    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const ev of events) {
      try { await handleEvent(ev); } catch (e) { console.error("[event_error]", e); }
    }
    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error("[handler_crash]", e);
    return res.status(200).json({ ok:false, error:e?.message || "unknown_error" });
  }
};

async function handleEvent(ev) {
  if (ev.type !== "message" || ev.message?.type !== "text") return;
  const raw = ev.message.text;
  const text = normalizeText(raw);
  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";

  // help
  if (/^(help|幫助|\?|指令)$/i.test(text)) { await replyText(replyToken, helpText()); return; }

  // 綁定
  if (/^綁定\s+/i.test(text) || isEmail(text)) {
    let email = text;
    if (/^綁定\s+/i.test(email)) email = normalizeText(email.replace(/^綁定\s+/i, ""));
    if (!isEmail(email)) { await replyText(replyToken, "請輸入正確 Email，例如：綁定 test@example.com"); return; }
    const ok = await bindEmailToLine(userId, email);
    if (!ok) { await replyText(replyToken, "綁定失敗：找不到此 Email 的會員，或該帳號已綁定其他 LINE。"); return; }
