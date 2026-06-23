// settlement.js — 月/年結算。統計開團數(以 start_date 落在期間計),組激勵訊息推播。

import { monthlyStats, DEFAULT_TENANT } from "./campaigns.js";
import { pushTo } from "./lineClient.js";
import { listAllowed } from "./db.js";
import { dayjs, lastMonth } from "./dates.js";

function trend(curr, prev) {
  const diff = curr - prev;
  if (diff > 0) return `比前月多 ${diff} 團 📈 衝啊!`;
  if (diff < 0) return `比前月少 ${-diff} 團,下個月補回來 💪`;
  return "跟前月持平,穩住 ✊";
}

/** 上個月的激勵總結文字 */
export function buildMonthlySummaryText(tenantId = DEFAULT_TENANT, base = dayjs()) {
  const lm = lastMonth(base); // 'YYYY-MM'
  const lmBefore = base.subtract(2, "month").format("YYYY-MM");
  const s = monthlyStats(lm, tenantId);
  const prev = monthlyStats(lmBefore, tenantId);

  const topKol = s.byKol[0] ? `🏆 主力團主:${s.byKol[0].kol}(${s.byKol[0].n} 團)` : "";
  const revLine =
    s.revenue || s.commission
      ? `\n已回填業績:${s.revenue} / 分潤:${s.commission}`
      : "";

  return [
    `📊 ${s.month} 月結出爐!`,
    `這個月你開了 ${s.total} 團 🎉`,
    trend(s.total, prev.total),
    topKol,
  ]
    .filter(Boolean)
    .join("\n") + revLine;
}

/** 年度總結文字(每年 1 月用) */
export function buildYearlySummaryText(tenantId = DEFAULT_TENANT, base = dayjs()) {
  const year = base.subtract(1, "month").year(); // 1 月觸發時結算去年
  let total = 0;
  const monthly = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, "0")}`;
    const n = monthlyStats(ym, tenantId).total;
    total += n;
    monthly.push(n);
  }
  const best = monthly.indexOf(Math.max(...monthly)) + 1;
  return [
    `🏅 ${year} 年度總結`,
    `一整年你開了 ${total} 團,辛苦了!`,
    `最強月份:${best} 月(${Math.max(...monthly)} 團)`,
    "新的一年繼續衝 🚀",
  ].join("\n");
}

export async function runMonthlySettlement(opts = {}) {
  const base = opts.base || dayjs();
  // 統計取自 DEFAULT_TENANT,推播給每個白名單會話
  const messages = [{ type: "text", text: buildMonthlySummaryText(DEFAULT_TENANT, base) }];
  if (base.month() === 0) {
    messages.push({ type: "text", text: buildYearlySummaryText(DEFAULT_TENANT, base) });
  }
  for (const c of listAllowed()) {
    try {
      await pushTo(c.conversation_id, messages);
    } catch (err) {
      console.error(`[settlement] conversation ${c.conversation_id} failed:`, err);
    }
  }
}
