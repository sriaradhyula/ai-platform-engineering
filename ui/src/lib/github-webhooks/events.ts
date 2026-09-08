/** GitHub event contracts shared by webhook installation and ingress. */

export const TOME_GITHUB_WEBHOOK_EVENTS = [
  "issues",
  "issue_comment",
  "discussion",
  "discussion_comment",
  "label",
  "milestone",
  "pull_request",
] as const;

/** Organization-only events. GitHub does not allow these on repository hooks. */
export const TOME_GITHUB_ORGANIZATION_WEBHOOK_EVENTS = [
  "projects_v2_item",
] as const;

export const ACCEPTED_GITHUB_WEBHOOK_EVENTS = new Set<string>([
  ...TOME_GITHUB_WEBHOOK_EVENTS,
  ...TOME_GITHUB_ORGANIZATION_WEBHOOK_EVENTS,
  "ping",
]);

export type TomeGitHubWebhookEvent =
  | (typeof TOME_GITHUB_WEBHOOK_EVENTS)[number]
  | (typeof TOME_GITHUB_ORGANIZATION_WEBHOOK_EVENTS)[number];
