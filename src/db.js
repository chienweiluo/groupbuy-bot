import Database from "better-sqlite3";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/bot.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

// 首次開機(持久卷為空)時,從打包的快照 seed 還原既有資料(652 團 + 白名單…)。
// DB_PATH 已存在就跳過,所以正式資料永遠不會被 seed 蓋掉。
const SEED_DB = process.env.SEED_DB || "./seed/bot.db";
if (!existsSync(DB_PATH) && existsSync(SEED_DB)) {
  copyFileSync(SEED_DB, DB_PATH);
  console.log(`[db] 持久卷為空,已從 seed 還原:${SEED_DB} → ${DB_PATH}`);
}

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id             TEXT PRIMARY KEY,
    name           TEXT,
    line_target_id TEXT,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   TEXT NOT NULL DEFAULT 'default',
    category    TEXT,
    start_date  TEXT NOT NULL,
    end_date    TEXT,
    vendor      TEXT NOT NULL,
    kol         TEXT NOT NULL,
    link_sent   INTEGER NOT NULL DEFAULT 0,
    revenue     REAL,
    commission  REAL,
    status      TEXT NOT NULL DEFAULT 'active',
    source_row  INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_camp_window ON campaigns(tenant_id, status, link_sent, start_date);
  CREATE INDEX IF NOT EXISTS idx_camp_vendor ON campaigns(tenant_id, vendor);
  -- 自然鍵:匯入冪等用(同租戶、同分類、同來源行號 視為同一列)
  CREATE UNIQUE INDEX IF NOT EXISTS idx_camp_source
    ON campaigns(tenant_id, category, source_row)
    WHERE source_row IS NOT NULL;

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   TEXT NOT NULL,
    campaign_id INTEGER,
    action      TEXT NOT NULL,
    before_json TEXT,
    after_json  TEXT,
    actor       TEXT,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_camp ON audit_log(campaign_id, ts);

  CREATE TABLE IF NOT EXISTS daily_runs (
    run_date   TEXT NOT NULL,
    tenant_id  TEXT NOT NULL,
    sent_count INTEGER NOT NULL,
    ran_at     INTEGER NOT NULL,
    PRIMARY KEY (run_date, tenant_id)
  );

  -- bot 見過的所有會話(群/room/私聊),供之後挑出要加白名單的會話 ID
  CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT PRIMARY KEY,
    type            TEXT,
    last_actor      TEXT,
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL
  );

  -- 功能白名單:只有在這裡面的會話才啟用所有功能、才會收到提醒
  CREATE TABLE IF NOT EXISTS allowlist (
    conversation_id TEXT PRIMARY KEY,
    type            TEXT,
    label           TEXT,
    added_at        INTEGER NOT NULL
  );

  -- bot 自己發出的訊息 ID(供判斷使用者是否「Reply 引用了 bot 的訊息」)
  CREATE TABLE IF NOT EXISTS bot_messages (
    message_id      TEXT PRIMARY KEY,
    conversation_id TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bot_messages_ts ON bot_messages(created_at);
`);

// ---- tenants ----
const upsertTenant = db.prepare(
  `INSERT INTO tenants (id, name, line_target_id, created_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     name = COALESCE(excluded.name, tenants.name),
     line_target_id = COALESCE(excluded.line_target_id, tenants.line_target_id)`
);
const selectTenant = db.prepare("SELECT * FROM tenants WHERE id = ?");
const selectAllTenants = db.prepare("SELECT * FROM tenants");

export function upsertTenantRow({ id, name, lineTargetId }) {
  upsertTenant.run(id, name ?? null, lineTargetId ?? null, Date.now());
}
export function getTenant(id) {
  return selectTenant.get(id) ?? null;
}
export function listTenants() {
  return selectAllTenants.all();
}

// ---- audit ----
const insertAudit = db.prepare(
  `INSERT INTO audit_log (tenant_id, campaign_id, action, before_json, after_json, actor, ts)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
export function writeAudit({ tenantId, campaignId, action, before, after, actor }) {
  insertAudit.run(
    tenantId,
    campaignId ?? null,
    action,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    actor ?? null,
    Date.now()
  );
}

// ---- daily_runs ----
const insertDailyRun = db.prepare(
  `INSERT OR IGNORE INTO daily_runs (run_date, tenant_id, sent_count, ran_at)
   VALUES (?, ?, ?, ?)`
);
const selectDailyRun = db.prepare(
  "SELECT * FROM daily_runs WHERE run_date = ? AND tenant_id = ?"
);

/** 嘗試標記今天已跑;回傳 true 代表「這次取得了執行權」(尚未跑過) */
export function claimDailyRun(runDate, tenantId, sentCount) {
  const res = insertDailyRun.run(runDate, tenantId, sentCount, Date.now());
  return res.changes > 0;
}
export function getDailyRun(runDate, tenantId) {
  return selectDailyRun.get(runDate, tenantId) ?? null;
}

// ---- conversations(會話足跡)----
const upsertConversation = db.prepare(
  `INSERT INTO conversations (conversation_id, type, last_actor, first_seen, last_seen)
   VALUES (@id, @type, @actor, @now, @now)
   ON CONFLICT(conversation_id) DO UPDATE SET
     type = excluded.type, last_actor = excluded.last_actor, last_seen = excluded.last_seen`
);
const selectConversation = db.prepare("SELECT * FROM conversations WHERE conversation_id = ?");
const selectRecentConversations = db.prepare(
  "SELECT * FROM conversations ORDER BY last_seen DESC LIMIT ?"
);

export function recordSighting({ conversationId, type, actor }) {
  upsertConversation.run({ id: conversationId, type: type ?? null, actor: actor ?? null, now: Date.now() });
}
export function getSighting(conversationId) {
  return selectConversation.get(conversationId) ?? null;
}
export function listSightings(limit = 20) {
  return selectRecentConversations.all(limit);
}

// ---- allowlist(功能白名單)----
const insertAllowed = db.prepare(
  `INSERT INTO allowlist (conversation_id, type, label, added_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(conversation_id) DO UPDATE SET
     type = COALESCE(excluded.type, allowlist.type),
     label = COALESCE(excluded.label, allowlist.label)`
);
const deleteAllowed = db.prepare("DELETE FROM allowlist WHERE conversation_id = ?");
const selectAllowed = db.prepare("SELECT 1 FROM allowlist WHERE conversation_id = ?");
const selectAllAllowed = db.prepare("SELECT * FROM allowlist ORDER BY added_at ASC");

export function addAllowed({ conversationId, type, label }) {
  insertAllowed.run(conversationId, type ?? null, label ?? null, Date.now());
}
export function removeAllowed(conversationId) {
  return deleteAllowed.run(conversationId).changes > 0;
}
export function isAllowed(conversationId) {
  if (!conversationId) return false;
  return !!selectAllowed.get(conversationId);
}
export function listAllowed() {
  return selectAllAllowed.all();
}

// ---- bot_messages(bot 發出的訊息 ID)----
const BOT_MSG_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 保留 14 天
const insertBotMessage = db.prepare(
  "INSERT OR IGNORE INTO bot_messages (message_id, conversation_id, created_at) VALUES (?, ?, ?)"
);
const selectBotMessage = db.prepare("SELECT 1 FROM bot_messages WHERE message_id = ?");
const deleteOldBotMessages = db.prepare("DELETE FROM bot_messages WHERE created_at <= ?");

export function recordBotMessage(messageId, conversationId) {
  if (!messageId) return;
  insertBotMessage.run(messageId, conversationId ?? null, Date.now());
  deleteOldBotMessages.run(Date.now() - BOT_MSG_TTL_MS);
}
export function isBotMessage(messageId) {
  if (!messageId) return false;
  return !!selectBotMessage.get(messageId);
}

/** 從環境變數 ALLOWLIST(逗號分隔的 conversation id)初始化白名單 */
export function seedAllowlistFromEnv() {
  const raw = process.env.ALLOWLIST;
  if (!raw) return 0;
  let n = 0;
  for (const id of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    addAllowed({ conversationId: id, label: "from-env" });
    n++;
  }
  return n;
}
