// anthropic.js — 用 Claude tool-use 把自然語言指令轉成 campaigns.js 的呼叫。
// 多筆命中時推 carousel 讓使用者點選(消歧),不亂猜。

import Anthropic from "@anthropic-ai/sdk";
import {
  createCampaign,
  moveCampaign,
  cancelCampaign,
  backfillRevenue,
  findCampaigns,
  monthlyStats,
} from "./campaigns.js";
import { buildCandidateList } from "./messages.js";
import { parseInputDate, INVALID, lastMonth, dayjs } from "./dates.js";

const client = new Anthropic();
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const MAX_TOOL_ITERATIONS = 5;

function buildSystemPrompt() {
  const todayStr = dayjs().format("YYYY-MM-DD (ddd)");
  return `你是「團購開團管理助手」,幫使用者管理開團時間表(資料存在資料庫,不是 Google Sheet)。
今天是 ${todayStr}。所有日期請以 YYYY-MM-DD 處理。

【你的工作】
使用者用中文口語跟你下指令,你負責判斷意圖並呼叫對應工具:
- 新增團 → add_campaign(廠商 vendor、團主 kol、檔期 period)
- 改期 → move_campaign(用 term 指認是哪一團,new_date 新開團日)
- 取消團 → cancel_campaign(term)
- 回填業績/分潤 → backfill_revenue(term、revenue、commission)
- 查詢/統計 → query_campaigns(month 或 term)

【重要原則】
- 「廠商」是品牌(例:潔淨學);「團主/KOL」是經營者(例:Julia的實驗廚房)。別搞反。
- 指認某團時,term 填使用者提到的廠商或團主關鍵字即可,工具會自己找。
- 若工具回 needs_disambiguation,代表找到多個,系統已把選單卡片送給使用者 —— 你只要用一句話請他「點上面卡片選一個」,不要自己亂選。
- 若工具回 not_found,告訴使用者沒找到,請他確認名稱或日期。
- 動作成功後,用一句簡短中文確認(帶廠商/團主/日期)。
- ⚠️ LINE 沒有 Markdown:不要用 *粗體*、#、表格、- 條列。要分點用「①②③」或換行 + emoji。
- 回覆精簡,1-4 句即可。`;
}

const TOOLS = [
  {
    name: "add_campaign",
    description: "新增一個開團。需要廠商、團主、檔期。",
    input_schema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "廠商/品牌名稱,例:潔淨學" },
        kol: { type: "string", description: "團主/KOL 名稱,例:Julia的實驗廚房" },
        period: {
          type: "string",
          description: "檔期原字串,例「2025/01/01-2025/01/07」或「3/2-3/8」。也可只給開團日。",
        },
        category: { type: "string", description: "分類(原 sheet 名稱),可省略" },
      },
      required: ["vendor", "kol", "period"],
    },
  },
  {
    name: "move_campaign",
    description: "把某個現有的團改到新的開團日。",
    input_schema: {
      type: "object",
      properties: {
        term: { type: "string", description: "用來指認哪一團的關鍵字(廠商或團主)" },
        new_date: { type: "string", description: "新開團日,例 4/10 或 2026-04-10" },
      },
      required: ["term", "new_date"],
    },
  },
  {
    name: "cancel_campaign",
    description: "取消某個現有的團。",
    input_schema: {
      type: "object",
      properties: {
        term: { type: "string", description: "用來指認哪一團的關鍵字(廠商或團主)" },
      },
      required: ["term"],
    },
  },
  {
    name: "backfill_revenue",
    description: "回填某團的業績與/或分潤。",
    input_schema: {
      type: "object",
      properties: {
        term: { type: "string", description: "用來指認哪一團的關鍵字(廠商或團主)" },
        revenue: { type: "number", description: "業績金額,可省略" },
        commission: { type: "number", description: "分潤金額,可省略" },
        month: { type: "string", description: "縮小範圍的月份 YYYY-MM,可省略" },
      },
      required: ["term"],
    },
  },
  {
    name: "query_campaigns",
    description: "查詢團/做統計。可給 month(YYYY-MM)做月統計,或 term 找特定廠商/團主。",
    input_schema: {
      type: "object",
      properties: {
        month: { type: "string", description: "月份 YYYY-MM(月統計)" },
        term: { type: "string", description: "廠商或團主關鍵字" },
        status: { type: "string", enum: ["active", "cancelled"], description: "預設 active" },
      },
    },
  },
];

