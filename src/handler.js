// handler.js — LINE webhook 事件路由:follow(註冊推播對象)、postback(OK/消歧選擇)、
// message(自然語言 或 / 結構化指令)。

import { ask } from "./anthropic.js";
import {
  checkLinkSent,
  moveCampaign,
  cancelCampaign,
  backfillRevenue,
  createCampaign,
  findCampaigns,
  getCampaign,
  getUpcomingToRemind,
  monthlyStats,
  DEFAULT_TENANT,
} from "./campaigns.js";
import { recordSighting, isAllowed, isBotMessage } from "./db.js";
import { replyTo } from "./lineClient.js";
import { textMessage, buildReminderMessages } from "./messages.js";
import { parseInputDate, INVALID } from "./dates.js";

const HELP = `團購開團助手用法(在群組裡 @我 + 內容):
① 自然語言就行:
  「新增 潔淨學 x Julia的實驗廚房 3/2-3/8」
  「把潔淨學那團改到 4/10」
  「取消潔淨學那團」
  「回填 潔淨學 業績 12000 分潤 1800」
  「這個月有哪些團」
② 指令(備用):
  /add 廠商|團主|開始日|結束日|分類(選填)
  /move <id> <日期>
  /cancel <id>
  /revenue <id> <業績> [分潤]
  /list [YYYY-MM]
  /check  立即檢查今天要準備的團
每天會自動提醒未來七天要開、且還沒給連結的團,點卡片上的 OK ✅ 就打勾。`;

export async function handleEvent(event) {
  const tenantId = DEFAULT_TENANT;
  const src = event.source ?? {};
  const actor = src.userId ?? null;
  const conversationId =
    src.type === "group" ? src.groupId : src.type === "room" ? src.roomId : src.userId ?? null;
  const isGroup = src.type === "group" || src.type === "room";

  // 記下所有見過的會話(即使尚未啟用),方便之後把它的 ID 加進白名單
  if (conversationId) recordSighting({ conversationId, type: src.type, actor });

  const allowed = isAllowed(conversationId);

  // === 白名單把關:不在白名單的會話,不啟用任何功能 ===
  if (!allowed) {
    const mentioned = event.type === "message" && botWasMentioned(event.message ?? {});
    // 只有在「被加進群組(join)」或「群組裡被 @」時回一句提示並附上會話 ID;其餘一律靜默
    if (event.type === "join" || (isGroup && mentioned)) {
      return replyTo(event.replyToken, [
        textMessage(`這個會話還沒啟用喔 🙅\n已記下它的 ID:\n${conversationId}\n請管理員把它加入白名單後就能用所有功能。`),
      ]);
    }
    return;
  }

  // === 以下為「白名單會話」,啟用全部功能 ===

  if (event.type === "join") {
    return replyTo(event.replyToken, [
      textMessage("嗨!這個群已啟用 ✅ 我會每天提醒你未來七天要開的團 🛎️\n\n" + HELP),
    ]);
  }

  if (event.type === "postback") {
    return handlePostback(event, { tenantId, actor });
  }

  if (event.type === "message" && event.message.type === "text") {
    // 去掉 @Sheep Bot 提及文字,讓「@bot /check」與「/check」一致
    const mentioned = botWasMentioned(event.message);
    // 使用者用 LINE「Reply」引用了 bot 自己發的訊息 → 也視同呼叫 bot
    const repliedToBot = isBotMessage(event.message.quotedMessageId);
    const text = stripMentions(event.message).trim();
    if (!text) return;

    // 群組裡:沒被 @、沒 Reply bot、又不是指令的閒聊不回應(1:1 白名單會話則一律回)
    if (isGroup && !mentioned && !repliedToBot && !text.startsWith("/")) return;

    if (text.startsWith("/")) return handleCommand(event, text, { tenantId, actor });
    return handleNaturalLanguage(event, text, { tenantId, actor });
  }
}

function botWasMentioned(message) {
  const mentionees = message.mention?.mentionees;
  if (!mentionees?.length) return false;
  return mentionees.some((m) => m.type === "user" && m.isSelf);
}

function stripMentions(message) {
  const text = message.text ?? "";
  const mentionees = message.mention?.mentionees;
  if (!mentionees?.length) return text.trim();
  const sorted = [...mentionees].sort((a, b) => b.index - a.index);
  let result = text;
  for (const m of sorted) {
    result = result.slice(0, m.index) + result.slice(m.index + m.length);
  }
  return result.trim();
}

