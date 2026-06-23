// scheduler.js — node-cron 排程:每日提醒 + 每月(含每年)結算。
// 跑在同一個 web 程序內,時區由 TZ 決定。

import cron from "node-cron";
import { runDailyForAllAllowed } from "./reminder.js";
import { runMonthlySettlement } from "./settlement.js";

const TZ = process.env.TZ || "Asia/Taipei";
const CRON_DAILY = process.env.CRON_DAILY || "0 9 * * *";
const CRON_DAILY_PM = process.env.CRON_DAILY_PM || "0 18 * * *";
const CRON_MONTHLY = process.env.CRON_MONTHLY || "0 9 1 * *";

export function startScheduler() {
  if (!cron.validate(CRON_DAILY) || !cron.validate(CRON_DAILY_PM) || !cron.validate(CRON_MONTHLY)) {
    console.error("[scheduler] 無效的 cron 設定,排程未啟動", { CRON_DAILY, CRON_DAILY_PM, CRON_MONTHLY });
    return;
  }

  // 早上班次:沒團時會送「已處理完」訊息
  cron.schedule(
    CRON_DAILY,
    async () => {
      console.log("[scheduler] 每日提醒觸發 (am)");
      try {
        const results = await runDailyForAllAllowed({ slot: "am" });
        console.log("[scheduler] 每日提醒完成 (am)", results);
      } catch (err) {
        console.error("[scheduler] 每日提醒失敗 (am):", err);
      }
    },
    { timezone: TZ }
  );

  // 傍晚班次:再 nudge 一次尚未打勾的團;若全部都處理完了就安靜不發
  cron.schedule(
    CRON_DAILY_PM,
    async () => {
      console.log("[scheduler] 每日提醒觸發 (pm)");
      try {
        const results = await runDailyForAllAllowed({ slot: "pm", silentWhenEmpty: true });
        console.log("[scheduler] 每日提醒完成 (pm)", results);
      } catch (err) {
        console.error("[scheduler] 每日提醒失敗 (pm):", err);
      }
    },
    { timezone: TZ }
  );

  cron.schedule(
    CRON_MONTHLY,
    async () => {
      console.log("[scheduler] 月結觸發");
      try {
        await runMonthlySettlement();
        console.log("[scheduler] 月結完成");
      } catch (err) {
        console.error("[scheduler] 月結失敗:", err);
      }
    },
    { timezone: TZ }
  );

  console.log(
    `[scheduler] 已啟動 (TZ=${TZ}) daily-am="${CRON_DAILY}" daily-pm="${CRON_DAILY_PM}" monthly="${CRON_MONTHLY}"`
  );
}
