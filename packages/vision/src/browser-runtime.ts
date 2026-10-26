import type { ResourceId, TaskId, WorkerId } from "@mediobot-v2/domain";
import type { Browser } from "playwright";
import { chromium } from "playwright";
import { PlaywrightBrowserPage, type ViewportDimensions, DEFAULT_VIEWPORT } from "./index.ts";

export interface BrowserSessionIdentity {
  readonly resourceId: ResourceId;
  readonly workerId?: WorkerId;
  readonly taskId?: TaskId;
}

export class BrowserSessionQuotaExceededError extends Error {
  readonly currentCount: number;
  readonly maxAllowed: number;
  constructor(currentCount: number, maxAllowed: number) {
    super(`Browser session quota exceeded: ${currentCount} active, max allowed ${maxAllowed}`);
    this.name = "BrowserSessionQuotaExceededError";
    this.currentCount = currentCount;
    this.maxAllowed = maxAllowed;
  }
}

export interface BrowserRuntimeOptions {
  readonly headless?: boolean;
  readonly viewport?: ViewportDimensions | null;
  readonly args?: ReadonlyArray<string>;
  readonly browserLauncher?: () => Promise<Browser>;
  readonly maxSessions?: number;
}

export interface BrowserRuntime {
  readonly isRunning: boolean;
  readonly launchCount: number;
  readonly closeCount: number;
  readonly activeSessionCount: number;
  acquireSession(
    identity: BrowserSessionIdentity,
    options?: { readonly viewport?: ViewportDimensions | null }
  ): Promise<PlaywrightBrowserPage>;
  releaseSession(resourceId: ResourceId): Promise<void>;
  shutdown(): Promise<void>;
  isHealthy(): boolean;
}

/**
 * Manages the lifetime of persistent browser process infrastructure across tasks.
 *
 * Invariant:
 * - Browser process lifetime is runtime-owned (persistent across tasks).
 * - Browser session/context/page lifetime is worker/resource-owned.
 * - Tasks/observations/actions/verifications never own browser process lifetime.
 */
export class PlaywrightBrowserRuntime implements BrowserRuntime {
  private browser?: Browser;
  private _launchCount = 0;
  private _closeCount = 0;
  private isShutdown = false;
  private launchPromise?: Promise<Browser>;
  private readonly sessions = new Map<ResourceId, {
    readonly session: PlaywrightBrowserPage;
    readonly identity: BrowserSessionIdentity;
    readonly createdAt: number;
  }>();
  private readonly options: BrowserRuntimeOptions;

  constructor(options: BrowserRuntimeOptions = {}) {
    this.options = options;
  }

  get launchCount(): number {
    return this._launchCount;
  }

  get closeCount(): number {
    return this._closeCount;
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  get isRunning(): boolean {
    return !this.isShutdown && this.browser !== undefined && this.browser.isConnected();
  }

  get underlyingBrowser(): Browser | undefined {
    return this.browser;
  }

  isHealthy(): boolean {
    if (this.isShutdown) return false;
    if (!this.browser) return true;
    return this.browser.isConnected();
  }

  private handleDisconnection(): void {
    this.browser = undefined;
    for (const [resourceId] of this.sessions) {
      this.sessions.delete(resourceId);
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.isShutdown) throw new Error("Browser runtime is shut down");
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }
    if (this.browser && !this.browser.isConnected()) {
      this.handleDisconnection();
    }
    if (this.launchPromise) {
      return this.launchPromise;
    }
    this.launchPromise = (async () => {
      try {
        const defaultArgs = this.options.headless ? [] : ["--window-size=1280,820"];
        const args = this.options.args ? [...this.options.args] : defaultArgs;
        const browser = this.options.browserLauncher
          ? await this.options.browserLauncher()
          : await chromium.launch({
              headless: this.options.headless ?? false,
              ...(args.length > 0 ? { args } : {}),
            });
        this.browser = browser;
        this._launchCount += 1;
        browser.on("disconnected", () => {
          this.handleDisconnection();
        });
        return browser;
      } finally {
        this.launchPromise = undefined;
      }
    })();
    return this.launchPromise;
  }

  async acquireSession(
    identity: BrowserSessionIdentity,
    options?: { readonly viewport?: ViewportDimensions | null }
  ): Promise<PlaywrightBrowserPage> {
    if (this.isShutdown) throw new Error("Browser runtime is shut down");
    if (this.sessions.has(identity.resourceId)) {
      throw new Error(`Browser session is already active for resource: ${identity.resourceId}`);
    }
    if (this.options.maxSessions !== undefined && this.sessions.size >= this.options.maxSessions) {
      throw new BrowserSessionQuotaExceededError(this.sessions.size, this.options.maxSessions);
    }
    const browser = await this.ensureBrowser();
    const viewport = options?.viewport !== undefined
      ? options.viewport
      : (this.options.viewport !== undefined ? this.options.viewport : DEFAULT_VIEWPORT);

    const session = await PlaywrightBrowserPage.launch({
      resourceId: identity.resourceId,
      browser,
      headless: this.options.headless ?? false,
      viewport,
      onClose: async () => {
        this.sessions.delete(identity.resourceId);
      },
    });

    this.sessions.set(identity.resourceId, {
      session,
      identity,
      createdAt: Date.now(),
    });

    return session;
  }

  async releaseSession(resourceId: ResourceId): Promise<void> {
    const entry = this.sessions.get(resourceId);
    if (!entry) return;
    this.sessions.delete(resourceId);
    await entry.session.close();
  }

  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;
    const active = [...this.sessions.values()];
    this.sessions.clear();
    for (const entry of active) {
      try {
        await entry.session.close();
      } catch {
        /* best-effort session cleanup */
      }
    }
    if (this.browser) {
      this._closeCount += 1;
      const b = this.browser;
      this.browser = undefined;
      if (b.isConnected()) {
        await b.close();
      }
    }
  }
}
