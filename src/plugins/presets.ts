import type { BrowserProfile } from "./registry";

export const UA_PRESETS = {
  iPhone_WebView: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49",
  iPhone_Safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  Android_WebView: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36 MicroMessenger/8.0.49",
  Android_Chrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36",
  Desktop_Chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Desktop_Safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  Baidu_Spider: "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
  Googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
} as const;

export const BROWSER_PROFILES: Record<string, BrowserProfile> = {
  wechatIPhone: {
    userAgent: UA_PRESETS.iPhone_WebView,
    acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
    platform: "iPhone",
    userAgentMetadata: {
      brands: [],
      fullVersionList: [],
      platform: "iOS",
      platformVersion: "17.4",
      architecture: "arm",
      model: "iPhone",
      mobile: true,
    },
    viewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    },
  },
  bilibiliDesktop: {
    userAgent: UA_PRESETS.Desktop_Chrome,
    acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
    platform: "Win32",
    viewport: {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1280,
      screenHeight: 720,
    },
  },
};
