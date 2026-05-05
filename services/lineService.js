const { safeText } = require("./textUtils");

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

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

module.exports = {
  replyText,
  pushText,
  replyFlex,
  pushFlex,
  replyLoading
};
