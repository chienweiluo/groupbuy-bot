// campaigns.js — 團購資料的「唯一寫入口」。
// 所有 create/move/cancel/check/backfill 都在 transaction 內完成,並寫 audit_log,
// 確保資料一致性與可追溯(計畫 §2.4)。

import { db, writeAudit } from "./db.js";
import { getStartAndEndDates, isWithinWindow, INVALID, today, dayjs } from "./dates.js";

const DEFAULT_TENANT = process.env.DEFAULT_TENANT || "default";
const WINDOW_DAYS = Number(process.env.REMINDER_WINDOW_DAYS || 7);

// ---- prepared statements ----
const insertCampaign = db.prepare(
  `INSERT INTO campaigns
     (tenant_id, category, start_date, end_date, vendor, kol, link_sent, revenue, commission, status, source_row, created_at, updated_at)
   VALUES (@tenant_id, @category, @start_date, @end_date, @vendor, @kol, @link_sent, @revenue, @commission, 'active', @source_row, @now, @now)`
);
const selectById = db.prepare("SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?");
const updateCheck = db.prepare(
  "UPDATE campaigns SET link_sent = 1, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'active' AND link_sent = 0"
);
const updateDates = db.prepare(
  "UPDATE campaigns SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'active'"
);
const updateCancel = db.prepare(
  "UPDATE campaigns SET status = 'cancelled', updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'active'"
);
const updateRevenue = db.prepare(
  "UPDATE campaigns SET revenue = ?, commission = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
);
const deleteById = db.prepare("DELETE FROM campaigns WHERE id = ? AND tenant_id = ?");

// 後台「修改開團」可動欄位 → 欄位白名單(camelCase → 資料表欄位)
const EDITABLE_COLUMNS = {
  category: "category",
  startDate: "start_date",
  endDate: "end_date",
  vendor: "vendor",
  kol: "kol",
  linkSent: "link_sent",
  revenue: "revenue",
  commission: "commission",
  status: "status",
};

