# groupbuy-bot — LINE 團購開團提醒/管理 bot

把「開團時間表」從 Google Sheet 升級成以資料庫為核心的 LINE bot:每天主動提醒未來七天要開、且還沒給連結的團;用人話(或指令)新增/改期/取消/回填業績;每月自動結算激勵。

## 架構

```
                ┌──────────── 主動(node-cron 排程) ────────────┐
  每日 09:00 ─▶ scheduler ─▶ reminder(查未來7天未打勾)─▶ messages(carousel)─▶ LINE push
  每月 1 號 ─▶ scheduler ─▶ settlement(開團數統計)──────────────────────────▶ LINE push
                └────────────────────────────────────────────────┘
                                                              使用者點 OK ✅ / 選單
                ┌──────────── 被動(webhook) ───────────┐         │
  LINE ─POST /webhook─▶ handler ─┬─ postback ─▶ campaigns.check/move/cancel/backfill(冪等)
  (簽章驗證)                     ├─ /指令   ─▶ 結構化 parser ─┐
                                 └─ 自然語言 ─▶ anthropic ────┼─▶ campaigns.*(transaction + audit_log)
                                                  follow ─────┘            │
                                              註冊推播對象              SQLite(WAL)
```

所有寫入都經 `src/campaigns.js`(唯一寫入口,transaction + audit_log + 冪等),確保一致性與可追溯。

## 模組

| 檔案 | 職責 |
|---|---|
| `src/index.js` | Express + `/webhook` + `/health` + 啟動 scheduler + admin 補跑端點 |
| `src/handler.js` | webhook 路由:follow / postback / message(NL + `/` 指令) |
| `src/anthropic.js` | Claude tool-use:自然語言 → campaigns 呼叫,多筆命中推消歧 carousel |
| `src/campaigns.js` | 團購 repository(唯一寫入口,txn + audit + 冪等打勾) |
| `src/reminder.js` | 每日提醒(查 7 天視窗、組訊息、daily_runs 去重、>50 分批) |
| `src/settlement.js` | 月/年開團數統計 + 激勵訊息 |
| `src/messages.js` | LINE buttons/carousel builder(移植自舊 Apps Script) |
| `src/lineClient.js` | push / broadcast / reply(自動 5 則分批) |
| `src/scheduler.js` | node-cron 每日/每月 |
| `src/dates.js` | 檔期解析 `getStartAndEndDates` + `isWithinWindow` |
| `src/db.js` | schema + prepared statements |
| `src/importSheet.js` | 一次性 CSV 匯入 |

## 設定

```bash
cp .env.example .env
# 填入(LINE token 請用 console 重新產生的新值,舊的已外洩務必作廢):
#   LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET / ANTHROPIC_API_KEY
npm install
```

LINE Developers Console(Messaging API channel):Webhook URL → `https://xxx/webhook`、Use webhook ON、Auto-reply OFF。

## 本地跑

```bash
npm run dev
# 另一個終端
ngrok http 3000
# 把 https://xxx.ngrok-free.app/webhook 填回 channel → Verify
```

加 bot 好友後,它會自動記住你的 userId 當推播對象(也可在 `.env` 設 `LINE_TARGET_ID`)。

測試提醒不必等 cron:在聊天室打 `/check`,或 `POST /admin/run-daily?token=$ADMIN_TOKEN`。

## 一次性匯入既有 Sheet

1. 把每張 Google Sheet 匯出成 CSV。
2. 複製 `import.config.example.json` 成 `import.config.json`,填好每個檔案的欄位索引(0-based)與分類。
3. 先 dry run 確認:`node src/importSheet.js import.config.json --dry`
4. 正式匯入:`npm run import import.config.json`(可重跑,靠自然鍵冪等去重)。

## 使用者指令

自然語言:「新增 潔淨學 x Julia的實驗廚房 3/2-3/8」「把潔淨學改到 4/10」「取消潔淨學那團」「回填 潔淨學 業績 12000 分潤 1800」「這個月有哪些團」。
指令備用:`/add`、`/move`、`/cancel`、`/revenue`、`/list`、`/check`、`/help`。

## 部署

Railway(或任何 Node 22 平台):設好三組必填 env + `DB_PATH=/app/data/bot.db`(持久卷)+ `TZ=Asia/Taipei`,Webhook URL 換正式網址。

## 注意

- `replyToken` 一分鐘有效一次;主動提醒走 push/broadcast。
- 提醒視窗預設 7 天(`REMINDER_WINDOW_DAYS`),對齊舊腳本 `isWithinSevenDays`。
- 多租戶已預留(所有表帶 `tenant_id`),v1 只用 `default`。
