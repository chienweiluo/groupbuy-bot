// lineClient.js — LINE Messaging API 封裝。push / broadcast / reply,
// 自動把訊息分批(LINE 單次最多 5 則)。

import { messagingApi } from "@line/bot-sdk";
import { recordBotMessage } from "./db.js";

export const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const USE_BROADCAST = String(process.env.LINE_USE_BROADCAST || "false") === "true";
const MAX_PER_REQUEST = 5;

function batch(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i += MAX_PER_REQUEST) {
    out.push(messages.slice(i, i + MAX_PER_REQUEST));
  }
  return out;
}

// 記下 bot 發出的訊息 ID,讓使用者「Reply 引用 bot 訊息」時能被辨識
function recordSent(res, conversationId) {
  for (const m of res?.sentMessages ?? []) recordBotMessage(m.id, conversationId);
}

/** reply 只能用一次、最多 5 則 */
export async function replyTo(replyToken, messages) {
  const arr = (Array.isArray(messages) ? messages : [messages]).slice(0, MAX_PER_REQUEST);
  const res = await lineClient.replyMessage({ replyToken, messages: arr });
  recordSent(res, null);
  return res;
}

/** push 給特定 target(userId / groupId),> 5 則自動分批多次送 */
export async function pushTo(target, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  for (const group of batch(arr)) {
    const res = await lineClient.pushMessage({ to: target, messages: group });
    recordSent(res, target);
  }
}

/** broadcast 給所有好友,> 5 則自動分批 */
export async function broadcast(messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  for (const group of batch(arr)) {
    await lineClient.broadcastMessage({ messages: group });
  }
}

/**
 * 對某租戶送出主動訊息:USE_BROADCAST=true 走 broadcast,否則 push 給 target。
 * target 解析順序:傳入 target → tenant.line_target_id → env LINE_TARGET_ID。
 */
export async function deliver(messages, { target } = {}) {
  if (USE_BROADCAST) return broadcast(messages);
  const to = target || process.env.LINE_TARGET_ID;
  if (!to) {
    console.warn("[deliver] 沒有推播對象(LINE_TARGET_ID 未設且 tenant 未註冊),略過");
    return;
  }
  return pushTo(to, messages);
}

export { USE_BROADCAST };
