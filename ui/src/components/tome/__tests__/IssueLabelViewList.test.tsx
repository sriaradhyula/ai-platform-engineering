import { fireEvent, render, screen } from "@testing-library/react";

import { TOME_TRACKED_ISSUE_LABELS } from "@/lib/tome/issue-filter-views";
import { IssueLabelViewList } from "../IssueLabelViewList";

describe("IssueLabelViewList", () => {
  it("renders the fixed TOME-owned labels in product order", () => {
    const onSelect = jest.fn();
    render(
      <IssueLabelViewList
        labels={TOME_TRACKED_ISSUE_LABELS}
        activeLabel="tome:needs attention"
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText("Critical")).toBeInTheDocument();
    expect(screen.getByText("Needs Attention")).toBeInTheDocument();
    expect(screen.getByText("Decisions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Critical" }));
    expect(onSelect).toHaveBeenCalledWith("tome:critical");
  });
});
