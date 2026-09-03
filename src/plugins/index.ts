import { pluginRegistry } from "./registry";
import { wechatPlugin } from "./built-in";

pluginRegistry.register(wechatPlugin);

export { pluginRegistry } from "./registry";
export type { BrowserProfile, UAPlugin } from "./registry";
export { BROWSER_PROFILES, UA_PRESETS } from "./presets";