function locate({ term, month, tenantId }) {
  return findCampaigns({ term, month, status: "active", tenantId, limit: 10 });
}

/**
 * @returns {Promise<{text: string, extraMessages: object[]}>}
 *   extraMessages:要附在文字後面的 LINE 訊息(消歧 carousel 等)
 */
export async function ask({ userText, actor = null, tenantId }) {
  const messages = [{ role: "user", content: userText }];
  const extraMessages = [];
  let finalResponse = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
    });

    finalResponse = response;
    if (response.stop_reason !== "tool_use") break;

    messages.push({ role: "assistant", content: response.content });
    const toolResults = [];

    for (const tu of response.content.filter((b) => b.type === "tool_use")) {
      let result;
      try {
        result = await runTool(tu.name, tu.input, { actor, tenantId, extraMessages });
      } catch (err) {
        console.error(`[tool ${tu.name}] failed:`, err);
        result = { error: err.message };
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: !!result?.error,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  const text =
    finalResponse?.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim() || "(我不太確定你的意思,可以換個說法嗎?)";

  return { text, extraMessages };
}

async function runTool(name, input, { actor, tenantId, extraMessages }) {
  if (name === "add_campaign") {
    const res = createCampaign(
      { vendor: input.vendor, kol: input.kol, periodRaw: input.period, category: input.category, tenantId },
      actor
    );
    return res.ok
      ? { status: "created", campaign: brief(res.campaign) }
      : { error: res.error };
  }

  if (name === "move_campaign") {
    const newDate = parseInputDate(input.new_date);
    if (newDate === INVALID) return { error: `新開團日「${input.new_date}」無法解析` };
    const candidates = locate({ term: input.term, tenantId });
    if (candidates.length === 0) return { not_found: true };
    if (candidates.length === 1) {
      const res = moveCampaign(candidates[0].id, newDate, newDate, actor, tenantId);
      return res.ok ? { status: "moved", campaign: brief(res.campaign) } : { error: res.error };
    }
    extraMessages.push(buildCandidateList(candidates, "move", { start: newDate }));
    return { needs_disambiguation: true, count: candidates.length, new_date: newDate };
  }

  if (name === "cancel_campaign") {
    const candidates = locate({ term: input.term, tenantId });
    if (candidates.length === 0) return { not_found: true };
    if (candidates.length === 1) {
      const res = cancelCampaign(candidates[0].id, actor, tenantId);
      return res.ok ? { status: "cancelled", campaign: brief(res.campaign) } : { error: res.error };
    }
    extraMessages.push(buildCandidateList(candidates, "cancel"));
    return { needs_disambiguation: true, count: candidates.length };
  }

  if (name === "backfill_revenue") {
    if (input.revenue === undefined && input.commission === undefined) {
      return { error: "請提供業績或分潤金額" };
    }
    const candidates = locate({ term: input.term, month: input.month, tenantId });
    if (candidates.length === 0) return { not_found: true };
    if (candidates.length === 1) {
      const res = backfillRevenue(
        candidates[0].id,
        { revenue: input.revenue, commission: input.commission },
        actor,
        tenantId
      );
      return res.ok ? { status: "backfilled", campaign: brief(res.campaign) } : { error: res.error };
    }
    const extra = {};
    if (input.revenue !== undefined) extra.rev = input.revenue;
    if (input.commission !== undefined) extra.com = input.commission;
    extraMessages.push(buildCandidateList(candidates, "backfill", extra));
    return { needs_disambiguation: true, count: candidates.length };
  }

  if (name === "query_campaigns") {
    if (input.month) {
      const stats = monthlyStats(input.month, tenantId);
      return { month_stats: stats };
    }
    const list = findCampaigns({
      term: input.term,
      status: input.status || "active",
      tenantId,
      limit: 20,
    });
    return { count: list.length, campaigns: list.map(brief) };
  }

  return { error: `unknown tool: ${name}` };
}

function brief(c) {
  return {
    id: c.id,
    vendor: c.vendor,
    kol: c.kol,
    start: c.startDate,
    end: c.endDate,
    link_sent: c.linkSent,
    revenue: c.revenue,
    commission: c.commission,
    status: c.status,
  };
}

export { lastMonth };
