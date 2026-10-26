/**
 * ThreadTitleService
 * Automatically parses user prompts and generates concise, relevant titles
 * formatted in developer-grade title case.
 */

export class ThreadTitleService {
  private static readonly FILLER_PREFIXES = [
    /^(can you please|could you please|please can you|please|can you|could you)\s+/i,
    /^(i want you to|i would like you to|help me to|help me|how do i|how to|i need to)\s+/i,
    /^(write code to|create code to|generate code for|show me how to)\s+/i,
    /^(hi,\s*can you|hello,\s*can you|hey,\s*can you)\s+/i,
    /^(hi|hello|hey)\s*$/i,
  ];

  private static readonly INTENT_RULES: Array<{
    pattern: RegExp;
    format: (match: RegExpMatchArray, raw: string) => string;
  }> = [
    // GitHub / Git URLs
    {
      pattern: /https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i,
      format: (m) => `Inspect ${m[1]}/${m[2].replace(/\.git$/, '')}`,
    },
    // Generic URL
    {
      pattern: /https?:\/\/(?:www\.)?([^/\s]+)(?:\/[^\s]*)?/i,
      format: (m) => `Explore ${m[1]}`,
    },
    // @Computer actions
    {
      pattern: /^@computer\s+(?:to\s+)?(.+)/i,
      format: (m) => `@Computer: ${this.toTitleCase(m[1].slice(0, 28))}`,
    },
    // Fix / Debug / Patch
    {
      pattern: /^(?:fix|debug|resolve|patch|repair)\s+(?:the\s+)?(.+)/i,
      format: (m) => `Fix ${this.toTitleCase(this.cleanTarget(m[1]))}`,
    },
    // Create / Implement / Build / Setup / Add
    {
      pattern: /^(?:setup|set\s+up|install|scaffold)\s+(?:a\s+|an\s+)?(.+)/i,
      format: (m) => `Setup ${this.toTitleCase(this.cleanTarget(m[1]))}`,
    },
    {
      pattern: /^(?:build|create|implement|develop|generate|add)\s+(?:a\s+|an\s+)?(.+)/i,
      format: (m) => `Implement ${this.toTitleCase(this.cleanTarget(m[1]))}`,
    },
    // Analyze / Understand / Inspect / Audit / Review
    {
      pattern: /^(?:analyze|analyse|understand|inspect|audit|review|check)\s+(?:the\s+|overall\s+)?(.+)/i,
      format: (m) => `Analyze ${this.toTitleCase(this.cleanTarget(m[1]))}`,
    },
    // Refactor / Optimize / Clean up
    {
      pattern: /^(?:refactor|optimize|clean\s+up|restructure)\s+(?:the\s+)?(.+)/i,
      format: (m) => `Refactor ${this.toTitleCase(this.cleanTarget(m[1]))}`,
    },
    // Explain / Clarify / Document
    {
      pattern: /^(?:explain|describe|clarify|document)\s+(?:the\s+)?(.+)/i,
      format: (m) => `Explain ${this.toTitleCase(this.cleanTarget(m[1]))}`,
    },
    // Test / Verify
    {
      pattern: /^(?:test|verify|benchmark)\s+(?:the\s+)?(.+)/i,
      format: (m) => `Test ${this.toTitleCase(this.cleanTarget(m[1]))}`,
    },
  ];

  /**
   * Cleans target phrase by removing trailing punctuation, filler words, etc.
   */
  private static cleanTarget(str: string): string {
    return str
      .replace(/[?.!,;:]+$/, '')
      .replace(/\s+(in\s+this|in\s+my\s+project|for\s+me|please|step\s+by\s+step)$/i, '')
      .trim();
  }

  /**
   * Formats a string to Title Case while keeping known tech words properly cased.
   */
  public static toTitleCase(str: string): string {
    const TECH_DICTIONARY: Record<string, string> = {
      api: 'API',
      apis: 'APIs',
      ui: 'UI',
      jwt: 'JWT',
      auth: 'Auth',
      nextjs: 'Next.js',
      'next.js': 'Next.js',
      react: 'React',
      typescript: 'TypeScript',
      javascript: 'JavaScript',
      node: 'Node.js',
      nodejs: 'Node.js',
      graphql: 'GraphQL',
      sql: 'SQL',
      postgresql: 'PostgreSQL',
      postgres: 'PostgreSQL',
      prisma: 'Prisma',
      css: 'CSS',
      tailwind: 'Tailwind',
      tailwindcss: 'Tailwind CSS',
      html: 'HTML',
      git: 'Git',
      github: 'GitHub',
      docker: 'Docker',
      rest: 'REST',
      crud: 'CRUD',
      twosum: 'TwoSum',
      chrome: 'Chrome',
      browser: 'Browser',
    };

    const words = str.split(/\s+/);
    return words
      .map((word, idx) => {
        const lower = word.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
        if (TECH_DICTIONARY[lower]) {
          return TECH_DICTIONARY[lower];
        }
        // Small connector words
        if (idx > 0 && ['in', 'for', 'with', 'and', 'or', 'of', 'on', 'to', 'at', 'by'].includes(lower)) {
          return lower;
        }
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');
  }

  /**
   * Generates a concise title from a prompt string.
   */
  public static generateTitle(prompt: string): string {
    const raw = prompt.trim();
    if (!raw) return 'New Conversation';

    // Strip greeting-only prompts
    if (/^(hi|hello|hey|greetings|yo)[!.]*$/i.test(raw)) {
      return 'General Discussion';
    }

    // Strip leading conversational fillers
    let cleaned = raw;
    for (const prefix of this.FILLER_PREFIXES) {
      cleaned = cleaned.replace(prefix, '').trim();
    }

    // Check specific intent patterns
    for (const rule of this.INTENT_RULES) {
      const match = cleaned.match(rule.pattern);
      if (match) {
        const result = rule.format(match, cleaned);
        return this.truncate(result, 38);
      }
    }

    // Fallback: title case the cleaned string
    const fallback = this.toTitleCase(this.cleanTarget(cleaned));
    return this.truncate(fallback, 38);
  }

  /**
   * Truncates title to maximum length cleanly on word boundaries.
   */
  private static truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    const truncated = text.slice(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 18) {
      return truncated.slice(0, lastSpace) + '...';
    }
    return truncated + '...';
  }
}
