export interface UserAgentBrandVersion {
  brand: string;
  version: string;
}

export interface UserAgentMetadata {
  brands?: UserAgentBrandVersion[];
  fullVersionList?: UserAgentBrandVersion[];
  platform?: string;
  platformVersion?: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness?: string;
  wow64?: boolean;
  formFactors?: string[];
}

export interface BrowserProfile {
  userAgent: string;
  acceptLanguage?: string;
  platform?: string;
  userAgentMetadata?: UserAgentMetadata;
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
    screenWidth?: number;
    screenHeight?: number;
  };
}

export interface UAPlugin {
  name: string;
  match(url: string): boolean;
  getProfile(url: string): BrowserProfile;
}

class UAPluginRegistry {
  private plugins: UAPlugin[] = [];

  register(plugin: UAPlugin): void {
    this.plugins.push(plugin);
  }

  resolve(url: string): BrowserProfile | null {
    for (const plugin of this.plugins) {
      if (plugin.match(url)) {
        return plugin.getProfile(url);
      }
    }
    return null;
  }

  getAll(): UAPlugin[] {
    return [...this.plugins];
  }
}

export const pluginRegistry = new UAPluginRegistry();
