/** Built-in CAIPE event subscribers. Add autonomous-agent triggers here. */

import {
  isRepositoryAttachedToTome,
  isTomeIssueCacheEvent,
  recordTomeIssueCacheEvent,
} from "@/lib/github-webhooks/tome-issue-cache";
import { readGitHubProjectV2Issue } from "@/lib/github-project-v2";
import { upsertCachedTomeIssue } from "@/lib/tome/github-issue-cache";
import {
  emitLabelChangeToFeed,
  emitProjectStatusChangeToFeed,
} from "@/lib/tome/source-feed/webhook";
import type { CaipeEvent, CaipeEventSubscriber } from "@/lib/events/types";
import type { LinkedIssueStatus } from "@/lib/github-issue-snapshot";

function githubEventType(event: CaipeEvent): string | null {
  return typeof event.data.github_event === "string"
    ? event.data.github_event
    : null;
}

function githubAction(event: CaipeEvent): string | null {
  return typeof event.data.action === "string" ? event.data.action : null;
}

interface LabelableSnapshot {
  number: number;
  title: string;
  url: string;
  labels: string[];
}

function isLabelableSnapshot(value: unknown): value is LabelableSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LabelableSnapshot>;
  return (
    typeof candidate.number === "number" &&
    typeof candidate.title === "string" &&
    typeof candidate.url === "string" &&
    Array.isArray(candidate.labels)
  );
}

const LABEL_CHANGE_ACTIONS = new Set(["labeled", "unlabeled"]);

/** Bridges real-time `labeled`/`unlabeled` webhook deliveries straight into
 * the project Feed — see `@/lib/tome/source-feed/webhook.ts` for why the
 * (poller-only) source-activity feed can't catch these on its own. */
const tomeFeedLabelChangeSubscriber: CaipeEventSubscriber = {
  id: "tome.feed.label-change.v1",
  matches(event) {
    const eventType = githubEventType(event);
    const action = githubAction(event);
    return (
      event.source === "github" &&
      (eventType === "issues" || eventType === "pull_request") &&
      Boolean(action && LABEL_CHANGE_ACTIONS.has(action))
    );
  },
  async handle(event) {
    const eventType = githubEventType(event);
    const action = githubAction(event);
    const repoId = event.data.repository_id;
    const fullName = event.data.repository_full_name;
    if (
      !eventType ||
      !action ||
      typeof repoId !== "number" ||
      typeof fullName !== "string"
    ) {
      throw new Error("GitHub event is missing normalized repository metadata");
    }
    const snapshot =
      eventType === "pull_request" ? event.data.pull_request : event.data.issue;
    if (!isLabelableSnapshot(snapshot)) return; // malformed/incomplete payload
    const labelName =
      typeof event.data.label_name === "string" ? event.data.label_name : null;
    const actor =
      typeof event.data.sender_login === "string" ? event.data.sender_login : null;
    await emitLabelChangeToFeed({
      repoId,
      repoFullName: fullName,
      action: action as "labeled" | "unlabeled",
      artifact: eventType === "pull_request" ? "pr" : "issue",
      number: snapshot.number,
      title: snapshot.title,
      url: snapshot.url,
      labels: snapshot.labels,
      labelName,
      actor,
      ts: new Date(event.time).toISOString(),
    });
  },
};

const tomeGitHubIssueCacheSubscriber: CaipeEventSubscriber = {
  id: "tome.github-issue-cache.v1",
  matches(event) {
    const eventType = githubEventType(event);
    return event.source === "github" && Boolean(eventType && isTomeIssueCacheEvent(eventType));
  },
  async handle(event) {
    const eventType = githubEventType(event);
    const repoId = event.data.repository_id;
    const fullName = event.data.repository_full_name;
    const deliveryId = event.data.delivery_id;
    if (
      !eventType ||
      typeof repoId !== "number" ||
      typeof fullName !== "string"
    ) {
      throw new Error("GitHub event is missing normalized repository metadata");
    }
    if (!(await isRepositoryAttachedToTome(repoId, fullName))) return;
    await recordTomeIssueCacheEvent({
      repoId,
      fullName,
      eventType,
      deliveryId: typeof deliveryId === "string" ? deliveryId : null,
      issue: event.data.issue,
      discussion: event.data.discussion,
    });
  },
};

