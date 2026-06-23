// 純邏輯 smoke test(不碰 LINE/Anthropic 網路)。
// 跑法:DB_PATH=/tmp/gb-smoke.db node test/smoke.mjs
import assert from "node:assert";
import { unlinkSync, existsSync } from "node:fs";

const DB = process.env.DB_PATH || "/tmp/gb-smoke.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) unlinkSync(f);
process.env.DB_PATH = DB;

const { getStartAndEndDates, parseInputDate, isWithinWindow, INVALID, dayjs } = await import("../src/dates.js");
const campaigns = await import("../src/campaigns.js");
const { buildReminderMessages, buildCandidateList } = await import("../src/messages.js");
const { parseCsv } = await import("../src/importSheet.js");

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓", name); pass++; };

console.log("dates:");
{
  const a = getStartAndEndDates("2025/01/01-2025/01/07");
  ok("檔期拆解 start", a.startDate === "2025-01-01");
  ok("檔期拆解 end", a.endDate === "2025-01-07");
  ok("dash 格式", getStartAndEndDates("2025-03-02-2025-03-08").endDate === "2025-03-08");
  ok("單一日期 → end=start", getStartAndEndDates("2025/05/05").endDate === "2025-05-05");
  ok("invalid", getStartAndEndDates("沒有日期").startDate === INVALID);
  ok("parseInputDate ISO", parseInputDate("2026-04-10") === "2026-04-10");
  ok("parseInputDate 中文", parseInputDate("4月10日").endsWith("-04-10"));
  const base = dayjs("2026-06-14");
  ok("isWithinWindow 今天", isWithinWindow("2026-06-14", 7, base.startOf("day")));
  ok("isWithinWindow +6天", isWithinWindow("2026-06-20", 7, base.startOf("day")));
  ok("isWithinWindow +8天 排除", !isWithinWindow("2026-06-22", 7, base.startOf("day")));
  ok("isWithinWindow 過去 排除", !isWithinWindow("2026-06-10", 7, base.startOf("day")));
}

console.log("campaigns:");
{
  const created = campaigns.createCampaign({ vendor: "潔淨學", kol: "Julia的實驗廚房", periodRaw: "2025/01/01-2025/01/07", category: "美妝" }, "tester");
  ok("create ok", created.ok && created.campaign.id > 0);
  const id = created.campaign.id;

  const c1 = campaigns.checkLinkSent(id, "tester");
  ok("check → checked", c1.status === "checked" && c1.campaign.linkSent === true);
  const c2 = campaigns.checkLinkSent(id, "tester");
  ok("check 冪等 → already", c2.status === "already");

  const mv = campaigns.moveCampaign(id, "2026-04-10", "2026-04-16", "tester");
  ok("move ok", mv.ok && mv.campaign.startDate === "2026-04-10");

  const bf = campaigns.backfillRevenue(id, { revenue: 12000, commission: 1800 }, "tester");
  ok("backfill ok", bf.ok && bf.campaign.revenue === 12000 && bf.campaign.commission === 1800);

  const cancelled = campaigns.cancelCampaign(id, "tester");
  ok("cancel ok", cancelled.ok && cancelled.campaign.status === "cancelled");
  ok("cancel 後再 check → inactive", campaigns.checkLinkSent(id, "tester").status === "inactive");
  ok("cancel 後再 cancel → error", !campaigns.cancelCampaign(id, "tester").ok);

  // upcoming 視窗
  const today = dayjs();
  campaigns.createCampaign({ vendor: "A廠", kol: "K1", startDate: today.add(2, "day").format("YYYY-MM-DD") }, "t");
  campaigns.createCampaign({ vendor: "B廠", kol: "K2", startDate: today.add(20, "day").format("YYYY-MM-DD") }, "t");
  const checkedOne = campaigns.createCampaign({ vendor: "C廠", kol: "K3", startDate: today.add(1, "day").format("YYYY-MM-DD") }, "t");
  campaigns.checkLinkSent(checkedOne.campaign.id, "t"); // 已打勾不該出現
  const up = campaigns.getUpcomingToRemind();
  ok("upcoming 只含視窗內未打勾", up.length === 1 && up[0].vendor === "A廠");

  const found = campaigns.findCampaigns({ term: "潔淨", status: "cancelled" });
  ok("findCampaigns by term", found.length === 1 && found[0].vendor === "潔淨學");
}

console.log("messages:");
{
  ok("0 團 → 1 則 text", (() => { const m = buildReminderMessages([]); return m.length === 1 && m[0].type === "text"; })());
  const one = buildReminderMessages([{ id: 1, vendor: "潔淨學", kol: "Julia", startDate: "2026-03-02", category: "美妝" }]);
  ok("1 團 → buttons", one.length === 1 && one[0].template.type === "buttons");
  ok("buttons postback 帶 campaignId", one[0].template.actions[0].data.includes("campaignId=1"));
  const list11 = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, vendor: `V${i}`, kol: `K${i}`, startDate: "2026-03-02" }));
  const many = buildReminderMessages(list11);
  ok("11 團 → 2 則 carousel", many.length === 2 && many[0].template.type === "carousel");
  ok("carousel 第一則 10 欄", many[0].template.columns.length === 10);
  ok("carousel text ≤ 60", many[0].template.columns.every((c) => c.text.length <= 60));
  const cand = buildCandidateList(list11, "move", { start: "2026-04-10" });
  ok("候選清單 postback 帶 action+start", cand.template.columns[0].actions[0].data.includes("action=move") && cand.template.columns[0].actions[0].data.includes("start="));
}

console.log("csv:");
{
  const rows = parseCsv('a,b,c\n"含,逗號","含\n換行",✅\n');
  ok("CSV 基本", rows[0].length === 3 && rows[0][0] === "a");
  ok("CSV 引號逗號", rows[1][0] === "含,逗號");
  ok("CSV 引號換行", rows[1][1] === "含\n換行");
}

console.log(`\n✅ 全部 ${pass} 項通過`);