function rowToCampaign(r) {
  if (!r) return null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    category: r.category,
    startDate: r.start_date,
    endDate: r.end_date,
    vendor: r.vendor,
    kol: r.kol,
    linkSent: r.link_sent === 1,
    revenue: r.revenue,
    commission: r.commission,
    status: r.status,
    sourceRow: r.source_row,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getCampaign(id, tenantId = DEFAULT_TENANT) {
  return rowToCampaign(selectById.get(id, tenantId));
}

/**
 * 新增團。可給 periodRaw("2025/01/01-2025/01/07")或 startDate/endDate。
 * 回傳 { ok, campaign?, error? }
 */
export function createCampaign(input, actor = null) {
  const tenantId = input.tenantId || DEFAULT_TENANT;
  let startDate = input.startDate;
  let endDate = input.endDate;

  if (input.periodRaw) {
    const parsed = getStartAndEndDates(input.periodRaw);
    startDate = parsed.startDate;
    endDate = parsed.endDate;
  }
  if (!startDate || startDate === INVALID) return { ok: false, error: "檔期/開團日無法解析" };
  if (!endDate || endDate === INVALID) endDate = startDate;
  if (!input.vendor) return { ok: false, error: "缺少廠商名稱" };
  if (!input.kol) return { ok: false, error: "缺少 KOL(團主)名稱" };

  const run = db.transaction(() => {
    const res = insertCampaign.run({
      tenant_id: tenantId,
      category: input.category ?? null,
      start_date: startDate,
      end_date: endDate,
      vendor: input.vendor,
      kol: input.kol,
      link_sent: input.linkSent ? 1 : 0,
      revenue: input.revenue ?? null,
      commission: input.commission ?? null,
      source_row: input.sourceRow ?? null,
      now: Date.now(),
    });
    const campaign = getCampaign(res.lastInsertRowid, tenantId);
    writeAudit({ tenantId, campaignId: campaign.id, action: "create", after: campaign, actor });
    return campaign;
  });

  return { ok: true, campaign: run() };
}

/** OK ✅ 冪等打勾。回傳 status: checked | already | inactive | not_found */
export function checkLinkSent(id, actor = null, tenantId = DEFAULT_TENANT) {
  const run = db.transaction(() => {
    const before = getCampaign(id, tenantId);
    if (!before) return { status: "not_found" };
    if (before.status !== "active") return { status: "inactive", campaign: before };
    if (before.linkSent) return { status: "already", campaign: before };

    const res = updateCheck.run(Date.now(), id, tenantId);
    if (res.changes === 0) {
      // 競態下被別人先打勾;重讀回報 already
      return { status: "already", campaign: getCampaign(id, tenantId) };
    }
    const after = getCampaign(id, tenantId);
    writeAudit({ tenantId, campaignId: id, action: "check", before, after, actor });
    return { status: "checked", campaign: after };
  });
  return run();
}

/** 改期。newStart/newEnd 為 'YYYY-MM-DD'(已解析)。 */
export function moveCampaign(id, newStart, newEnd, actor = null, tenantId = DEFAULT_TENANT) {
  if (!newStart || newStart === INVALID) return { ok: false, error: "新開團日無法解析" };
  const run = db.transaction(() => {
    const before = getCampaign(id, tenantId);
    if (!before) return { ok: false, error: "找不到這個團" };
    if (before.status !== "active") return { ok: false, error: "這個團已取消,無法改期" };
    updateDates.run(newStart, newEnd || newStart, Date.now(), id, tenantId);
    const after = getCampaign(id, tenantId);
    writeAudit({ tenantId, campaignId: id, action: "move", before, after, actor });
    return { ok: true, campaign: after };
  });
  return run();
}

export function cancelCampaign(id, actor = null, tenantId = DEFAULT_TENANT) {
  const run = db.transaction(() => {
    const before = getCampaign(id, tenantId);
    if (!before) return { ok: false, error: "找不到這個團" };
    if (before.status !== "active") return { ok: false, error: "這個團先前已取消" };
    updateCancel.run(Date.now(), id, tenantId);
    const after = getCampaign(id, tenantId);
    writeAudit({ tenantId, campaignId: id, action: "cancel", before, after, actor });
    return { ok: true, campaign: after };
  });
  return run();
}

/** 回填業績/分潤。revenue/commission 任一為 undefined 則保留原值。 */
export function backfillRevenue(id, { revenue, commission }, actor = null, tenantId = DEFAULT_TENANT) {
  const run = db.transaction(() => {
    const before = getCampaign(id, tenantId);
    if (!before) return { ok: false, error: "找不到這個團" };
    const newRevenue = revenue === undefined ? before.revenue : revenue;
    const newCommission = commission === undefined ? before.commission : commission;
    updateRevenue.run(newRevenue, newCommission, Date.now(), id, tenantId);
    const after = getCampaign(id, tenantId);
    writeAudit({ tenantId, campaignId: id, action: "backfill", before, after, actor });
    return { ok: true, campaign: after };
  });
  return run();
}

/**
 * 模糊找團(供消歧)。term 會比對 vendor 或 kol;可加 month('YYYY-MM')、status、linkSent 篩選。
 * 回傳 campaign 陣列(最多 limit 筆,預設依 start_date 排序)。
 */
export function findCampaigns(
  { term, vendor, kol, month, status = "active", linkSent, limit = 20, tenantId = DEFAULT_TENANT } = {}
) {
  const where = ["tenant_id = ?"];
  const params = [tenantId];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (typeof linkSent === "boolean") {
    where.push("link_sent = ?");
    params.push(linkSent ? 1 : 0);
  }
  if (term) {
    where.push("(vendor LIKE ? OR kol LIKE ?)");
    params.push(`%${term}%`, `%${term}%`);
  }
  if (vendor) {
    where.push("vendor LIKE ?");
    params.push(`%${vendor}%`);
  }
  if (kol) {
    where.push("kol LIKE ?");
    params.push(`%${kol}%`);
  }
  if (month) {
    where.push("substr(start_date, 1, 7) = ?");
    params.push(month);
  }
  const sql = `SELECT * FROM campaigns WHERE ${where.join(" AND ")} ORDER BY start_date ASC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params).map(rowToCampaign);
}

/**
 * 取得提醒視窗內、尚未打勾、active 的團(供每日提醒)。
 * 先用 SQL 以 start_date 字串做 ISO 範圍粗篩,再用 isWithinWindow 精確驗證。
 */
export function getUpcomingToRemind(tenantId = DEFAULT_TENANT, windowDays = WINDOW_DAYS) {
  const base = today();
  const from = base.format("YYYY-MM-DD");
  const to = base.add(windowDays, "day").format("YYYY-MM-DD");
  const rows = db
    .prepare(
      `SELECT * FROM campaigns
       WHERE tenant_id = ? AND status = 'active' AND link_sent = 0
         AND start_date >= ? AND start_date <= ?
       ORDER BY start_date ASC`
    )
    .all(tenantId, from, to)
    .map(rowToCampaign);
  return rows.filter((c) => isWithinWindow(c.startDate, windowDays, base));
}

/** 月結統計:某月(YYYY-MM)開團數、依 category / kol 細分。 */
export function monthlyStats(month, tenantId = DEFAULT_TENANT) {
  const total = db
    .prepare(
      "SELECT COUNT(*) n FROM campaigns WHERE tenant_id = ? AND status = 'active' AND substr(start_date,1,7) = ?"
    )
    .get(tenantId, month).n;
  const byKol = db
    .prepare(
      `SELECT kol, COUNT(*) n FROM campaigns
       WHERE tenant_id = ? AND status = 'active' AND substr(start_date,1,7) = ?
       GROUP BY kol ORDER BY n DESC LIMIT 10`
    )
    .all(tenantId, month);
  const revenue = db
    .prepare(
      "SELECT COALESCE(SUM(revenue),0) rev, COALESCE(SUM(commission),0) com FROM campaigns WHERE tenant_id = ? AND status = 'active' AND substr(start_date,1,7) = ?"
    )
    .get(tenantId, month);
  return { month, total, byKol, revenue: revenue.rev, commission: revenue.com };
}

/**
 * 後台通用「修改開團」。fields 為部分欄位(camelCase),只更新有給的;
 * 全程 transaction + audit。不限 active(後台可校正任何狀態的資料)。
 * 日期欄位若提供會以 'YYYY-MM-DD' 嚴格驗證。回傳 { ok, campaign?, error? }。
 */
export function updateCampaign(id, fields = {}, actor = null, tenantId = DEFAULT_TENANT) {
  const sets = [];
  const values = [];

  for (const [key, col] of Object.entries(EDITABLE_COLUMNS)) {
    if (!(key in fields) || fields[key] === undefined) continue;
    let v = fields[key];

    if (key === "startDate" || key === "endDate") {
      if (v) {
        const iso = dayjs(String(v), "YYYY-MM-DD", true);
        if (!iso.isValid()) return { ok: false, error: `${key} 日期格式須為 YYYY-MM-DD` };
        v = iso.format("YYYY-MM-DD");
      } else {
        v = null; // 允許清空 end_date
      }
    } else if (key === "vendor" || key === "kol") {
      v = String(v).trim();
      if (!v) return { ok: false, error: `${key} 不可為空` };
    } else if (key === "linkSent") {
      v = v ? 1 : 0;
    } else if (key === "status") {
      if (v !== "active" && v !== "cancelled") return { ok: false, error: "status 只能是 active / cancelled" };
    } else if (key === "revenue" || key === "commission") {
      v = v === null || v === "" ? null : Number(v);
      if (v !== null && !Number.isFinite(v)) return { ok: false, error: `${key} 必須是數字` };
    } else if (key === "category") {
      v = v === "" ? null : v;
    }

    sets.push(`${col} = ?`);
    values.push(v);
  }

  if (!sets.length) return { ok: false, error: "沒有要更新的欄位" };

  const run = db.transaction(() => {
    const before = getCampaign(id, tenantId);
    if (!before) return { ok: false, error: "找不到這個團" };
    // start 在、end 缺 → end 跟 start;若兩者都改且 end < start 擋下
    const sql = `UPDATE campaigns SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND tenant_id = ?`;
    db.prepare(sql).run(...values, Date.now(), id, tenantId);
    let after = getCampaign(id, tenantId);
    // 一致性:結束日空、或結束日早於開團日(例如只改了開團日把它移到原結束日之後)→ 補成開團日
    if (after.startDate && (!after.endDate || after.endDate < after.startDate)) {
      db.prepare("UPDATE campaigns SET end_date = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
        .run(after.startDate, Date.now(), id, tenantId);
      after = getCampaign(id, tenantId);
    }
    writeAudit({ tenantId, campaignId: id, action: "edit", before, after, actor });
    return { ok: true, campaign: after };
  });
  return run();
}

/** 後台硬刪除(連同寫 audit 留底 before_json,可追溯)。回傳 { ok, campaign?, error? } */
export function deleteCampaign(id, actor = null, tenantId = DEFAULT_TENANT) {
  const run = db.transaction(() => {
    const before = getCampaign(id, tenantId);
    if (!before) return { ok: false, error: "找不到這個團" };
    deleteById.run(id, tenantId);
    writeAudit({ tenantId, campaignId: id, action: "delete", before, after: null, actor });
    return { ok: true, campaign: before };
  });
  return run();
}

/**
 * 後台搜尋(日期/團主/廠商/分類/狀態/連結 多維度 + 分頁 + 排序)。
 * 回傳 { rows, total, page, pageSize }。
 *  - q:模糊比對 vendor 或 kol
 *  - from/to:以 start_date(YYYY-MM-DD)做範圍篩選
 *  - status:''/undefined 代表不限狀態
 *  - sort:start_date | end_date | vendor | kol | revenue | commission | updated_at | id
 */
export function searchCampaigns(opts = {}) {
  const {
    q, kol, vendor, category, status, linkSent, from, to,
    sort = "start_date", order = "desc",
    page = 1, pageSize = 50, tenantId = DEFAULT_TENANT,
  } = opts;

  const where = ["tenant_id = ?"];
  const params = [tenantId];

  if (status) { where.push("status = ?"); params.push(status); }
  if (typeof linkSent === "boolean") { where.push("link_sent = ?"); params.push(linkSent ? 1 : 0); }
  if (q) { where.push("(vendor LIKE ? OR kol LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
  if (vendor) { where.push("vendor LIKE ?"); params.push(`%${vendor}%`); }
  if (kol) { where.push("kol LIKE ?"); params.push(`%${kol}%`); }
  if (category) {
    if (category === "__none__") where.push("category IS NULL");
    else { where.push("category = ?"); params.push(category); }
  }
  if (from) { where.push("start_date >= ?"); params.push(from); }
  if (to) { where.push("start_date <= ?"); params.push(to); }

  const whereSql = where.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) n FROM campaigns WHERE ${whereSql}`).get(...params).n;

  const SORTABLE = new Set([
    "start_date", "end_date", "vendor", "kol", "revenue", "commission", "updated_at", "id", "category",
  ]);
  const sortCol = SORTABLE.has(sort) ? sort : "start_date";
  const dir = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";

  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.min(500, Math.max(1, Number(pageSize) || 50));
  const offset = (safePage - 1) * safeSize;

  const rows = db
    .prepare(`SELECT * FROM campaigns WHERE ${whereSql} ORDER BY ${sortCol} ${dir}, id ${dir} LIMIT ? OFFSET ?`)
    .all(...params, safeSize, offset)
    .map(rowToCampaign);

  return { rows, total, page: safePage, pageSize: safeSize };
}

