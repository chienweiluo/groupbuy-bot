// allowlist.js — 白名單管理 CLI。
// 用法:
//   node src/allowlist.js list                     列出白名單
//   node src/allowlist.js seen [n]                 列出 bot 最近見過的會話(挑 ID 用)
//   node src/allowlist.js add <conversationId> [label]
//   node src/allowlist.js remove <conversationId>

import {
  addAllowed,
  removeAllowed,
  listAllowed,
  listSightings,
  getSighting,
} from "./db.js";

function fmtTs(ts) {
  return ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 19) : "-";
}

const [cmd, arg1, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "list": {
    const rows = listAllowed();
    if (!rows.length) { console.log("(白名單是空的)"); break; }
    for (const r of rows) {
      console.log(`✅ ${r.conversation_id}  [${r.type ?? "?"}]  ${r.label ?? ""}  added=${fmtTs(r.added_at)}`);
    }
    break;
  }
  case "seen": {
    const n = Number(arg1) || 20;
    const rows = listSightings(n);
    if (!rows.length) { console.log("(還沒見過任何會話)"); break; }
    for (const r of rows) {
      console.log(`${r.conversation_id}  [${r.type ?? "?"}]  actor=${r.last_actor ?? "-"}  lastSeen=${fmtTs(r.last_seen)}`);
    }
    break;
  }
  case "add": {
    if (!arg1) { console.error("用法: node src/allowlist.js add <conversationId> [label]"); process.exit(1); }
    const seen = getSighting(arg1);
    addAllowed({ conversationId: arg1, type: seen?.type, label: rest.join(" ") || null });
    console.log(`✅ 已加入白名單: ${arg1} [${seen?.type ?? "?"}]`);
    break;
  }
  case "remove": {
    if (!arg1) { console.error("用法: node src/allowlist.js remove <conversationId>"); process.exit(1); }
    console.log(removeAllowed(arg1) ? `🗑️ 已移除: ${arg1}` : `找不到: ${arg1}`);
    break;
  }
  default:
    console.log("用法:\n  node src/allowlist.js list\n  node src/allowlist.js seen [n]\n  node src/allowlist.js add <conversationId> [label]\n  node src/allowlist.js remove <conversationId>");
}
