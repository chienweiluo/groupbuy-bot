import "dotenv/config";
import express from "express";
import { middleware } from "@line/bot-sdk";
import { handleEvent } from "./handler.js";
import { startScheduler } from "./scheduler.js";
import { runDailyForAllAllowed } from "./reminder.js";
import { runMonthlySettlement } from "./settlement.js";
import { seedAllowlistFromEnv } from "./db.js";
import { createAdminRouter } from "./admin.js";

const required = ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "ANTHROPIC_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

// 從 env ALLOWLIST 初始化白名單(逗號分隔的 conversation id)
const seeded = seedAllowlistFromEnv();
if (seeded) console.log(`[allowlist] 從 env 載入 ${seeded} 個會話`);

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.status(200).end();
  const events = req.body.events ?? [];
  await Promise.all(
    events.map((e) =>
      handleEvent(e).catch((err) => console.error("[webhook] event failed:", err))
    )
  );
});

// 手動觸發(測試/補跑用),需 ADMIN_TOKEN。例:POST /admin/run-daily?token=xxx
app.post("/admin/run-daily", express.json(), async (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: "forbidden" });
  }
  const results = await runDailyForAllAllowed({ force: true });
  res.json({ ok: true, results });
});

app.post("/admin/run-monthly", express.json(), async (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: "forbidden" });
  }
  await runMonthlySettlement();
  res.json({ ok: true });
});

// 後台管理站台(/admin 與 /admin/api/*),受 ADMIN_TOKEN 保護
app.use(createAdminRouter());
if (process.env.ADMIN_TOKEN) console.log("[admin] 後台已啟用:/admin");
else console.warn("[admin] ADMIN_TOKEN 未設定,後台 API 會回 503(請設定後重啟)");

app.use((err, _req, res, _next) => {
  console.error("[express] error:", err);
  res.status(err.statusCode || 500).end();
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`groupbuy-bot listening on :${port}`);
  startScheduler();
});
