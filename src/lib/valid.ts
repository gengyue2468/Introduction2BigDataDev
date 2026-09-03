import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parse } from "tldts";

const FILTERED_HOSTS = [
  "multimedia.nt.qq.com.cn",
  "qqdocument.qq.com",
  "docs.qq.com",
  "m.q.qq.com",
];

const IMAGE_CDN_HOSTS = [
  "pic.ugcimg.cn",
  "p.qpic.cn",
  "qpic.cn",
  "imgcache.qq.com",
  "shp.qpic.cn",
  "gchat.qpic.cn",
  "c2cpicdw.qpic.cn",
  "mmbiz.qpic.cn",
  "thirdqq.qlogo.cn",
  "q.qlogo.cn",
  "wx.qlogo.cn",
];

const SHORT_LINK_HOSTS = [
  "ourl.co",
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "short.link",
  "cutt.ly",
  "rebrand.ly",
  "shorturl.at",
  "tiny.cc",
  "bit.do",
  "b23.tv",
];

const FILE_EXTENSION_PATTERN = /\.(png|jpg|jpeg|webp|gif|bmp|svg|ico|mp4|mp3|wav|zip|rar|7z|exe|apk|pdf|docx|xlsx|pptx|txt|csv|json|xml)$/i;
const API_PATTERNS = [
  /\/api\//i,
  /\/v\d+\//,
  /\/download\//i,
  /\/upload\//i,
  /\/(jpg|png|webp|gif)\d+$/i,
];

function normalizeUrl(rawUrl: string) {
  return rawUrl.replace(/&amp;/g, "&").trim();
}

export function normalizeInputURL(rawUrl: string) {
  const url = normalizeUrl(rawUrl);

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  if (/^https?:\/[^/]/i.test(url)) {
    return url.replace(/^(https?:\/)(?!\/)/, "$1/");
  }

  if (/^(?:\/\/|www\.)[\w.-]+(?:\.[\w.-]+)+(?:[/?#].*)?$/i.test(url)) {
    return `https://${url.replace(/^\/\//, "")}`;
  }

  if (/^[\w.-]+(?:\.[\w.-]+)+(?:\:[0-9]+)?(?:[/?#].*)?$/i.test(url)) {
    return `https://${url}`;
  }

  return url;
}

export function isValidURL(rawUrl: string) {
  if (!rawUrl) {
    return false;
  }

  const url = normalizeInputURL(rawUrl);

  if (!/^https?:\/\//i.test(url)) {
    return false;
  }

  return !isFilteredUrl(url) && hasValidHostname(url);
}

/**
 * Defense-in-depth check for browser navigations. Network egress filtering is
 * still required to fully prevent DNS rebinding and unsafe subresource loads.
 */
export async function isSafeNavigationURL(rawUrl: string): Promise<boolean> {
  if (!isValidURL(rawUrl)) return false;

  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return false;
    if (url.port && url.port !== "80" && url.port !== "443") return false;

    const addresses = isIP(url.hostname)
      ? [{ address: url.hostname }]
      : await lookup(url.hostname, { all: true, verbatim: true });

    return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
  } catch {
    return false;
  }
}

function isPublicAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [first, second] = octets;
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
      return false;
    }

    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isPublicAddress(normalized.slice("::ffff:".length));
    }

    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    );
  }

  return false;
}

function hasValidHostname(url: string) {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();

    const result = parse(hostname);
    return result.domain !== null && result.isIcann === true;
  } catch {
    return false;
  }
}

function isFilteredUrl(url: string) {
  if (url.includes("CQ:") || url.includes("download?appid=")) {
    return true;
  }

  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname.toLowerCase();

    if (FILTERED_HOSTS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      return true;
    }

    if (IMAGE_CDN_HOSTS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      return true;
    }

    if (hostname === "mp.weixin.qq.com" && pathname.startsWith("/s/")) {
      const match = pathname.match(/\/s\/([a-z0-9_-]+)/i);
      if (!match || match[1] === undefined || match[1].length < 15) {
        return true;
      }
    }

    if (FILE_EXTENSION_PATTERN.test(pathname)) {
      return true;
    }

    if (!SHORT_LINK_HOSTS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      if (API_PATTERNS.some((pattern) => pattern.test(url))) {
        return true;
      }
    }
  } catch {
    return true;
  }

  return false;
}
