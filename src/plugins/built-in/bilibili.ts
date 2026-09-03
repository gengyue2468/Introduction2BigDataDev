import type { UAPlugin } from "../registry";
import { BROWSER_PROFILES } from "../presets";

const BILIBILI_DOMAINS = [
  "www.bilibili.com",
  "m.bilibili.com",
  "b23.tv",
  "bilibili.com",
];

const bilibiliPlugin: UAPlugin = {
  name: "bilibili",
  match(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return BILIBILI_DOMAINS.some(
        (domain) => hostname === domain || hostname.endsWith("." + domain),
      );
    } catch {
      return false;
    }
  },
  getProfile(_url: string) {
    return BROWSER_PROFILES.bilibiliDesktop;
  },
};

export default bilibiliPlugin;
