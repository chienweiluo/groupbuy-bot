// reminder.js — 每日提醒。移植自舊 sendWithSheet + sendLineNotification,
// 改成查 DB、推播到「白名單會話」、加 daily_runs 去重與 >50 團分批保護。

import { getUpcomingToRemind, DEFAULT_TENANT, WINDOW_DAYS } from "./campaigns.js";
import { buildReminderMessages } from "./messages.js";
import { pushTo } from "./lineClient.js";
import { listAllowed, claimDailyRun, getDailyRun } from "./db.js";
import { today } from "./dates.js";

/**
 * 跑單一「白名單會話」的每日提醒。campaigns 取自 DEFAULT_TENANT。
 * @param {string} conversationId - 要推播到的會話(群/room/user id)
 * @param {object} opts
 * @param {boolean} opts.force - true 表示手動觸發,略過 daily_runs 去重
 * @param {boolean} opts.silentWhenEmpty - 沒團時不送「已處理完」訊息
 * @param {string}  opts.slot - 班次標記(am/pm),讓同日不同班次各自去重
 * @returns {object} { count, sent, reason? }
 */
export async function runDailyReminder(conversationId, opts = {}) {
  const { force = false, silentWhenEmpty = false, slot = "" } = opts;
  // 去重 key:日期(+班次)× 會話
  const runKey = today().format("YYYY-MM-DD") + (slot ? `#${slot}` : "");

  if (!force) {
    const got = claimDailyRun(runKey, conversationId, 0);
    if (!got) {
      const prev = getDailyRun(runKey, conversationId);
      return { count: prev?.sent_count ?? 0, sent: false, reason: "already_ran" };
    }
  }

  const list = getUpcomingToRemind(DEFAULT_TENANT, WINDOW_DAYS);
  if (!list.length && silentWhenEmpty) {
    return { count: 0, sent: false, reason: "empty_silent" };
  }

  await pushTo(conversationId, buildReminderMessages(list));
  return { count: list.length, sent: true };
}

/** 對所有白名單會話跑每日提醒(scheduler 用)。 */
export async function runDailyForAllAllowed(opts = {}) {
  const convs = listAllowed();
  const results = [];
  for (const c of convs) {
    try {
      results.push({ conversationId: c.conversation_id, ...(await runDailyReminder(c.conversation_id, opts)) });
    } catch (err) {
      console.error(`[reminder] conversation ${c.conversation_id} failed:`, err);
      results.push({ conversationId: c.conversation_id, sent: false, error: err.message });
    }
  }
  if (!convs.length) console.warn("[reminder] 白名單是空的,沒有任何會話會收到提醒");
  return results;
}
