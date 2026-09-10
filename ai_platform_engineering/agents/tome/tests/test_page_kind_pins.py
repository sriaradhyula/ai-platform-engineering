"""A user's `kind: stable` pin survives ingest (#369, #348).

Reproduces the production failure exactly. The live `top-level` page-template
config on the deployed instance declares `roadmap.md` as `kind: dynamic` (an
admin edit), while the code default calls it `stable`. Under the old
behaviour that mismatch reached the agent as "`roadmap.md` kind changed
stable -> dynamic in the template. Treat it as dynamic going forward", and
the agent rewrote the frontmatter — so a user pinning the page had it
un-pinned on the next run, every run. 20 of 77 recorded pins died that way.

Two invariants are covered here:
  1. the template diff never asks the agent to change a page's kind, and
  2. an on-disk `kind: stable` pin lands in the prompt's protected set even
     when the template calls that page dynamic.
"""

from typing import Any

import pytest

from tome_agent.agent.ingestor import _build_system_prompt, _template_change_note
from tome_agent.orchestrator.contract import ProjectSnapshot
from tome_agent.reports import schema as report_schema

# The real top-level config read out of the deployed instance: roadmap.md was
# flipped to `dynamic` by an admin; charter/team-assignments stayed stable.
GRID_TOP_LEVEL: list[dict[str, Any]] = [
    {"path": "standup.md", "kind": "report", "title": "The Standup", "order": -10},
    {"path": "charter.md", "kind": "stable", "title": "Charter", "order": -5},
    {"path": "roadmap.md", "kind": "dynamic", "title": "Roadmap", "order": -4},
    {"path": "team-assignments.md", "kind": "stable", "title": "Team Assignment", "order": -3},
    {"path": "activity.md", "kind": "dynamic", "title": "Activity", "order": 0},
    {"path": "architecture.md", "kind": "dynamic", "title": "Architecture", "order": 10},
    {"path": "memory.md", "kind": "hidden", "title": "Memory", "order": 100},
]

PINNED_ROADMAP = "---\ntitle: Roadmap\nkind: stable\norder: 3\n---\n# Roadmap\n\nHand-written.\n"


def _snapshot() -> ProjectSnapshot:
    return ProjectSnapshot(
        project_id="project-id",
        slug="example-project",
        name="Example project",
    )


@pytest.fixture
def grid_templates():
    """Install the deployed top-level config for one test, then clear it."""
    report_schema.set_template_overrides({report_schema.SCOPE_TOP_LEVEL: GRID_TOP_LEVEL}, {})
    yield
    report_schema.set_template_overrides(None, None)


class TestPinnedStablePaths:
    def test_counts_only_an_explicit_stable_declaration(self) -> None:
        pages = {
            "roadmap.md": PINNED_ROADMAP,
            "activity.md": "---\nkind: dynamic\n---\n# Activity",
            "memory.md": "---\nkind: hidden\n---\n# Memory",
            "standup.md": "---\nkind: report\n---\n# Standup",
        }
        assert report_schema.pinned_stable_paths(pages) == ["roadmap.md"]

    def test_a_page_without_frontmatter_is_not_a_pin(self) -> None:
        # `kinds_from_pages` defaults these to "stable"; a pin is a recorded
        # decision, so absence of frontmatter must not fabricate one.
        pages = {"uploaded.md": "# Just a body", "titled.md": "---\ntitle: T\n---\n# T"}
        assert report_schema.pinned_stable_paths(pages) == []

    def test_tolerates_case_and_whitespace(self) -> None:
        pages = {"a.md": "---\nkind:  Stable \n---\n# A"}
        assert report_schema.pinned_stable_paths(pages) == ["a.md"]

    def test_returns_sorted_paths(self) -> None:
        stable = "---\nkind: stable\n---\n# x"
        pages = {"z.md": stable, "a.md": stable, "m.md": stable}
        assert report_schema.pinned_stable_paths(pages) == ["a.md", "m.md", "z.md"]

    def test_empty_input(self) -> None:
        assert report_schema.pinned_stable_paths({}) == []


