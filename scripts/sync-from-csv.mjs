#!/usr/bin/env node
/**
 * sync-from-csv.mjs — 用一份排程 CSV 同步後台的開團資料(讓資料庫 = CSV)。
 *
 * 透過後台 HTTP API 操作(POST /campaigns/bulk、PATCH、DELETE),所以對「本機」
 * 或「Railway 正式站」都適用,只要給對 URL 與 ADMIN_TOKEN。
 *
 * 同步語意(以 廠商|團主|開團日 為自然鍵):
 *   ➕ 新增   CSV 有、DB 沒有的列(帶連結;若 CSV 有業績/分潤% 也會帶入)
 *   🔗 補勾   CSV 標 ✅、DB 還沒勾的 → 設為已給連結(預設不會把已勾的退回)
 *   🗑 刪除   DB 有、CSV 沒有的列(被改期的舊日期殘留、測試列…)
 *   = 結果    DB 的該分類 == CSV
 *
 * 預設「試算(dry-run)」只印計畫不寫入;加 --execute 才會動手,且動手前一定先備份。
 * 新增列的 sourceRow 會 +100000 偏移,避免和既有 seed 撞 UNIQUE,並讓本腳本可重複執行。
 *
 * 用法:
 *   node scripts/sync-from-csv.mjs <csv路徑> [選項]
 *
 * 選項:
 *   --execute              真的寫入(不加 = 只試算)
 *   --url=<base>           後台網址(預設 env ADMIN_URL,再預設 http://localhost:3000)
 *   --token=<token>        ADMIN_TOKEN(預設 env ADMIN_TOKEN)
 *   --category=<名稱>      要同步/新增的分類(預設「2026排程」)
 *   --mirror-links         連結狀態完全對齊 CSV(連 DB 已勾、CSV 空白的也退回;預設不退回)
 *   --no-delete            不刪除 DB 多出來的列(只做新增+補勾)
 *   --backup-dir=<路徑>    備份輸出資料夾(預設 <repo>/backups)
 *
 * CSV 欄位(0-based,對齊 Google Sheet 匯出):
 *   1=檔期(YYYY/MM/DD-YYYY/MM/DD)  2=廠商  3=KOL(團主)  4=分潤(%)  5=連結給了嗎(✅/V)  6=業績
 *
 * 範例:
 *   node scripts/sync-from-csv.mjs ~/Downloads/排程.csv \
 *     --url=https://xxx.up.railway.app --token=$ADMIN_TOKEN          # 試算
 *   node scripts/sync-from-csv.mjs ~/Downloads/排程.csv --url=... --token=... --execute
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else positional.push(a);
}
const csvPath = positional[0];
if (!csvPath) {
  console.error("用法: node scripts/sync-from-csv.mjs <csv路徑> [--execute --url=... --token=... --category=...]");
  process.exit(1);
}
const URL_BASE = (flags.url || process.env.ADMIN_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = flags.token || process.env.ADMIN_TOKEN || "";
const CATEGORY = flags.category || "2026排程";
const EXECUTE = !!flags.execute;
const MIRROR_LINKS = !!flags["mirror-links"];
const DO_DELETE = !flags["no-delete"];
const BACKUP_DIR = flags["backup-dir"] || join(REPO_ROOT, "backups");
if (!TOKEN) { console.error("缺少 ADMIN_TOKEN(用 --token= 或環境變數 ADMIN_TOKEN)"); process.exit(1); }

// ---------- api ----------
async function api(path, opts = {}) {
  const r = await fetch(URL_BASE + "/admin/api" + path, {
    ...opts,
    headers: { "x-admin-token": TOKEN, ...(opts.body ? { "content-type": "application/json" } : {}) },
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
  return d;
}

// ---------- CSV ----------
function parseCSV(t) {
  const R = [];
  let r = [], c = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else { if (ch === '"') q = true; else if (ch === ",") { r.push(c); c = ""; } else if (ch === "\n") { r.push(c); R.push(r); r = []; c = ""; } else if (ch === "\r") { } else c += ch; }
  }
  if (c.length || r.length) { r.push(c); R.push(r); }
  return R;
}
const pad = (n) => String(n).padStart(2, "0");
function parsePeriod(p) {
  const isos = String(p).trim().match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/g);
  if (!isos) return null;
  const toIso = (s) => { const m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/); return `${m[1]}-${pad(m[2])}-${pad(m[3])}`; };
  return { start: toIso(isos[0]), end: isos[1] ? toIso(isos[1]) : toIso(isos[0]) };
}
const num = (s) => { const t = String(s || "").replace(/[,\s$]/g, "").trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const rate = (s) => { const t = String(s || "").replace(/[%\s]/g, "").trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };

function loadCsv() {
  const rows = parseCSV(readFileSync(csvPath, "utf8"));
  const out = [], skipped = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const per = parsePeriod(r[1] || "");
    const vendor = (r[2] || "").trim(), kol = (r[3] || "").trim();
    if (!per) { if ((r[1] || vendor || kol).trim()) skipped.push(`row${i + 1}: 無法解析檔期 ${JSON.stringify(r[1])}`); continue; }
    if (!vendor || !kol) { skipped.push(`row${i + 1}: 缺廠商或團主`); continue; }
    const revenue = num(r[6]);
    const rt = rate(r[4]);
    out.push({
      key: `${vendor}|${kol}|${per.start}`,
      vendor, kol, start: per.start, end: per.end,
      link: /[✅vV]/.test((r[5] || "").trim()),
      revenue,
      commission: revenue != null && rt != null ? Math.round(revenue * rt / 100) : null,
      sourceRow: i + 1,
    });
  }
  return { out, skipped };
}

// ---------- fetch all ----------
async function fetchAll() {
  let page = 1, all = [], total = Infinity;
  while (all.length < total) {
    const r = await api(`/campaigns?status=&pageSize=500&page=${page}`);
    all.push(...r.rows); total = r.total; page++;
    if (!r.rows.length) break;
  }
  return all;
}

// ---------- main ----------
console.log(`同步來源 CSV : ${csvPath}`);
console.log(`目標後台     : ${URL_BASE}  分類: ${CATEGORY}`);
console.log(`模式         : ${EXECUTE ? "執行(會寫入)" : "試算(dry-run)"}\n`);

const { out: csv, skipped } = loadCsv();
const all = await fetchAll();

const dbByKey = new Map();
all.forEach((c) => dbByKey.set(`${c.vendor}|${c.kol}|${c.startDate}`, c));
const csvKeys = new Set(csv.map((c) => c.key));

const inserts = csv.filter((c) => !dbByKey.has(c.key));
const linkUpgrades = csv.filter((c) => { const d = dbByKey.get(c.key); return d && c.link && !d.linkSent; }).map((c) => dbByKey.get(c.key));
const linkDowngrades = MIRROR_LINKS
  ? csv.filter((c) => { const d = dbByKey.get(c.key); return d && !c.link && d.linkSent; }).map((c) => dbByKey.get(c.key))
  : [];
const linkKept = csv.filter((c) => { const d = dbByKey.get(c.key); return d && !c.link && d.linkSent; }).length;
const deletes = DO_DELETE ? all.filter((c) => !csvKeys.has(`${c.vendor}|${c.kol}|${c.startDate}`)) : [];

console.log(`CSV 可用列: ${csv.length}  目標後台現有: ${all.length}` + (skipped.length ? `  (CSV 跳過 ${skipped.length} 列)` : ""));
console.log(`計畫:`);
console.log(`  ➕ 新增: ${inserts.length}`);
console.log(`  🔗 連結補勾(false→true): ${linkUpgrades.length}` + (MIRROR_LINKS ? `   退回(true→false): ${linkDowngrades.length}` : `   (保留 DB 已勾、CSV 空白: ${linkKept})`));
console.log(`  🗑  刪除(CSV 沒有): ${deletes.length}` + (DO_DELETE ? "" : "  [--no-delete 已關閉]"));

if (inserts.length) { console.log(`\n--- 新增 ---`); inserts.forEach((c) => console.log(`  + ${c.start}~${c.end} ${c.vendor} / ${c.kol}${c.link ? " ✅" : ""}${c.revenue != null ? " 業績$" + c.revenue : ""}`)); }
if (deletes.length) { console.log(`\n--- 刪除(請檢查)---`); deletes.forEach((c) => console.log(`  - #${c.id} ${c.startDate} ${c.vendor} / ${c.kol} [${c.category || "—"}]${c.revenue != null ? " 業績$" + c.revenue : ""}`)); }
if (skipped.length) { console.log(`\n--- CSV 跳過列 ---`); skipped.slice(0, 30).forEach((s) => console.log("  " + s)); }

if (!EXECUTE) { console.log(`\n(試算模式;確認無誤後加 --execute 執行)`); process.exit(0); }

// ---------- backup ----------
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(BACKUP_DIR, `backup-${stamp}.json`);
writeFileSync(backupPath, JSON.stringify(all, null, 2));
console.log(`\n✅ 已備份 ${all.length} 筆 → ${backupPath}`);

// ---------- execute ----------
console.log(`=== 開始執行 ===`);
let created = 0; const insFail = [];
for (let i = 0; i < inserts.length; i += 250) {
  const batch = inserts.slice(i, i + 250).map((c) => ({
    startDate: c.start, endDate: c.end, vendor: c.vendor, kol: c.kol,
    linkSent: c.link, revenue: c.revenue ?? undefined, commission: c.commission ?? undefined,
    category: CATEGORY, sourceRow: 100000 + c.sourceRow,
  }));
  const r = await api("/campaigns/bulk", { method: "POST", body: JSON.stringify({ items: batch }) });
  created += r.created;
  r.results.filter((x) => !x.ok).forEach((x) => insFail.push(`${batch[x.index].vendor}/${batch[x.index].kol}: ${x.error}`));
}
console.log(`➕ 新增: ${created}/${inserts.length}` + (insFail.length ? ` 失敗 ${insFail.length}` : ""));
insFail.slice(0, 20).forEach((s) => console.log("   ✗ " + s));

let up = 0;
for (const d of [...linkUpgrades.map((x) => [x.id, true]), ...linkDowngrades.map((x) => [x.id, false])]) {
  try { await api(`/campaigns/${d[0]}`, { method: "PATCH", body: JSON.stringify({ linkSent: d[1] }) }); up++; } catch (e) { console.log(`   ✗ link #${d[0]}: ${e.message}`); }
}
console.log(`🔗 連結更新: ${up}/${linkUpgrades.length + linkDowngrades.length}`);

let del = 0;
for (const d of deletes) { try { await api(`/campaigns/${d.id}`, { method: "DELETE" }); del++; } catch (e) { console.log(`   ✗ del #${d.id}: ${e.message}`); } }
console.log(`🗑  刪除: ${del}/${deletes.length}`);

const after = await fetchAll();
console.log(`\n=== 完成 === 目標後台現有 ${after.length} 筆(CSV ${csv.length})`);
console.log(`還原:如需回復,備份在 ${backupPath}`);
