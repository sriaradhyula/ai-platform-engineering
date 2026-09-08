/** Reads the current Issue and Status value for a GitHub Projects V2 item. */

import { Octokit } from "@octokit/rest";

import {
  displayStatusFromProjectStatus,
  linkedIssueFromGitHub,
  type LinkedIssueDisplayStatus,
  type LinkedIssueStatus,
} from "@/lib/github-issue-link";

interface ProjectV2ItemQuery {
  item: {
    content: {
      __typename: string;
      number?: number;
      repository?: { databaseId?: number | null; nameWithOwner?: string | null } | null;
    } | null;
    fieldValues: {
      nodes: Array<{
        optionId?: string | null;
        name?: string | null;
        field?: { id?: string | null; name?: string | null } | null;
      } | null>;
    };
  } | null;
  content: {
    __typename: string;
    number?: number;
    repository?: { databaseId?: number | null; nameWithOwner?: string | null } | null;
  } | null;
}

export interface GitHubProjectV2IssueLookup {
  issue: LinkedIssueStatus;
  repositoryId: number | null;
  repositoryFullName: string;
  projectStatus: LinkedIssueDisplayStatus | null;
  projectStatusName: string | null;
  statusFieldChanged: boolean;
}

function contentIssue(
  value: ProjectV2ItemQuery["item"]["content"] | ProjectV2ItemQuery["content"],
): { number: number; repositoryId: number | null; repositoryFullName: string } | null {
  if (!value || value.__typename !== "Issue" || !value.number) return null;
  const repository = value.repository;
  if (!repository?.nameWithOwner) return null;
  return {
    number: value.number,
    repositoryId: repository.databaseId ?? null,
    repositoryFullName: repository.nameWithOwner,
  };
}

/**
 * Resolve the issue behind a project item and its current Status option.
 * `fieldNodeId` is supplied by GitHub for `edited` project item events. For
 * deleted items the item node may disappear, so the content node is queried
 * independently and the cached project status is cleared by the caller.
 */
export async function readGitHubProjectV2Issue(
  token: string,
  input: { itemNodeId: string; contentNodeId: string; fieldNodeId?: string | null },
): Promise<GitHubProjectV2IssueLookup | null> {
  const octokit = new Octokit({ auth: token });
  const data = await octokit.graphql<ProjectV2ItemQuery>(
    `query TomeProjectV2Item(
      $itemNodeId: ID!
      $contentNodeId: ID!
    ) {
      item: node(id: $itemNodeId) {
        ... on ProjectV2Item {
          content {
            __typename
            ... on Issue {
              number
              repository { databaseId nameWithOwner }
            }
          }
          fieldValues(first: 100) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                optionId name
                field { ... on ProjectV2FieldCommon { id name } }
              }
            }
          }
        }
      }
      content: node(id: $contentNodeId) {
        __typename
        ... on Issue {
          number
          repository { databaseId nameWithOwner }
        }
      }
    }`,
    {
      itemNodeId: input.itemNodeId,
      contentNodeId: input.contentNodeId,
    },
  );

  const content = contentIssue(data.item?.content) ?? contentIssue(data.content);
  if (!content) return null;

  const [owner, repo] = content.repositoryFullName.split("/");
  if (!owner || !repo) return null;
  const upstream = await octokit.issues.get({
    owner,
    repo,
    issue_number: content.number,
  });
  if ("pull_request" in upstream.data) return null;

  const issue = linkedIssueFromGitHub(content.repositoryFullName, upstream.data);
  const selectedValue = data.item?.fieldValues.nodes.find(
    (value) =>
      Boolean(value?.optionId) &&
      (!input.fieldNodeId || value?.field?.id === input.fieldNodeId),
  );
  const statusFieldChanged =
    Boolean(selectedValue) &&
    selectedValue?.field?.name?.trim().toLowerCase() === "status";
  const projectStatusName = statusFieldChanged
    ? selectedValue?.name ?? null
    : null;

  return {
    issue,
    repositoryId: content.repositoryId,
    repositoryFullName: content.repositoryFullName,
    projectStatus: displayStatusFromProjectStatus(projectStatusName),
    projectStatusName,
    statusFieldChanged,
  };
}
