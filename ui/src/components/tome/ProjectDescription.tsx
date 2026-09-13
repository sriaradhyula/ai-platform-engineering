"use client";

import { Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ProjectDescriptionProps {
  description: string;
}

interface ProjectMetadataInfoProps {
  teamName: string | null;
  dataSteward: string | null;
  tags: string[];
}

/** Compact one-line project summary with a readable full-text hover card. */
export function ProjectDescription({ description }: ProjectDescriptionProps) {
  return (
    <Tooltip className="mt-1 block min-w-0 w-full">
      <TooltipTrigger asChild>
        <p
          tabIndex={0}
          aria-label={`Project description: ${description}`}
          className="line-clamp-1 cursor-help rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {description}
        </p>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={8}
        className="w-[42rem] max-w-[calc(100vw-2rem)] whitespace-normal break-words p-3 text-left font-normal shadow-xl"
      >
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Project description
          </p>
          <p className="text-sm leading-relaxed text-popover-foreground">
            {description}
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Title-line access and ownership details, kept out of the vertical page flow. */
export function ProjectMetadataInfo({
  teamName,
  dataSteward,
  tags,
}: ProjectMetadataInfoProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="View project access and metadata"
          className="inline-flex h-6 w-6 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Info className="h-4 w-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-2rem)] p-3 text-left font-normal shadow-xl"
      >
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Project information
          </p>
          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Shared with</dt>
            <dd className="break-words text-popover-foreground">
              {teamName ?? "No team assigned"}
            </dd>
            <dt className="text-muted-foreground">Data steward</dt>
            <dd className="break-words text-popover-foreground">
              {dataSteward ?? "Not assigned"}
            </dd>
            <dt className="text-muted-foreground">Tags</dt>
            <dd className="flex min-w-0 flex-wrap gap-1">
              {tags.length > 0 ? (
                tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="font-normal">
                    {tag}
                  </Badge>
                ))
              ) : (
                <span className="text-popover-foreground">None</span>
              )}
            </dd>
          </dl>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
