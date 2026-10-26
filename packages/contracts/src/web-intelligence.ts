import type { TaskId } from "@mediobot-v2/domain";
import type { TaskPriority } from "./resource-governor.ts";

export interface WebSearchRequest {
  readonly query: string;
  readonly maxResults?: number;
  readonly allowedDomains?: ReadonlyArray<string>;
  readonly filterType?: "all" | "documentation" | "components" | "articles";
}

export interface WebSearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly source: string;
}

export interface WebSearchResult {
  readonly query: string;
  readonly items: ReadonlyArray<WebSearchResultItem>;
  readonly totalMatches: number;
  readonly providerStatus?: "ok" | "empty" | "challenge" | "unavailable";
}

export interface CrawlExtractOptions {
  readonly cssSelector?: string;
  readonly extractMarkdown?: boolean;
  readonly extractLinks?: boolean;
  readonly extractMedia?: boolean;
  readonly removeSelectors?: ReadonlyArray<string>;
  readonly targetType?: "component" | "documentation" | "article" | "general";
}

export interface CrawlRequest {
  readonly url: string;
  readonly taskId: TaskId;
  readonly workspaceId?: string | null;
  readonly priority?: TaskPriority;
  readonly waitForSelector?: string;
  readonly renderJs?: boolean;
  readonly jsExecution?: boolean;
  readonly preferHttp?: boolean;
  readonly maxDepth?: number;
  readonly followLinks?: boolean;
  readonly screenshot?: boolean;
  readonly cacheMode?: "enabled" | "bypass" | "read-only";
  readonly timeoutMs?: number;
  readonly extractOptions?: CrawlExtractOptions;
  readonly allowedDestinations?: ReadonlyArray<string>;
}

export interface CrawledLink {
  readonly text: string;
  readonly href: string;
}

export interface CrawledMedia {
  readonly type: "image" | "video";
  readonly src: string;
  readonly alt?: string;
}

export interface ProvenanceRecord {
  readonly sourceUrl: string;
  readonly accessedAt: number;
  readonly contentHash: string;
  readonly license?: string;
  readonly authorOrVendor?: string;
  readonly documentedVersion?: string;
}

export interface UntrustedWebContent {
  readonly rawContent: string;
  readonly safeExcerpt: string;
  readonly provenance: ProvenanceRecord;
  readonly untrusted: true;
  readonly sanitized: boolean;
  readonly promptInjectionFlags: ReadonlyArray<string>;
}

export interface CrawlResult {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly success: boolean;
  readonly markdown: string;
  readonly cleanedHtml?: string;
  readonly title?: string;
  readonly links: ReadonlyArray<CrawledLink>;
  readonly media: ReadonlyArray<CrawledMedia>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly cached: boolean;
  readonly sanitized: boolean;
  readonly provenance: ProvenanceRecord;
  readonly promptInjectionFlags: ReadonlyArray<string>;
  readonly durationMs: number;
  readonly errorMessage?: string;
}

// --- Specialist Structured Contracts ---

export interface ScraapyComponentReference {
  readonly name: string;
  readonly category: "component" | "animation" | "icon" | "layout" | "style";
  readonly sourceUrl: string;
  readonly sourceRepo?: string;
  readonly license: string;
  readonly codeSnippet: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly stylingApproach: string;
  readonly visualSummary: string;
  readonly integrationNotes: string;
  readonly provenance: ProvenanceRecord;
}

export interface ScraapyResult {
  readonly query: string;
  readonly components: ReadonlyArray<ScraapyComponentReference>;
  readonly creativeRecommendations: string;
  readonly licenseSummary: Readonly<Record<string, number>>;
}

export interface ResearchComparisonItem {
  readonly name: string;
  readonly description: string;
  readonly pros: ReadonlyArray<string>;
  readonly cons: ReadonlyArray<string>;
  readonly recommended: boolean;
}

export interface ResearchFinding {
  readonly topic: string;
  readonly summary: string;
  readonly comparisons: ReadonlyArray<ResearchComparisonItem>;
  readonly technicalRisks: ReadonlyArray<string>;
  readonly recommendedArchitecture: string;
  readonly sources: ReadonlyArray<ProvenanceRecord>;
}

export interface DocApiSpec {
  readonly name: string;
  readonly signature: string;
  readonly usageExample: string;
  readonly notes?: string;
}

export interface DocGuidanceRecord {
  readonly technology: string;
  readonly libraryVersion?: string;
  readonly officialUrl: string;
  readonly apis: ReadonlyArray<DocApiSpec>;
  readonly installationCommand?: string;
  readonly compatibilityNotes: ReadonlyArray<string>;
  readonly bestPractices: ReadonlyArray<string>;
  readonly antiPatterns: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<ProvenanceRecord>;
}

export type WebIntelligenceEvidence =
  | {
      readonly kind: "scraapy";
      readonly summary: string;
      readonly result: ScraapyResult;
      readonly provenance: ReadonlyArray<ProvenanceRecord>;
    }
  | {
      readonly kind: "research";
      readonly summary: string;
      readonly finding: ResearchFinding;
      readonly provenance: ReadonlyArray<ProvenanceRecord>;
    }
  | {
      readonly kind: "doc";
      readonly summary: string;
      readonly guidance: DocGuidanceRecord;
      readonly provenance: ReadonlyArray<ProvenanceRecord>;
    };
