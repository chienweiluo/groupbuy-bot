// importSheet.js — 一次性把 Google Sheet 匯出的 CSV 匯入資料庫。
// 用法:
//   node src/importSheet.js import.config.json [--dry]
//
// config 格式(對照舊 getSheetConfigMap 的欄位設定):
// {
//   "tenantId": "default",
//   "files": [
//     {
//       "path": "./csv/潔淨學.csv",
//       "category": "美妝",
//       "startRow": 2,                       // 資料起始列號(1-based,跳過表頭)
//       "cols": { "period":0, "vendor":1, "kol":2, "check":3, "revenue":4, "commission":5 }
//     }
//   ]
// }
// cols 用 0-based 欄位索引;revenue/commission 可省略。

import { readFileSync } from "node:fs";
import { createCampaign, DEFAULT_TENANT } from "./campaigns.js";
import { getStartAndEndDates, INVALID } from "./dates.js";

// --- 極簡 RFC4180 CSV 解析(支援引號、逗號、換行) ---
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const CHECK_TRUE = /[✅✔☑]|^(true|yes|y|1|是|已|done|ok)$/i;
function isChecked(cell) {
  const v = String(cell ?? "").trim();
  return !!v && CHECK_TRUE.test(v);
}
function toNumber(cell) {
  const v = String(cell ?? "").replace(/[,$\s]/g, "").trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function importFile(file, tenantId, { dry = false } = {}) {
  const text = readFileSync(file.path, "utf8");
  const rows = parseCsv(text);
  const startRow = file.startRow ?? 2;
  const c = file.cols;
  const stats = { imported: 0, skipped: 0, invalid: 0, duplicate: 0 };

  rows.forEach((cells, idx) => {
    const rowNumber = idx + 1; // 1-based
    if (rowNumber < startRow) return;
    if (cells.every((x) => !String(x).trim())) return; // 空列

    const periodRaw = cells[c.period];
    const vendor = String(cells[c.vendor] ?? "").trim();
    const kol = String(cells[c.kol] ?? "").trim();
    if (!vendor || !kol) { stats.skipped++; return; }

    const { startDate } = getStartAndEndDates(periodRaw);
    if (startDate === INVALID) { stats.invalid++; return; }

    const input = {
      tenantId,
      category: file.category,
      periodRaw,
      vendor,
      kol,
      linkSent: c.check != null ? isChecked(cells[c.check]) : false,
      revenue: c.revenue != null ? toNumber(cells[c.revenue]) : null,
      commission: c.commission != null ? toNumber(cells[c.commission]) : null,
      sourceRow: rowNumber,
    };

    if (dry) { stats.imported++; return; }
    try {
      const res = createCampaign(input, "import");
      if (res.ok) stats.imported++;
      else stats.invalid++;
    } catch (err) {
      // 唯一鍵(tenant, category, source_row)衝突 → 已匯入過,跳過(冪等)
      if (String(err.message).includes("UNIQUE")) stats.duplicate++;
      else throw err;
    }
  });

  return stats;
}

function main() {
  const configPath = process.argv[2];
  const dry = process.argv.includes("--dry");
  if (!configPath) {
    console.error("用法: node src/importSheet.js <config.json> [--dry]");
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const tenantId = config.tenantId || DEFAULT_TENANT;
  const totals = { imported: 0, skipped: 0, invalid: 0, duplicate: 0 };

  for (const file of config.files) {
    const s = importFile(file, tenantId, { dry });
    console.log(`[${file.category || file.path}]`, s);
    for (const k of Object.keys(totals)) totals[k] += s[k];
  }
  console.log(dry ? "DRY RUN 合計:" : "匯入合計:", totals);
}

// 只有被當成腳本直接執行時才跑 main(被 import 時不跑)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
