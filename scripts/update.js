import fs from "node:fs";
import path from "node:path";
import RSS from "rss";

const LANG = "en";
const SEARCH_URL = `https://orders-in-council.canada.ca/index.php?lang=${LANG}`;

const KEYWORDS = [
  "cannabis",
  "vaping",
  "excise",
  "liquor",
  "alcohol",
  "drug",
  "drugs",
  "proceeds of crime",
  "contraventions"
];

// Be polite: only inspect the first N results per keyword per run
const CHECK_LIMIT_PER_KEYWORD = 40;
const MAX_FEED_ITEMS = 80;

// Files we persist in the repo
const DATA_DIR = "data";
const ITEMS_PATH = path.join(DATA_DIR, "items.json");
const FEED_PATH = "feed.xml";

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}
function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

async function postSearch(keyword) {
  const body = new URLSearchParams();
  body.set("keywords", keyword);
  body.set("searchList", "Search / List");

  // Other form fields exist but can be blank; server accepts this minimal set
  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "OIC-Keyword-RSS/1.0 (polite polling)"
    },
    body: body.toString()
  });

  if (!res.ok) throw new Error(`Search failed (${keyword}): ${res.status}`);
  return await res.text();
}

function extractAttachIds(html) {
  const ids = [];
  const re = /attachment\.php\?attach=(\d+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) ids.push(Number(m[1]));
  // de-dupe preserving order
  return [...new Set(ids)];
}

async function fetchAttachmentMeta(attachId) {
  const url = `https://orders-in-council.canada.ca/attachment.php?attach=${attachId}&lang=${LANG}`;
  const res = await fetch(url, {
    headers: { "user-agent": "OIC-Keyword-RSS/1.0 (polite polling)" }
  });
  if (!res.ok) throw new Error(`Attachment failed (${attachId}): ${res.status}`);
  const html = await res.text();

  // These pages typically include "PC Number: YYYY-NNNN" and "Date: YYYY-MM-DD"
  const pc = html.match(/PC Number:\s*([0-9]{4}-[0-9]{4})/i)?.[1] ?? null;
  const date = html.match(/Date:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i)?.[1] ?? null;

  // Try to grab a reasonable title if present (fallback to PC / attachId)
  // This is conservative to avoid breaking if markup changes.
  const titleFallback = pc ? `Order in Council ${pc}` : `Order in Council (attach ${attachId})`;

  return { url, pc, date, title: titleFallback };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function buildRss(items) {
  const feed = new RSS({
    title: "Orders in Council: keyword watch (EN)",
    description: `Auto-generated RSS for keywords: ${KEYWORDS.join(", ")}`,
    site_url: SEARCH_URL,
    feed_url: "feed.xml",
    language: "en"
  });

  for (const it of items) {
    const kw = (it.keywords || []).slice().sort().join(", ");
    const descParts = [];
    if (it.pc) descParts.push(`PC Number: ${it.pc}`);
    if (it.date) descParts.push(`Date: ${it.date}`);
    if (kw) descParts.push(`Keywords: ${kw}`);

    feed.item({
      title: it.title,
      url: it.url,
      guid: String(it.attachId),
      date: it.date ? new Date(it.date).toISOString() : undefined,
      description: descParts.join("<br/>")
    });
  }

  return feed.xml({ indent: true });
}

async function main() {
  // Load previous items
  /** @type {Array<{attachId:number,url:string,pc?:string|null,date?:string|null,title:string,keywords:string[]}>} */
  const existing = readJson(ITEMS_PATH, []);
  const byId = new Map(existing.map(x => [x.attachId, x]));

  // Map attachId -> set(keywords found this run)
  const foundThisRun = new Map();

  // 1) Search per keyword, collect attach IDs
  for (const kw of KEYWORDS) {
    const html = await postSearch(kw);
    const ids = extractAttachIds(html).slice(0, CHECK_LIMIT_PER_KEYWORD);

    for (const id of ids) {
      if (!foundThisRun.has(id)) foundThisRun.set(id, new Set());
      foundThisRun.get(id).add(kw);
    }

    // small pause between keyword searches (polite)
    await sleep(600);
  }

  // 2) For new attachIds, fetch attachment page for meta
  const newIds = [...foundThisRun.keys()].filter(id => !byId.has(id));
  // Heuristic: higher attachId often newer; fetch higher first
  newIds.sort((a, b) => b - a);

  for (const id of newIds) {
    const meta = await fetchAttachmentMeta(id);
    byId.set(id, {
      attachId: id,
      url: meta.url,
      pc: meta.pc,
      date: meta.date,
      title: meta.title,
      keywords: []
    });
    // small pause between attachment fetches (polite)
    await sleep(500);
  }

  // 3) Merge keyword sets into stored items
  for (const [id, kws] of foundThisRun.entries()) {
    const item = byId.get(id);
    const merged = new Set([...(item.keywords || []), ...kws]);
    item.keywords = [...merged];
  }

  // 4) Sort and keep feed size under control
  const mergedItems = [...byId.values()]
    .sort((a, b) => {
      const ad = a.date || "";
      const bd = b.date || "";
      if (bd !== ad) return bd.localeCompare(ad);
      return b.attachId - a.attachId;
    })
    .slice(0, MAX_FEED_ITEMS);

  writeJson(ITEMS_PATH, mergedItems);

  const rssXml = buildRss(mergedItems);
  fs.writeFileSync(FEED_PATH, rssXml);

  console.log(`Updated: ${mergedItems.length} items (new IDs this run: ${newIds.length})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
