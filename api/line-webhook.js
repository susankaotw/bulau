// api/line-webhook.js — Minimal safe handler to pass Verify
async function handler(req, res) {
  try {
    // 1) GET/HEAD 直接 200（部分 Verify 會用 GET）
    if (req.method === "GET" || req.method === "HEAD") {
      return res.status(200).send("OK");
    }

    // 2) 只接受 POST，其他也回 200 避免 LINE 重送
    if (req.method !== "POST") {
      console.log("[webhook] non-POST:", req.method);
      return res.status(200).json({ ok: true, note: "non-post" });
    }

    // 3) 解析 body（不會讓錯誤拋出）
    let body = req.body;
    if (!body || typeof body === "string") {
      let raw = typeof body === "string" ? body : await safeReadRaw(req);
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }

    const events = Array.isArray(body?.events) ? body.events : [];
    console.log("[verify] method=POST events.len=", events.length);

    // 4) 不做任何外部呼叫，避免 500；一定回 200
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[minimal_crash]", e?.stack || e?.message || e);
    // 仍回 200，避免 Verify 判定失敗
    return res.status(200).json({ ok: true, note: "handled" });
  }
}

function safeReadRaw(req) {
  return new Promise((resolve) => {
    try {
      let data = "";
      req.on("data", c => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", () => resolve(""));
    } catch {
      resolve("");
    }
  });
}

// 同時支援 CJS/ESM
module.exports = handler;
export default handler;