class TestTemplateChangeNote:
    def test_kind_drift_alone_produces_no_prompt_block(self, grid_templates) -> None:
        """The exact #369 setup: page pinned stable, template says dynamic."""
        existing = {spec["path"]: f"---\nkind: {spec['kind']}\n---\n# x" for spec in GRID_TOP_LEVEL}
        existing["roadmap.md"] = PINNED_ROADMAP

        block, summary = _template_change_note(_snapshot(), existing)

        assert block == ""
        assert summary is None

    def test_never_mentions_kind_even_when_reporting_new_pages(self, grid_templates) -> None:
        existing = {spec["path"]: f"---\nkind: {spec['kind']}\n---\n# x" for spec in GRID_TOP_LEVEL}
        existing["roadmap.md"] = PINNED_ROADMAP
        del existing["architecture.md"]  # a genuinely new templated page

        block, summary = _template_change_note(_snapshot(), existing)

        assert "NEW page `architecture.md`" in block
        assert "1 new page(s) from the template" in summary
        # No instruction to re-kind anything, for roadmap.md or otherwise.
        assert "kind changed" not in block
        assert "going forward" not in block
        assert "roadmap.md" not in block

    def test_still_reports_pages_the_template_added(self, grid_templates) -> None:
        block, summary = _template_change_note(_snapshot(), {"charter.md": "# Charter"})

        for path in ("roadmap.md", "activity.md", "memory.md"):
            assert f"NEW page `{path}`" in block
        assert "charter.md" not in block
        assert summary is not None

    def test_in_sync_wiki_produces_nothing(self, grid_templates) -> None:
        existing = {spec["path"]: f"---\nkind: {spec['kind']}\n---\n# x" for spec in GRID_TOP_LEVEL}

        assert _template_change_note(_snapshot(), existing) == ("", None)


class TestProtectedStableSetInPrompt:
    @staticmethod
    def _protected(prompt: str) -> str:
        """The one prompt line that enumerates human-owned pages."""
        for line in prompt.splitlines():
            if line.startswith("HUMAN-OWNED, DO NOT REWRITE:"):
                return line
        raise AssertionError("incremental prompt has no HUMAN-OWNED line")

    def test_on_disk_pin_is_protected_though_the_template_says_dynamic(
        self, grid_templates
    ) -> None:
        """The payload of the fix: pin roadmap, agent stops rewriting it."""
        prompt = _build_system_prompt(
            _snapshot(),
            is_greenfield=False,
            existing_pages={"roadmap.md": PINNED_ROADMAP},
        )

        assert "`roadmap.md`" in self._protected(prompt)

    def test_a_page_dynamic_everywhere_is_not_protected(self, grid_templates) -> None:
        """Negative control: the list is a real filter, not "every page"."""
        prompt = _build_system_prompt(_snapshot(), is_greenfield=False, existing_pages={})
        protected = self._protected(prompt)

        # `activity.md` is dynamic in both the hardcoded defaults and the
        # live config, and nobody pinned it.
        assert "`activity.md`" not in protected
        assert "`architecture.md`" not in protected

    def test_a_pin_promotes_an_otherwise_dynamic_page(self, grid_templates) -> None:
        """The whole point: the pin, and only the pin, adds the page."""
        pinned = "---\ntitle: Architecture\nkind: stable\n---\n# Architecture"
        before = self._protected(
            _build_system_prompt(_snapshot(), is_greenfield=False, existing_pages={})
        )
        after = self._protected(
            _build_system_prompt(
                _snapshot(),
                is_greenfield=False,
                existing_pages={"architecture.md": pinned},
            )
        )

        assert "`architecture.md`" not in before
        assert "`architecture.md`" in after

    def test_template_stable_pages_stay_protected_with_no_pins(self, grid_templates) -> None:
        protected = self._protected(
            _build_system_prompt(_snapshot(), is_greenfield=False, existing_pages={})
        )

        assert "`charter.md`" in protected
        assert "`team-assignments.md`" in protected

    def test_pins_are_added_to_the_template_set_not_swapped_for_it(
        self, grid_templates
    ) -> None:
        protected = self._protected(
            _build_system_prompt(
                _snapshot(),
                is_greenfield=False,
                existing_pages={"roadmap.md": PINNED_ROADMAP},
            )
        )

        for path in ("`charter.md`", "`team-assignments.md`", "`roadmap.md`"):
            assert path in protected

    def test_a_dynamic_page_stays_writable(self, grid_templates) -> None:
        protected = self._protected(
            _build_system_prompt(
                _snapshot(),
                is_greenfield=False,
                existing_pages={"activity.md": "---\nkind: dynamic\n---\n# Activity"},
            )
        )

        assert "`activity.md`" not in protected

    def test_incremental_prompt_forbids_changing_kind(self, grid_templates) -> None:
        prompt = _build_system_prompt(_snapshot(), is_greenfield=False, existing_pages={})

        assert "NEVER change an existing page's `kind`" in prompt

    def test_greenfield_protects_a_pin_that_somehow_exists(self, grid_templates) -> None:
        prompt = _build_system_prompt(
            _snapshot(),
            is_greenfield=True,
            existing_pages={"roadmap.md": PINNED_ROADMAP},
        )

        assert "`roadmap.md`" in prompt

    def test_missing_existing_pages_degrades_to_the_template_set(self, grid_templates) -> None:
        """A failed page fetch must not crash the run or widen the set."""
        protected = self._protected(
            _build_system_prompt(_snapshot(), is_greenfield=False, existing_pages=None)
        )

        assert "`charter.md`" in protected
        assert "`activity.md`" not in protected
