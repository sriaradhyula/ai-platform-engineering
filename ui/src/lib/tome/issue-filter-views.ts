export const TOME_TRACKER_PREFIX = "tome:";

export const TOME_ISSUE_LABEL_KEYS = [
  "critical",
  "needs-attention",
  "decision",
] as const;

export type TomeIssueLabelKey = (typeof TOME_ISSUE_LABEL_KEYS)[number];

export interface TomeTrackedIssueLabel {
  id: string;
  label: string;
  title: string;
  aliases?: readonly string[];
}

export interface TomeIssueLabelSetting {
  title: string;
  suffix: string;
}

export interface TomeIssueLabelSettings {
  use_prefix: boolean;
  labels: Record<TomeIssueLabelKey, TomeIssueLabelSetting>;
}

export const DEFAULT_TOME_ISSUE_LABEL_SETTINGS: TomeIssueLabelSettings = {
  use_prefix: true,
  labels: {
    critical: { title: "Critical", suffix: "critical" },
    "needs-attention": { title: "Needs Attention", suffix: "needs attention" },
    decision: { title: "Decisions", suffix: "decision" },
  },
};

export function materializeTomeIssueLabels(
  settings: TomeIssueLabelSettings,
  legacyLabels?: Partial<Record<TomeIssueLabelKey, readonly string[]>>,
): TomeTrackedIssueLabel[] {
  const prefix = settings.use_prefix ? TOME_TRACKER_PREFIX : "";
  return TOME_ISSUE_LABEL_KEYS.map((id) => {
    const setting = settings.labels[id];
    const aliases = [...new Set((legacyLabels?.[id] ?? []).filter(
      (alias) => alias !== `${prefix}${setting.suffix}`,
    ))];
    return {
      id,
      label: `${prefix}${setting.suffix}`,
      title: setting.title,
      ...(aliases.length > 0 ? { aliases } : {}),
    };
  });
}

export const TOME_TRACKED_ISSUE_LABELS = materializeTomeIssueLabels(
  DEFAULT_TOME_ISSUE_LABEL_SETTINGS,
);

const CUSTOM_TRACKER_SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,47}[a-z0-9])?$/;

export function customTomeTrackerLabel(
  suffix: string,
  prefix = TOME_TRACKER_PREFIX,
): string | null {
  const normalized = suffix.trim().toLowerCase();
  if (!CUSTOM_TRACKER_SUFFIX.test(normalized)) return null;
  const label = `${prefix}${normalized}`;
  return TOME_TRACKED_ISSUE_LABELS.some((tracked) => tracked.label === label)
    ? null
    : label;
}

export function tomeTrackedIssueLabel(label: string): TomeTrackedIssueLabel {
  const normalized = label.trim().toLowerCase();
  const builtIn = TOME_TRACKED_ISSUE_LABELS.find(
    (tracked) => tracked.label === normalized,
  );
  if (builtIn) return builtIn;
  const suffix = normalized.startsWith(TOME_TRACKER_PREFIX)
    ? normalized.slice(TOME_TRACKER_PREFIX.length)
    : normalized;
  return {
    id: suffix,
    label: normalized,
    title: suffix.split("-").map(
      (word) => word.charAt(0).toUpperCase() + word.slice(1),
    ).join(" "),
  };
}

export function normalizeCustomTomeTrackerLabels(
  value: unknown,
  prefix = TOME_TRACKER_PREFIX,
): string[] {
  if (!Array.isArray(value)) return [];
  const labels = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const normalizedRaw = raw.trim().toLowerCase();
    const candidatePrefixes = [...new Set([prefix, TOME_TRACKER_PREFIX, ""])]
      .sort((left, right) => right.length - left.length);
    for (const candidatePrefix of candidatePrefixes) {
      if (candidatePrefix && !normalizedRaw.startsWith(candidatePrefix)) continue;
      const suffix = candidatePrefix
        ? normalizedRaw.slice(candidatePrefix.length)
        : normalizedRaw;
      const label = customTomeTrackerLabel(suffix, prefix);
      if (label) {
        labels.add(label);
        break;
      }
    }
  }
  return [...labels].sort((left, right) => left.localeCompare(right)).slice(0, 20);
}

export function isTomeTrackedIssueLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return TOME_TRACKED_ISSUE_LABELS.some(
    (tracked) => tracked.label === normalized,
  );
}

export function matchesTomeTrackedIssueLabel(
  labels: readonly string[],
  tracked: TomeTrackedIssueLabel,
): boolean {
  const normalized = new Set(labels.map((label) => label.trim().toLowerCase()));
  return [tracked.label, ...(tracked.aliases ?? [])].some((label) =>
    normalized.has(label.toLowerCase()),
  );
}
