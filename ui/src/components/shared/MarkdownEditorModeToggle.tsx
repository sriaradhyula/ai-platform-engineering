"use client";

import { Code, Eye, Pencil, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface MarkdownEditorModeOption<TMode extends string> {
  value: TMode;
  label: string;
  title: string;
  icon: LucideIcon;
  testId?: string;
}

export type MarkdownDocumentEditorMode = "rich" | "source" | "preview";

/** Canonical modes shared by Tome wiki pages and gists. */
export const MARKDOWN_DOCUMENT_EDITOR_MODES = [
  { value: "rich", label: "Rich", title: "Visual editor", icon: Pencil },
  { value: "source", label: "Markdown", title: "Markdown source", icon: Code },
  { value: "preview", label: "Preview", title: "Rendered preview", icon: Eye },
] as const satisfies readonly MarkdownEditorModeOption<MarkdownDocumentEditorMode>[];

interface Props<TMode extends string> {
  value: TMode;
  options: readonly MarkdownEditorModeOption<TMode>[];
  onChange: (mode: TMode) => void;
  disabled?: boolean;
  ariaLabel?: string;
  testId?: string;
}

/** Shared segmented control for Markdown source, rich, split, and preview modes. */
export function MarkdownEditorModeToggle<TMode extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel = "Editor view mode",
  testId,
}: Props<TMode>) {
  return (
    <div
      className="inline-flex items-center rounded-md border border-border/50 bg-background p-0.5"
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <Button
            key={option.value}
            type="button"
            variant={value === option.value ? "secondary" : "ghost"}
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => onChange(option.value)}
            disabled={disabled}
            aria-pressed={value === option.value}
            data-testid={option.testId}
            title={option.title}
          >
            <Icon className="h-3 w-3" aria-hidden="true" />
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
