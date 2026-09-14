import { fireEvent, render, screen } from "@testing-library/react";

import {
  DeleteFolderDialog,
  DeletePageDialog,
} from "@/components/tome/DeletePageDialog";

describe("DeletePageDialog", () => {
  it("confirms page removal inside the app", () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();

    render(
      <DeletePageDialog
        path="planning/example.md"
        deleting={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Remove page?" })).toBeInTheDocument();
    expect(screen.getByText("example.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove page" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("prevents repeat actions while the page is being removed", () => {
    render(
      <DeletePageDialog
        path="example.md"
        deleting
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Removing…" })).toBeDisabled();
  });

  it("confirms empty-folder removal inside the app", () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();

    render(
      <DeleteFolderDialog
        name="Planning"
        deleting={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Remove folder?" })).toBeInTheDocument();
    expect(screen.getByText("Planning")).toBeInTheDocument();
    expect(screen.getByText(/Remove the empty folder/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove folder" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("prevents repeat actions while the folder is being removed", () => {
    render(
      <DeleteFolderDialog
        name="Planning"
        deleting
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Removing…" })).toBeDisabled();
  });
});