interface ProjectV2ItemWebhookSnapshot {
  node_id: string;
  content_node_id: string;
  content_type?: string;
}

function isProjectV2ItemSnapshot(
  value: unknown,
): value is ProjectV2ItemWebhookSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProjectV2ItemWebhookSnapshot>;
  return (
    typeof candidate.node_id === "string" &&
    typeof candidate.content_node_id === "string"
  );
}

function projectV2FieldNodeId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const fieldValue = (value as { field_value?: unknown }).field_value;
  if (typeof fieldValue !== "object" || fieldValue === null) return null;
  const fieldNodeId = (fieldValue as { field_node_id?: unknown }).field_node_id;
  return typeof fieldNodeId === "string" ? fieldNodeId : null;
}

const tomeGitHubProjectV2Subscriber: CaipeEventSubscriber = {
  id: "tome.github-project-v2-status.v1",
  matches(event) {
    return event.source === "github" && githubEventType(event) === "projects_v2_item";
  },
  async handle(event) {
    const item = event.data.projects_v2_item;
    if (!isProjectV2ItemSnapshot(item)) return;
    if (item.content_type && item.content_type !== "Issue") return;

    const token =
      process.env.TOME_GITHUB_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new Error(
        "TOME_GITHUB_TOKEN or GITHUB_TOKEN is required for Project V2 webhook reconciliation",
      );
    }

    const lookup = await readGitHubProjectV2Issue(token, {
      itemNodeId: item.node_id,
      contentNodeId: item.content_node_id,
      fieldNodeId: projectV2FieldNodeId(event.data.projects_v2_changes),
    });
    if (!lookup) return;
    if (
      lookup.repositoryId == null ||
      !(await isRepositoryAttachedToTome(
        lookup.repositoryId,
        lookup.repositoryFullName,
      ))
    ) {
      return;
    }

    const action = githubAction(event);
    const statusChanged = lookup.statusFieldChanged && action === "edited";
    const projectDisplayStatus =
      action === "deleted"
        ? null
        : statusChanged
          ? lookup.projectStatus
          : undefined;
    await recordProjectV2IssueCacheEvent({
      repoId: lookup.repositoryId,
      fullName: lookup.repositoryFullName,
      deliveryId:
        typeof event.data.delivery_id === "string"
          ? event.data.delivery_id
          : null,
      issue: lookup.issue,
      projectDisplayStatus,
    });

    if (statusChanged && lookup.projectStatus) {
      await emitProjectStatusChangeToFeed({
        repoId: lookup.repositoryId,
        repoFullName: lookup.repositoryFullName,
        number: lookup.issue.number,
        title: lookup.issue.title,
        url: lookup.issue.url,
        labels: lookup.issue.labels,
        status: lookup.projectStatus,
        projectStatusName: lookup.projectStatusName,
        actor:
          typeof event.data.sender_login === "string"
            ? event.data.sender_login
            : null,
        ts: new Date(event.time).toISOString(),
      });
    }
  },
};

async function recordProjectV2IssueCacheEvent(input: {
  repoId: number;
  fullName: string;
  deliveryId: string | null;
  issue: LinkedIssueStatus;
  projectDisplayStatus: "open" | "in_progress" | "resolved" | null | undefined;
}): Promise<void> {
  await upsertCachedTomeIssue(input.issue, {
    repoId: input.repoId,
    eventType: "projects_v2_item",
    deliveryId: input.deliveryId,
    webhook: true,
    ...(input.projectDisplayStatus !== undefined
      ? { projectDisplayStatus: input.projectDisplayStatus }
      : {}),
  });
}

export const caipeEventSubscribers: readonly CaipeEventSubscriber[] = [
  tomeGitHubProjectV2Subscriber,
  tomeGitHubIssueCacheSubscriber,
  tomeFeedLabelChangeSubscriber,
];

export function findCaipeEventSubscriber(
  id: string,
): CaipeEventSubscriber | undefined {
  return caipeEventSubscribers.find((subscriber) => subscriber.id === id);
}
