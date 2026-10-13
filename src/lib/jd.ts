import * as cheerio from "cheerio";

export interface JdItem {
  sku_id: string;
  item_name: string;
  shop_name: string;
  daily_price: number | null;
  actual_price: number | null;
  source_url: string;
  observed_at: string;
}

export interface JdItemResult extends JdItem {
  error?: string;
}

export function normalizeSkuId(rawSkuId: string): string | null {
  const skuId = rawSkuId.trim();
  return /^\d{1,32}$/.test(skuId) ? skuId : null;
}

export function buildJdItemURL(skuId: string): string {
  return `https://item.jd.com/${encodeURIComponent(skuId)}.html`;
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
  const pricePanel = $(".product-price--gray")
    .filter((_, element) => cleanText($(element).text()).includes("日常价"))
    .first();

  if (!pricePanel.length) return null;

  // 当前京东 DOM 中，第一个 span 是价格，第二个 span 是“日常价”标签。
  return parsePrice(pricePanel.children("span").first().text());
}

export function extractJdItem(
  html: string,
  skuId: string,
  sourceUrl: string,
): JdItem {
  const $ = cheerio.load(html);

  const itemName =
    cleanText($(".sku-title-name").first().text()) ||
    cleanText($("meta[property='og:title']").first().attr("content") || "") ||
    cleanText($("title").first().text());

  const shopName =
    cleanText($(".top-name[title]").first().attr("title") || "") ||
    cleanText($(".top-name").first().text());

  const actualPrice = parsePrice($(".product-price--value").first().text());

  return {
    sku_id: skuId,
    item_name: itemName,
    shop_name: shopName,
    daily_price: readDailyPrice($),
    actual_price: actualPrice,
    source_url: sourceUrl,
    observed_at: new Date().toISOString(),
  };
}
