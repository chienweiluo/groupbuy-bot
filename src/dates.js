import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(customParseFormat);

export const INVALID = "invalid date";
const ISO = "YYYY-MM-DD";

// 擷取「含 4 位數年份」的日期 token,例:2025/01/01 或 2025-1-1。
// 因為年份固定 4 位,夾在兩段日期中間的連字號(範圍分隔)不會被誤吃。
const DATE_TOKEN = /\d{4}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{1,2}/g;

const DATE_FORMATS = [
  "YYYY/MM/DD", "YYYY/M/D", "YYYY/MM/D", "YYYY/M/DD",
  "YYYY-MM-DD", "YYYY-M-D", "YYYY-MM-D", "YYYY-M-DD",
  "YYYY.MM.DD", "YYYY.M.D",
];

function toIso(token) {
  const cleaned = String(token).replace(/\s+/g, "");
  const d = dayjs(cleaned, DATE_FORMATS, true);
  return d.isValid() ? d.format(ISO) : INVALID;
}

/**
 * 把「檔期」拆成 { startDate, endDate }(皆 'YYYY-MM-DD' 或 'invalid date')。
 * 接受字串 "2025/01/01-2025/01/07"、單一日期、或 Date 物件。
 * 對齊舊 Apps Script 的 getStartAndEndDates。
 */
export function getStartAndEndDates(raw) {
  if (raw == null || raw === "") return { startDate: INVALID, endDate: INVALID };

  // Sheet getValues 可能回 Date 物件
  if (raw instanceof Date) {
    const d = dayjs(raw);
    const iso = d.isValid() ? d.format(ISO) : INVALID;
    return { startDate: iso, endDate: iso };
  }

  const tokens = String(raw).match(DATE_TOKEN) || [];
  if (tokens.length === 0) return { startDate: INVALID, endDate: INVALID };

  const startDate = toIso(tokens[0]);
  const endDate = tokens[1] ? toIso(tokens[1]) : startDate;
  return { startDate, endDate };
}

/**
 * 解析使用者自然語言/指令輸入的單一日期。支援:
 *   2026-04-10 / 2026/4/10 / 4/10 / 4月10日 / 04-10(無年份則補「下一個未到的該日」)
 * 回傳 'YYYY-MM-DD' 或 INVALID。
 */
export function parseInputDate(input, base = dayjs()) {
  if (!input) return INVALID;
  const s = String(input).trim().replace(/年|月/g, "/").replace(/日/g, "");

  // 帶 4 位年份
  let d = dayjs(s.replace(/\s+/g, ""), DATE_FORMATS, true);
  if (d.isValid()) return d.format(ISO);

  // 只有月/日 → 補年份(若該日已過則用明年,避免把「改期」排到過去)
  const md = s.match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    let candidate = dayjs(
      `${base.year()}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      ISO,
      true
    );
    if (!candidate.isValid()) return INVALID;
    if (candidate.isBefore(base.startOf("day"))) candidate = candidate.add(1, "year");
    return candidate.format(ISO);
  }
  return INVALID;
}

export function today() {
  return dayjs().startOf("day");
}

/**
 * start_date 是否落在提醒視窗內:今天 ≤ start < 今天 + windowDays。
 * 對齊舊腳本 isWithinSevenDays(預設 7 天)。
 */
export function isWithinWindow(startDateIso, windowDays = 7, base = today()) {
  if (!startDateIso || startDateIso === INVALID) return false;
  const start = dayjs(startDateIso, ISO, true).startOf("day");
  if (!start.isValid()) return false;
  const until = base.add(windowDays, "day").endOf("day");
  return (start.isSame(base) || start.isAfter(base)) && start.isBefore(until);
}

/** 'YYYY-MM' 期間的起訖(供月結/查詢用),回傳 { since, until } 為 'YYYY-MM-DD' */
export function monthRange(yyyymm) {
  const m = dayjs(yyyymm, "YYYY-MM", true);
  if (!m.isValid()) return null;
  return {
    since: m.startOf("month").format(ISO),
    until: m.endOf("month").format(ISO),
    label: m.format("YYYY年M月"),
  };
}

/** 上一個月的 'YYYY-MM' */
export function lastMonth(base = dayjs()) {
  return base.subtract(1, "month").format("YYYY-MM");
}

export { dayjs };
