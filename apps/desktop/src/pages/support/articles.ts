/** Bundled help articles (text in the locale files, readable offline). */
export const HELP_ARTICLES = ["getting-started", "kill-switch", "dns-leaks", "split-tunneling", "trusted-networks", "privacy"] as const;
export type HelpArticle = (typeof HELP_ARTICLES)[number];
