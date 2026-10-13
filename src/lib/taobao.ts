import * as cheerio from "cheerio";

export interface TaobaoItem {
  item_id: string;
  item_name: string;
  shop_name: string;
  daily_price: number | null;
  actual_price: number | null;
  source_url: string;
  observed_at: string;
}

export interface TaobaoItemResult extends TaobaoItem {
  error?: string;
}

export function normalizeTaobaoItemId(rawItemId: string): string | null {
  const itemId = rawItemId.trim();
  return /^\d{1,32}$/.test(itemId) ? itemId : null;
}

export function buildTaobaoItemURL(itemId: string): string {
  return `https://item.taobao.com/item.htm?id=${encodeURIComponent(itemId)}`;
}

function parsePrice(raw: string): number | null {
  const match = raw.replace(/[￥¥\s,]/g, "").match(/\d+(?:\.\d+)?/);
  if (!match) return null;

  const price = Number(match[0]);
  return Number.isFinite(price) ? price : null;
}

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function readDailyPrice($: cheerio.CheerioAPI): number | null {
  const candidates = [
    "del",
    "s",
    "[class*=originPrice]",
    "[class*=oldPrice]",
    "[class*=linePrice]",
  ];

  for (const selector of candidates) {
    const value = parsePrice($(selector).first().text());
    if (value !== null) return value;
  }

  return null;
}

export function extractTaobaoItem(
  html: string,
  itemId: string,
  sourceUrl: string,
): TaobaoItem {
  const $ = cheerio.load(html);
  const titleText = cleanText($("[class*=mainTitle]").first().text());
  const metaTitle = cleanText(
    $("meta[property='og:title']").first().attr("content") || "",
  );
  const documentTitle = cleanText($("title").first().text())
    .replace(/[-｜|]\s*(淘宝网|淘宝).*$/i, "")
    .trim();

  const shopName =
    cleanText($("[class*=shopName][title]").first().attr("title") || "") ||
    cleanText($("[class*=shopName]").first().text());

  const actualPriceSelectors = [
    // Prefer the main SKU panel over the duplicated, hidden sticky header.
    '#tbpcDetail_SkuPanelBody [class*="highlightPrice"] [class*="text"]',
    // The simplified detail page keeps the price but omits highlightPrice.
    '#tbpcDetail_SkuPanelBody [class*="block2--"] [class*="unit--"] + [class*="text--"]',
    '[class*="highlightPrice"] [class*="text"]',
    '[class*="normalPrice"] [class*="text"]',
    '[class*="priceWrap"] [class*="text"]',
  ];
  let actualPrice: number | null = null;
  for (const selector of actualPriceSelectors) {
    actualPrice = parsePrice($(selector).first().text());
    if (actualPrice !== null) break;
  }

  return {
    item_id: itemId,
    item_name: titleText || metaTitle || documentTitle,
    shop_name: shopName,
    daily_price: readDailyPrice($),
    actual_price: actualPrice,
    source_url: sourceUrl,
    observed_at: new Date().toISOString(),
  };
}
