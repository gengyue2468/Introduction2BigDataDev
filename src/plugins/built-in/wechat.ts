import type { UAPlugin } from "../registry";
import { BROWSER_PROFILES } from "../presets";

const WECHAT_DOMAINS = [
  "mp.weixin.qq.com",
  "channels.weixin.qq.com",
  "weixin.qq.com",
  "open.weixin.qq.com",
];

const wechatPlugin: UAPlugin = {
  name: "wechat",
  match(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return WECHAT_DOMAINS.some((domain) => hostname === domain || hostname.endsWith("." + domain));
    } catch {
      return false;
    }
  },
  getProfile(_url: string) {
    return BROWSER_PROFILES.wechatIPhone;
  },
};

export default wechatPlugin;
