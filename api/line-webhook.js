// api/line-webhook.js — robust echo + logs + reply fallback push

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") return res.status(200).send("OK"); // LINE Verify

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, reason: "method_not_allowed" });
    }

    // --- 0) 基本健檢：環境變數是否有值（不印出 token 本身） ---
    if (!LINE_TOKEN) {
      console.error("[env] LINE_CHANNEL_ACCESS_TOKEN is EMPTY (check Production env + redeploy)");
    } else {
      console.log("[env] LINE_CHANNEL_ACCESS_TOKEN length =", LINE_TOKEN.length);
    }

    // --- 1) 解析 body（若 req.body 為空就讀 raw body） ---
    let body = req.body;
    if (!body || typeof body === "string") {
      let raw = typeof body === "string" ? body : "";
      if (!raw) {
        raw = await readRawBody(req).catch(() => "");
      }
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }

    const events = Array.isArray(body?.events) ? body.events : [];
    console.log("[webhook] events count =", events.length);

    if (!events.length) {
      return res.status(200).json({ ok: true, note: "no_events" });
    }

    // --- 2) 逐則處理（等待完成，避免 Vercel 提早釋放執行環境） ---
    for (const ev of events) {
      await handleEvent(ev).catch(err => {
        console.error("[event_error]", err && (err.stack || err.message || err));
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[handler_crash]", e && (e.stack || e.message || e));
    return res.status(200).json({ ok: false });
  }
};

async function handleEvent(ev) {
  console.log("[event]", ev?.type, ev?.source?.userId, ev?.message?.type, ev?.message?.text);

  if (ev?.type !== "message" || ev?.message?.type !== "text") return;

  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";
  const text = String(ev.message?.text || "");

  // --- 3) 先嘗試 reply ---
  const replyOk = await replyText(replyToken, `✅ webhook OK\n你說：「${text}」`);
  if (replyOk) return; // 成功就結束

  // --- 4) reply 失敗，改用 push 當備援（常見於 token 無效 / replyToken過期） ---
  if (userId) {
    await pushText(userId, `✅ webhook OK（push）\n你說：「${text}」`);
  }
}

/** 讀 raw body（防某些情況 req.body 為空） */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** 呼叫 LINE Reply API，回傳 boolean 表示是否成功 */
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
      return false;
    }
    console.log("[replyText] ok");
    return true;
  } catch (e) {
    console.error("[replyText_error]", e && (e.message || e));
    return false;
  }
}

/** 備援：用 push 發訊息（需 token 有 Push 權限） */
async function pushText(to, text) {
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LINE_TOKEN}`
      },
      body: JSON.stringify({
        to,
        messages: [{ type: "text", text: String(text).slice(0, 4900) }]
      })
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("[pushText] http", r.status, t);
    } else {
      console.log("[pushText] ok");
    }
  } catch (e) {
    console.error("[pushText_error]", e && (e.message || e));
  }
}
