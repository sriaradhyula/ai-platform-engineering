import type { Document } from "mongodb";

import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import {
  DEFAULT_TOME_ISSUE_LABEL_SETTINGS,
  materializeTomeIssueLabels,
  normalizeCustomTomeTrackerLabels,
  TOME_ISSUE_LABEL_KEYS,
  TOME_TRACKER_PREFIX,
  tomeTrackedIssueLabel,
  type TomeIssueLabelSettings,
  type TomeIssueLabelKey,
  type TomeTrackedIssueLabel,
} from "@/lib/tome/issue-filter-views";

const TOME_ISSUE_TRACKERS_COLLECTION = "tome_issue_trackers";
export const TOME_ISSUE_LABEL_SETTINGS_COLLECTION = "tome_issue_label_settings";
const TOME_ISSUE_LABEL_SETTINGS_ID = "global";

interface TomeIssueTrackerDocument extends Document {
  project_id: string;
  labels: string[];
  updated_at: Date;
}

export interface TomeIssueLabelSettingsDocument extends TomeIssueLabelSettings {
  _id: string;
  legacy_labels: Partial<Record<TomeIssueLabelKey, string[]>>;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

async function trackersCollection() {
  return getCollection<TomeIssueTrackerDocument>(TOME_ISSUE_TRACKERS_COLLECTION);
}

async function labelSettingsCollection() {
  return getCollection<TomeIssueLabelSettingsDocument>(TOME_ISSUE_LABEL_SETTINGS_COLLECTION);
}

function defaultLabelSettingsDocument(): TomeIssueLabelSettingsDocument {
  return {
    _id: TOME_ISSUE_LABEL_SETTINGS_ID,
    use_prefix: DEFAULT_TOME_ISSUE_LABEL_SETTINGS.use_prefix,
    labels: Object.fromEntries(
      Object.entries(DEFAULT_TOME_ISSUE_LABEL_SETTINGS.labels).map(([key, value]) => [key, { ...value }]),
    ) as TomeIssueLabelSettings["labels"],
    legacy_labels: {},
    version: 0,
    updated_at: null,
    updated_by: null,
  };
}

function mergeLabelSettings(
  document: Partial<TomeIssueLabelSettingsDocument> | null | undefined,
): TomeIssueLabelSettingsDocument {
  const defaults = defaultLabelSettingsDocument();
  const labels = Object.fromEntries(
    Object.entries(defaults.labels).map(([key, defaultValue]) => {
      const configured = document?.labels?.[key as keyof TomeIssueLabelSettings["labels"]];
      return [key, {
        ...defaultValue,
        ...(configured && typeof configured === "object" ? configured : {}),
      }];
    }),
  ) as TomeIssueLabelSettings["labels"];
  return {
    ...defaults,
    ...document,
    use_prefix: typeof document?.use_prefix === "boolean"
      ? document.use_prefix
      : defaults.use_prefix,
    labels,
    legacy_labels: document?.legacy_labels ?? {},
  };
}

export async function readTomeIssueLabelSettings(): Promise<TomeIssueLabelSettingsDocument> {
  if (!isMongoDBConfigured) return defaultLabelSettingsDocument();
  const document = await (await labelSettingsCollection()).findOne({
    _id: TOME_ISSUE_LABEL_SETTINGS_ID,
  });
  return mergeLabelSettings(document);
}

export interface TomeIssueLabelSettingsValidationError {
  field: string;
  message: string;
}

export class TomeIssueLabelSettingsValidationFailure extends Error {
  constructor(public readonly errors: TomeIssueLabelSettingsValidationError[]) {
    super("TOME issue label settings validation failed");
    this.name = "TomeIssueLabelSettingsValidationFailure";
  }
}

function validateLabelPart(
  value: unknown,
  field: string,
  maxLength: number,
): TomeIssueLabelSettingsValidationError | null {
  if (typeof value !== "string" || !value.trim()) {
    return { field, message: "A non-empty value is required." };
  }
  if (value.trim().length > maxLength || /[\r\n]/.test(value)) {
    return { field, message: `Value must be at most ${maxLength} characters and contain no line breaks.` };
  }
  return null;
}

export function validateTomeIssueLabelSettings(
  input: Partial<TomeIssueLabelSettings> | null | undefined,
): TomeIssueLabelSettingsValidationError[] {
  const errors: TomeIssueLabelSettingsValidationError[] = [];
  if (typeof input?.use_prefix !== "boolean") {
    errors.push({ field: "use_prefix", message: "use_prefix must be a boolean." });
  }
  if (!input?.labels || typeof input.labels !== "object") {
    return [...errors, { field: "labels", message: "All issue label settings are required." }];
  }
  const seen = new Set<string>();
  const prefix = input.use_prefix === true ? TOME_TRACKER_PREFIX : "";
  for (const key of Object.keys(DEFAULT_TOME_ISSUE_LABEL_SETTINGS.labels) as Array<keyof TomeIssueLabelSettings["labels"]>) {
    const setting = input.labels[key];
    const titleError = validateLabelPart(setting?.title, `labels.${key}.title`, 80);
    const suffixError = validateLabelPart(
      setting?.suffix,
      `labels.${key}.suffix`,
      50 - prefix.length,
    );
    if (titleError) errors.push(titleError);
    if (suffixError) errors.push(suffixError);
    if (!suffixError) {
      const normalized = `${prefix}${setting.suffix.trim()}`.toLowerCase();
      if (seen.has(normalized)) {
        errors.push({ field: `labels.${key}.suffix`, message: "Each issue label must be unique." });
      }
      seen.add(normalized);
    }
  }
  return errors;
}

export async function saveTomeIssueLabelSettings(
  input: TomeIssueLabelSettings,
  updatedBy: string | null,
): Promise<TomeIssueLabelSettingsDocument> {
  const errors = validateTomeIssueLabelSettings(input);
  if (errors.length) throw new TomeIssueLabelSettingsValidationFailure(errors);
  const current = await readTomeIssueLabelSettings();
  const document: TomeIssueLabelSettingsDocument = {
    _id: TOME_ISSUE_LABEL_SETTINGS_ID,
    use_prefix: input.use_prefix,
    labels: Object.fromEntries(
      Object.entries(input.labels).map(([key, value]) => [key, {
        title: value.title.trim(),
        suffix: value.suffix.trim().toLowerCase(),
      }]),
    ) as TomeIssueLabelSettings["labels"],
    legacy_labels: Object.fromEntries(
      TOME_ISSUE_LABEL_KEYS.map((typedKey, index) => {
        const previous = materializeTomeIssueLabels(current)[index]?.label;
        const next = `${input.use_prefix ? TOME_TRACKER_PREFIX : ""}${input.labels[typedKey].suffix.trim().toLowerCase()}`;
        const aliases = [
          ...(current.legacy_labels[typedKey] ?? []),
          ...(previous && previous !== next ? [previous] : []),
        ];
        return [typedKey, [...new Set(aliases)].filter((alias) => alias !== next).slice(-10)];
      }),
    ) as Partial<Record<TomeIssueLabelKey, string[]>>,
    version: current.version + 1,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  };
  if (isMongoDBConfigured) {
    await (await labelSettingsCollection()).replaceOne(
      { _id: TOME_ISSUE_LABEL_SETTINGS_ID },
      document,
      { upsert: true },
    );
  }
  return document;
}

export async function readTomeCustomIssueTrackers(projectId: string): Promise<string[]> {
  const [trackers, settings] = await Promise.all([
    trackersCollection(),
    readTomeIssueLabelSettings(),
  ]);
  const document = await trackers.findOne(
    { project_id: projectId },
    { projection: { _id: 0, labels: 1 } },
  );
  return normalizeCustomTomeTrackerLabels(
    document?.labels,
    settings.use_prefix ? TOME_TRACKER_PREFIX : "",
  );
}

export async function addTomeCustomIssueTracker(
  projectId: string,
  label: string,
): Promise<string[]> {
  const trackers = await trackersCollection();
  await trackers.updateOne(
    { project_id: projectId },
    {
      $set: { project_id: projectId, updated_at: new Date() },
      $addToSet: { labels: label },
    },
    { upsert: true },
  );
  return readTomeCustomIssueTrackers(projectId);
}

export async function listTomeTrackedIssueLabels(
  projectIds: string[],
): Promise<TomeTrackedIssueLabel[]> {
  const [trackers, settings] = await Promise.all([
    trackersCollection(),
    readTomeIssueLabelSettings(),
  ]);
  const documents = await trackers.find(
    { project_id: { $in: projectIds } },
    { projection: { _id: 0, labels: 1 } },
  ).toArray();
  const custom = normalizeCustomTomeTrackerLabels(
    documents.flatMap((document) => document.labels),
    settings.use_prefix ? TOME_TRACKER_PREFIX : "",
  );
  const builtIn = materializeTomeIssueLabels(settings, settings.legacy_labels);
  const builtInLabels = new Set(
    builtIn.flatMap(({ label, aliases }) => [label, ...(aliases ?? [])]),
  );
  return [
    ...builtIn,
    ...custom
      .filter((label) => !builtInLabels.has(label))
      .map(tomeTrackedIssueLabel),
  ];
}