// ---------- postback ----------
async function handlePostback(event, { tenantId, actor }) {
  const params = new URLSearchParams(event.postback?.data ?? "");
  const action = params.get("action");

  if (action === "checked") {
    const id = Number(params.get("campaignId"));
    const res = checkLinkSent(id, actor, tenantId);
    return replyTo(event.replyToken, [textMessage(checkReplyText(res))]);
  }

  if (action === "move") {
    const id = Number(params.get("id"));
    const start = params.get("start");
    const res = moveCampaign(id, start, start, actor, tenantId);
    return replyTo(event.replyToken, [
      textMessage(res.ok ? `✅ 已改期:${fmt(res.campaign)} → ${start}` : `⚠️ ${res.error}`),
    ]);
  }

  if (action === "cancel") {
    const id = Number(params.get("id"));
    const res = cancelCampaign(id, actor, tenantId);
    return replyTo(event.replyToken, [
      textMessage(res.ok ? `🗑️ 已取消:${fmt(res.campaign)}` : `⚠️ ${res.error}`),
    ]);
  }

  if (action === "backfill") {
    const id = Number(params.get("id"));
    const revenue = params.has("rev") ? Number(params.get("rev")) : undefined;
    const commission = params.has("com") ? Number(params.get("com")) : undefined;
    const res = backfillRevenue(id, { revenue, commission }, actor, tenantId);
    return replyTo(event.replyToken, [
      textMessage(res.ok ? `💰 已回填:${fmt(res.campaign)}` : `⚠️ ${res.error}`),
    ]);
  }

  return replyTo(event.replyToken, [textMessage("這個按鈕我看不懂 🤔")]);
}

function checkReplyText(res) {
  switch (res.status) {
    case "checked":
      return `✅ 已記錄:${fmt(res.campaign)} 連結已給!`;
    case "already":
      return `這團先前已完成 ✅(${fmt(res.campaign)})`;
    case "inactive":
      return `這團已取消囉,不用處理(${fmt(res.campaign)})`;
    default:
      return "找不到這個團,可能資料已變動 🤔";
  }
}

// ---------- 自然語言 ----------
async function handleNaturalLanguage(event, text, { tenantId, actor }) {
  const { text: reply, extraMessages } = await ask({ userText: text, actor, tenantId });
  const messages = [textMessage(reply), ...extraMessages].slice(0, 5);
  return replyTo(event.replyToken, messages);
}

// ---------- / 結構化指令 ----------
async function handleCommand(event, text, { tenantId, actor }) {
  const [cmd, ...rest] = text.split(/\s+/);
  const argStr = text.slice(cmd.length).trim();

  if (cmd === "/help") return reply(event, HELP);

  if (cmd === "/check") {
    // 手動檢查:直接把卡片回在「當下這個聊天室」,而不是 push 到註冊對象
    const list = getUpcomingToRemind(tenantId);
    return replyTo(event.replyToken, buildReminderMessages(list).slice(0, 5));
  }

  if (cmd === "/add") {
    const [vendor, kol, start, end, category] = argStr.split("|").map((s) => s?.trim());
    if (!vendor || !kol || !start) return reply(event, "格式:/add 廠商|團主|開始日|結束日|分類(選填)");
    const startIso = parseInputDate(start);
    const endIso = end ? parseInputDate(end) : startIso;
    if (startIso === INVALID) return reply(event, "開始日無法解析,例:2026-03-02");
    const res = createCampaign(
      { vendor, kol, startDate: startIso, endDate: endIso, category, tenantId },
      actor
    );
    return reply(event, res.ok ? `✅ 已新增:${fmt(res.campaign)}` : `⚠️ ${res.error}`);
  }

  if (cmd === "/move") {
    const id = Number(rest[0]);
    const date = parseInputDate(rest[1]);
    if (!id || date === INVALID) return reply(event, "格式:/move <id> <日期>");
    const res = moveCampaign(id, date, date, actor, tenantId);
    return reply(event, res.ok ? `✅ 已改期:${fmt(res.campaign)} → ${date}` : `⚠️ ${res.error}`);
  }

  if (cmd === "/cancel") {
    const id = Number(rest[0]);
    if (!id) return reply(event, "格式:/cancel <id>");
    const res = cancelCampaign(id, actor, tenantId);
    return reply(event, res.ok ? `🗑️ 已取消:${fmt(res.campaign)}` : `⚠️ ${res.error}`);
  }

  if (cmd === "/revenue") {
    const id = Number(rest[0]);
    const revenue = rest[1] !== undefined ? Number(rest[1]) : undefined;
    const commission = rest[2] !== undefined ? Number(rest[2]) : undefined;
    if (!id || revenue === undefined) return reply(event, "格式:/revenue <id> <業績> [分潤]");
    const res = backfillRevenue(id, { revenue, commission }, actor, tenantId);
    return reply(event, res.ok ? `💰 已回填:${fmt(res.campaign)}` : `⚠️ ${res.error}`);
  }

  if (cmd === "/list") {
    const month = rest[0];
    if (month) {
      const s = monthlyStats(month, tenantId);
      const kols = s.byKol.map((k) => `  ${k.kol}: ${k.n}`).join("\n") || "  (無)";
      return reply(
        event,
        `${s.month} 開團數:${s.total}\n業績:${s.revenue} / 分潤:${s.commission}\n團主分佈:\n${kols}`
      );
    }
    const list = findCampaigns({ status: "active", tenantId, limit: 20 });
    const lines = list.map((c) => `#${c.id} ${c.startDate} ${c.vendor}/${c.kol} ${c.linkSent ? "✅" : "⬜"}`);
    return reply(event, lines.length ? lines.join("\n") : "目前沒有 active 的團。");
  }

  return reply(event, `未知指令。\n${HELP}`);
}

// ---------- helpers ----------
function reply(event, text) {
  return replyTo(event.replyToken, [textMessage(text)]);
}

function fmt(c) {
  if (!c) return "(未知團)";
  return `#${c.id} ${c.vendor}/${c.kol}(${c.startDate})`;
}
