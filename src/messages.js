// messages.js — LINE 訊息 builder。移植自舊 Apps Script(getRandomStyledThumbnail /
// buttons / carousel),把 postback 的 sheetName+rowNumber 換成 DB campaignId。

const THUMBNAILS = [
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTbRdyRT-nYXEMiQOuiaWudpTE-tcQAL0UZVg&s",
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQ3V0x-C89O5lGJQKpCf6pwysMYfFCxOaIf0w&s",
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQEFuZEeYUYn0vRNizMvT60YV_-G-arbnwaVA&s",
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTocclkck2krlgPygagqvHPdcNHCnDXXjnb5A&s",
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRiLcXBWGv5V5K1BXOjGbozXHMSThRRj6T8Dg&s",
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSftQhDbYCsWZPpNbJqLRGoPneDneEfLNdrLw&s",
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTj92VM52tHVlKxBOCYAZDoCHQP60QGvJcagw&s",
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTVDq1Lx9oFwEcGxFCWDTqwXi9b_cdF686T5w&s",
];

const NO_CAMPAIGN_TEXT = "📣已經處理完今明兩天的所有開團📣";

export function getRandomStyledThumbnail() {
  const i = Math.floor(Math.random() * THUMBNAILS.length);
  return THUMBNAILS[i];
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function encodePostback(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v ?? "")}`)
    .join("&");
}

// 卡片標題放「日期 + 開團」確保最關鍵的開團日一定看得到(≤40 字)
function cardTitle(c) {
  return `⏰ ${c.startDate} 開團`.slice(0, 40);
}
// 卡片內文放廠商／團主(≤60 字),不塞冗長句子以免長廠商名被截斷
function cardBody(c) {
  return `${c.vendor}／${c.kol}`.slice(0, 60);
}
// 通知列/語音播報用的完整描述
function reminderAlt(c) {
  return `🚨提醒🚨:${c.kol} 的 ${c.vendor} ${c.startDate} 即將開團,請確認連結是否已給,按 OK 打勾!`;
}

function okButton(c) {
  return {
    type: "postback",
    label: "OK ✅",
    data: encodePostback({ action: "checked", campaignId: c.id, vendor: c.vendor, kol: c.kol }),
    displayText: `${c.kol}的 ${c.vendor}團 OK ✅(#${c.id})`,
  };
}

/** 把 active 提醒清單組成 LINE 訊息陣列(0 / 1 / >1 三分支,carousel 每則 10 欄)。 */
export function buildReminderMessages(list) {
  if (!list?.length) {
    return [{ type: "text", text: NO_CAMPAIGN_TEXT }];
  }

  if (list.length === 1) {
    const c = list[0];
    return [
      {
        type: "template",
        altText: reminderAlt(c).slice(0, 400),
        template: {
          type: "buttons",
          thumbnailImageUrl: getRandomStyledThumbnail(),
          imageAspectRatio: "rectangle",
          imageSize: "cover",
          imageBackgroundColor: "#FFFFFF",
          title: cardTitle(c),
          text: cardBody(c),
          actions: [okButton(c)],
        },
      },
    ];
  }

  return chunk(list, 10).map((group) => ({
    type: "template",
    altText: `🚨提醒🚨: ${list.length}個團還沒完成事前作業`.slice(0, 400),
    template: {
      type: "carousel",
      columns: group.map((c) => ({
        thumbnailImageUrl: getRandomStyledThumbnail(),
        imageBackgroundColor: "#FFFFFF",
        imageAspectRatio: "rectangle",
        title: cardTitle(c),
        text: cardBody(c),
        actions: [okButton(c)],
      })),
    },
  }));
}

/**
 * 消歧清單:多筆命中時,讓使用者點選要套用 action 的那一團。
 * action: 'move' | 'cancel' | 'backfill';extra 為要一併帶回的參數(如 start / rev / com)。
 */
export function buildCandidateList(list, action, extra = {}) {
  const labelMap = { move: "選這團改期", cancel: "取消這團", backfill: "回填這團" };
  const columns = list.slice(0, 10).map((c) => ({
    imageBackgroundColor: "#FFFFFF",
    imageAspectRatio: "rectangle",
    thumbnailImageUrl: getRandomStyledThumbnail(),
    title: `#${c.id} ${c.vendor}`.slice(0, 40),
    text: `${c.kol} / ${c.startDate}${c.category ? " / " + c.category : ""}`.slice(0, 60),
    actions: [
      {
        type: "postback",
        label: (labelMap[action] || "選這團").slice(0, 20),
        data: encodePostback({ action, id: c.id, ...extra }),
        displayText: `${labelMap[action] || "選"}:${c.vendor}(#${c.id})`,
      },
    ],
  }));
  return {
    type: "template",
    altText: `找到 ${list.length} 個符合的團,請選一個`.slice(0, 400),
    template: { type: "carousel", columns },
  };
}

export function textMessage(text) {
  return { type: "text", text: String(text).slice(0, 5000) };
}

export { NO_CAMPAIGN_TEXT };
