// admin.js — 後台管理站台(掛在同一個 Express app)。
// 提供:多維度搜尋、業績總結、發起通知、回填、新增/修改/刪除開團。
// 所有寫入都走 campaigns.js(唯一寫入口,transaction + audit_log)。
// 受 ADMIN_TOKEN 保護:/admin/api/* 需帶 x-admin-token 或 Authorization: Bearer。

import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  searchCampaigns,
  summaryReport,
  listFacets,
  getCampaign,
  getCampaignHistory,
  createCampaign,
  updateCampaign,
  backfillRevenue,
  deleteCampaign,
} from "./campaigns.js";
import { listAllowed } from "./db.js";
import { pushTo } from "./lineClient.js";
import { textMessage } from "./messages.js";
import { runDailyForAllAllowed } from "./reminder.js";
import { runMonthlySettlement } from "./settlement.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, "adminPage.html");

const ACTOR = "admin-web";

export function createAdminRouter() {
  const router = express.Router();
  const json = express.json({ limit: "1mb" });

  // ---- SPA 殼(不含資料,公開即可;資料端點才要 token)----
  router.get("/admin", (_req, res) => {
    res.type("html").send(readFileSync(HTML_PATH, "utf8"));
  });

  // ---- token 驗證 middleware(套在所有 /admin/api/*)----
  router.use("/admin/api", (req, res, next) => {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) {
      return res.status(503).json({ error: "後台未啟用:請先在環境變數設定 ADMIN_TOKEN" });
    }
    const got =
      req.get("x-admin-token") ||
      (req.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
      req.query.token;
    if (got !== expected) return res.status(401).json({ error: "未授權" });
    next();
  });

  // ---- 登入(驗 token 是否正確)----
  router.post("/admin/api/login", json, (_req, res) => res.json({ ok: true }));

  // ---- 篩選器選項 ----
  router.get("/admin/api/facets", (_req, res) => res.json(listFacets()));

  // ---- 搜尋/列表 ----
  router.get("/admin/api/campaigns", (req, res) => {
    const q = req.query;
    const result = searchCampaigns({
      q: q.q || undefined,
      kol: q.kol || undefined,
      vendor: q.vendor || undefined,
      category: q.category || undefined,
      status: q.status || undefined,
      linkSent: q.linkSent === "" || q.linkSent == null ? undefined : q.linkSent === "1" || q.linkSent === "true",
      from: q.from || undefined,
      to: q.to || undefined,
      sort: q.sort || undefined,
      order: q.order || undefined,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 50,
    });
    res.json(result);
  });

  // ---- 單筆 + 異動歷史 ----
  router.get("/admin/api/campaigns/:id", (req, res) => {
    const c = getCampaign(Number(req.params.id));
    if (!c) return res.status(404).json({ error: "找不到這個團" });
    res.json({ campaign: c, history: getCampaignHistory(Number(req.params.id)) });
  });

  // ---- 新增開團 ----
  router.post("/admin/api/campaigns", json, (req, res) => {
    const r = createCampaign({ ...req.body }, ACTOR);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.status(201).json({ campaign: r.campaign });
  });

  // ---- 修改開團(部分欄位)----
  router.patch("/admin/api/campaigns/:id", json, (req, res) => {
    const r = updateCampaign(Number(req.params.id), req.body || {}, ACTOR);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ campaign: r.campaign });
  });

  // ---- 回填業績/分潤 ----
  router.post("/admin/api/campaigns/:id/backfill", json, (req, res) => {
    const { revenue, commission } = req.body || {};
    const r = backfillRevenue(
      Number(req.params.id),
      {
        revenue: revenue === undefined || revenue === "" ? undefined : Number(revenue),
        commission: commission === undefined || commission === "" ? undefined : Number(commission),
      },
      ACTOR
    );
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ campaign: r.campaign });
  });

  // ---- 刪除開團 ----
  router.delete("/admin/api/campaigns/:id", (req, res) => {
    const r = deleteCampaign(Number(req.params.id), ACTOR);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true, campaign: r.campaign });
  });

  // ---- 業績總結 ----
  router.get("/admin/api/summary", (req, res) => {
    res.json(
      summaryReport({
        from: req.query.from || undefined,
        to: req.query.to || undefined,
        status: req.query.status || undefined,
      })
    );
  });

  // ---- 通知對象(白名單會話)----
  router.get("/admin/api/allowlist", (_req, res) => {
    res.json({ conversations: listAllowed() });
  });

  // ---- 發起通知 ----
  router.post("/admin/api/notify", json, async (req, res) => {
    const { type, text } = req.body || {};
    try {
      if (type === "daily") {
        const results = await runDailyForAllAllowed({ force: true });
        return res.json({ ok: true, type, results });
      }
      if (type === "monthly") {
        await runMonthlySettlement();
        return res.json({ ok: true, type });
      }
      if (type === "custom") {
        const body = String(text || "").trim();
        if (!body) return res.status(400).json({ error: "訊息內容不可為空" });
        const convs = listAllowed();
        if (!convs.length) return res.status(400).json({ error: "白名單為空,沒有可推播的會話" });
        const results = [];
        for (const c of convs) {
          try {
            await pushTo(c.conversation_id, [textMessage(body)]);
            results.push({ conversationId: c.conversation_id, sent: true });
          } catch (err) {
            results.push({ conversationId: c.conversation_id, sent: false, error: err.message });
          }
        }
        return res.json({ ok: true, type, results });
      }
      return res.status(400).json({ error: "未知的通知類型(daily | monthly | custom)" });
    } catch (err) {
      console.error("[admin] notify failed:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}
