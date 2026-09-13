import { fireEvent, render, screen, within } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ProjectDescription,
  ProjectMetadataInfo,
} from "../ProjectDescription";

describe("ProjectDescription", () => {
  const description =
    "A complete project description that is intentionally long enough to be clipped in the compact Tome header.";

  it("keeps a one-line description visible and reveals the complete text on hover", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <ProjectDescription description={description} />
      </TooltipProvider>,
    );

    const summary = screen.getByLabelText(
      `Project description: ${description}`,
    );
    expect(summary).toHaveClass(
      "line-clamp-1",
      "text-sm",
      "text-muted-foreground",
    );
    expect(summary).toHaveTextContent(description);
    fireEvent.mouseEnter(summary);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(description);
    expect(tooltip).toHaveClass(
      "whitespace-normal",
      "max-w-[calc(100vw-2rem)]",
      "text-left",
    );
  });

  it("reveals the complete text for keyboard users", () => {
    render(
      <TooltipProvider>
        <ProjectDescription description={description} />
      </TooltipProvider>,
    );

    fireEvent.focus(
      screen.getByLabelText(`Project description: ${description}`),
    );

    expect(screen.getByRole("tooltip")).toHaveTextContent(description);
  });
});

describe("ProjectMetadataInfo", () => {
  it("keeps access details in a title-line information tooltip", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <ProjectMetadataInfo
          teamName="example-team"
          dataSteward="test-user@example.com"
          tags={["primary", "docs"]}
        />
      </TooltipProvider>,
    );

    const infoButton = screen.getByRole("button", {
      name: "View project access and metadata",
    });
    expect(infoButton).toHaveClass("h-6", "w-6", "cursor-help");
    expect(screen.queryByText("example-team")).not.toBeInTheDocument();
    fireEvent.mouseEnter(infoButton);

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Shared with")).toBeInTheDocument();
    expect(within(tooltip).getByText("example-team")).toBeInTheDocument();
    expect(within(tooltip).getByText("Data steward")).toBeInTheDocument();
    expect(
      within(tooltip).getByText("test-user@example.com"),
    ).toBeInTheDocument();
    expect(within(tooltip).getByText("Tags")).toBeInTheDocument();
    expect(within(tooltip).getByText("primary")).toBeInTheDocument();
    expect(within(tooltip).getByText("docs")).toBeInTheDocument();
  });

  it("explains unassigned metadata", () => {
    render(
      <TooltipProvider>
        <ProjectMetadataInfo teamName={null} dataSteward={null} tags={[]} />
      </TooltipProvider>,
    );

    fireEvent.focus(
      screen.getByRole("button", {
        name: "View project access and metadata",
      }),
    );

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("No team assigned");
    expect(tooltip).toHaveTextContent("Not assigned");
    expect(tooltip).toHaveTextContent("None");
  });
});