/**
 * 業績總結:某區間內(以 start_date 計)的 KPI 與多維度細分。
 * 回傳 { range, totals, byCategory, byKol, byVendor, byMonth }。
 */
export function summaryReport({ from, to, status = "active", tenantId = DEFAULT_TENANT } = {}) {
  const where = ["tenant_id = ?"];
  const params = [tenantId];
  if (status) { where.push("status = ?"); params.push(status); }
  if (from) { where.push("start_date >= ?"); params.push(from); }
  if (to) { where.push("start_date <= ?"); params.push(to); }
  const whereSql = where.join(" AND ");

  const totals = db
    .prepare(
      `SELECT COUNT(*) total,
              COALESCE(SUM(revenue),0) revenue,
              COALESCE(SUM(commission),0) commission,
              SUM(CASE WHEN link_sent = 1 THEN 1 ELSE 0 END) linkSent,
              SUM(CASE WHEN revenue IS NOT NULL THEN 1 ELSE 0 END) withRevenue,
              COUNT(DISTINCT kol) kols,
              COUNT(DISTINCT vendor) vendors
         FROM campaigns WHERE ${whereSql}`
    )
    .get(...params);

  const groupBy = (expr) =>
    db
      .prepare(
        `SELECT ${expr} AS label, COUNT(*) total,
                COALESCE(SUM(revenue),0) revenue, COALESCE(SUM(commission),0) commission
           FROM campaigns WHERE ${whereSql}
          GROUP BY ${expr} ORDER BY total DESC`
      )
      .all(...params);

  return {
    range: { from: from || null, to: to || null, status },
    totals,
    byCategory: groupBy("COALESCE(category, '未分類')"),
    byKol: groupBy("kol"),
    byVendor: groupBy("vendor"),
    byMonth: db
      .prepare(
        `SELECT substr(start_date,1,7) AS label, COUNT(*) total,
                COALESCE(SUM(revenue),0) revenue, COALESCE(SUM(commission),0) commission
           FROM campaigns WHERE ${whereSql}
          GROUP BY label ORDER BY label ASC`
      )
      .all(...params),
  };
}

/** 篩選器選項:不重複的分類 / 團主 / 廠商(供前端下拉)。 */
export function listFacets(tenantId = DEFAULT_TENANT) {
  const col = (name) =>
    db
      .prepare(
        `SELECT ${name} AS v, COUNT(*) n FROM campaigns
          WHERE tenant_id = ? AND ${name} IS NOT NULL AND ${name} != ''
          GROUP BY ${name} ORDER BY n DESC`
      )
      .all(tenantId)
      .map((r) => ({ value: r.v, count: r.n }));
  return { categories: col("category"), kols: col("kol"), vendors: col("vendor") };
}

/** 取某團的異動歷史(audit_log),供後台檢視。 */
export function getCampaignHistory(id, tenantId = DEFAULT_TENANT) {
  return db
    .prepare("SELECT * FROM audit_log WHERE campaign_id = ? AND tenant_id = ? ORDER BY ts DESC")
    .all(id, tenantId);
}

export { DEFAULT_TENANT, WINDOW_DAYS };
