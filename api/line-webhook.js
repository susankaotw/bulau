// api/line-webhook.js — Stage 0: minimal, never crashes
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") return res.status(200).send("OK");
    if (req.method !== "POST") return res.status(405).json({ ok: false });

    let body = req.body || {};
    if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }

    const events = Array.isArray(body.events) ? body.events : [];
    if (!events.length) {
      console.log("[webhook] no events");
      return res.status(200).json({ ok: true, note: "no_events" });
    }

    for (const ev of events) {
      try {
        console.log("[event]", ev.type, ev.source?.userId, ev.message?.type, ev.message?.text);
        if (ev.type === "message" && ev.message?.type === "text") {
          // 直接回固定文字，先確保 reply 正常
          await replyText(ev.replyToken, `✅ webhook OK\n你說：「${ev.message.text}」`);
        }
      } catch (e) {
        console.error("[event_error]", e && (e.stack || e.message || e));
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[handler_crash]", e && (e.stack || e.message || e));
    return res.status(200).json({ ok: false }); // 仍回200避免 LINE 一直重送
  }
};

async function replyText(replyToken, text) {
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LINE_TOKEN}`
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text: String(text).slice(0, 4900) }]
      })
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("[replyText] http", r.status, t);
    }
  } catch (e) {
    console.error("[replyText_error]", e && (e.stack || e.message || e));
  }
}
