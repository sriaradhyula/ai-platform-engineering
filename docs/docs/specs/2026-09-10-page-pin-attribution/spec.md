# Feature Specification: Attributed page-kind pins

**Feature Branch**: `2026-09-10-page-pin-attribution` (spec written on `prebuild/fix/tome-stable-pages-read-only`; no branch created)
**Created**: 2026-09-10
**Status**: Draft
**Input**: Store a wiki page's `kind` pin as an attributed fact: record who pinned it and when, surface it persistently in the page UI, and let downstream rules consume the attribution instead of inferring human intent from an anonymous frontmatter value.

## Problem

A wiki page's `kind` says who maintains it — a person, or the ingest agent. Today that value carries no record of **how it got there**. Two very different things look identical:

- the page template's default for that path, and
- a person deciding to take ownership of that page.

Consequences observed in production (issues #369, #348):

- An administrator changed a template default. Every subsequent ingest read the disagreement between the template and the page as *stale page*, not *deliberate human choice*, and reset the page. **20 of 77 recorded pins were undone**, across 8 people and 8 projects, some repeatedly over weeks.
- People could not tell the control had failed. One person used the toggle **three times in three minutes** on one page; two others set and immediately unset it, 4 seconds and 30 seconds apart. The state was invisible, so the only feedback available was to try again.

Guards added in #660 and #663 stop the damage by inferring intent from an explicit `kind` value. This feature removes the inference: the decision becomes a recorded fact with an owner and a date.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - I can see that my pin took effect (Priority: P1)

A project member marks a page as team-maintained. The page then states, persistently and wherever the page is read, that they marked it and when.

**Why this priority**: This alone ends the repeated-clicking failure, and it is the prerequisite for every other story — nothing downstream can honour a decision that was never recorded. Shippable on its own.

**Independent Test**: Mark a page as team-maintained, reload it, and confirm it reports who marked it and when. Testable with no changes to ingest behaviour.

**Acceptance Scenarios**:

1. **Given** a page maintained by the agent, **When** a member marks it team-maintained, **Then** the page shows that it was marked by them, with the date, and the statement survives a reload.
2. **Given** a page another member marked, **When** a second member views it, **Then** it names the person who marked it rather than addressing the viewer.
3. **Given** a page nobody has marked, **When** any member views it, **Then** no attribution is shown and the page reads as template-governed.
4. **Given** a marked page, **When** the marker's account is no longer resolvable, **Then** the page still reports that a person marked it, with the date, and degrades the name gracefully.

---

### User Story 2 - My decision outranks a template default (Priority: P2)

Automated maintenance treats a recorded human decision as authoritative. A later change to the template default does not undo it, and no automated run rewrites a page a person has claimed.

**Why this priority**: This is the correctness payoff and the reason the incident happened. It is P2 only because it depends on P1 having recorded the fact.

**Independent Test**: Mark a page, change the template default for that path, run automated maintenance, and confirm the page is unchanged and still attributed.

**Acceptance Scenarios**:

1. **Given** a page a member marked team-maintained, **When** an administrator changes the template default for that path, **Then** the page keeps its marking and its attribution.
2. **Given** a marked page, **When** an unattended automated run executes, **Then** the page's content and marking are unchanged and the run reports that it left the page alone.
3. **Given** a marked page, **When** a person explicitly asks for a change to it, **Then** the change is applied and the attribution is preserved.
4. **Given** a page nobody marked, **When** automated maintenance runs, **Then** it is maintained normally from the template default.
5. **Given** a page marked before this feature existed, **When** automated maintenance runs, **Then** it is protected to at least the same degree as before — an unrecorded pin must never be treated as an absent one.

---

### User Story 3 - I can see why a page is agent-maintained (Priority: P3)

A member looking at a page nobody has claimed can find out what is governing it, and that the governing default is an administrative setting rather than a property of the page.

**Why this priority**: Addresses the invisibility that let a single template edit change behaviour everywhere without project owners knowing. Valuable, but the incident is contained by P1 and P2.

**Independent Test**: Open an unclaimed page and confirm it identifies the template governing it and offers a route to that setting.

**Acceptance Scenarios**:

1. **Given** an unclaimed page, **When** a member asks why it is agent-maintained, **Then** they are shown the template governing it and its current default.
2. **Given** a claimed page, **When** a member asks the same question, **Then** they are shown the human decision instead, since it takes precedence.

---

### Edge Cases

- **Two people in quick succession**: the most recent decision stands and its attribution names the most recent decider.
- **The page is returned to the template default**: recorded as a human decision of its own; only an explicit reset action restores template governance (Q1).
- **Someone edits the page's raw front matter or uploads a file that omits it**, bypassing the control: the declared setting governs, and the page flags the disagreement with a one-step restore (Q2).
- **A page created by the agent** carries a kind from the template — never an attribution, because no person decided.
- **A page is deleted and restored**: restoring returns the page to its prior state, attribution included.
- **A reset action on a page nobody ever claimed**: a no-op, and must not fabricate an attribution.
- **Bulk or administrative template reset**: must not silently clear recorded human decisions.

## Requirements *(mandatory)*

### Functional Requirements

**Recording**

- **FR-001**: When a person changes a page's maintenance setting, the system MUST record who made the change and when.
- **FR-002**: The system MUST NOT record an attribution for a maintenance setting that came from a template default or from automated maintenance.
- **FR-003**: Automated maintenance MUST NOT create, alter, or clear an attribution.
- **FR-004**: A page marked before this feature existed MUST retain at least the protection it has today, whether or not an attribution can be reconstructed for it.

**Display**

- **FR-005**: A claimed page MUST state, persistently and on the page itself, that a person claimed it and when — not as a transient confirmation.
- **FR-006**: The statement MUST address the viewer directly when they are the person who claimed it, and name the person otherwise.
- **FR-007**: The date MUST be legible to a non-technical reader.
- **FR-008**: An unresolvable person MUST degrade to a still-useful statement rather than an error or a blank.
- **FR-009**: Anyone who can read the page MUST be able to see its attribution.

**Precedence**

- **FR-010**: A recorded human decision MUST take precedence over the template default for that path.
- **FR-011**: Changing a template default MUST NOT alter, clear, or override any recorded human decision on an existing page.
- **FR-011a**: Handing a page back to the agent MUST be recorded as a human decision in its own right, and MUST NOT clear the attribution. A page returns to template governance only through an explicit reset action.
- **FR-011b**: When the recorded decision and the page's declared setting disagree, the declared setting MUST govern behaviour, the page MUST surface the disagreement to the reader, and restoring the recorded decision MUST take one step.
- **FR-012**: Automated maintenance MUST treat a page with a recorded human decision as owned by that person, and leave it unchanged unless a person asks for the change.
- **FR-013**: An automated run MUST report pages it left alone because a person owns them, rather than reporting them as updated.
- **FR-014**: Review and approval behaviour for a page MUST be decided from the page's stored state, never from the content of the write being proposed.

**Template visibility**

- **FR-015**: A member viewing an unclaimed page MUST be able to see which template governs it and what that template's current default is.
- **FR-016**: A change to a template default MUST be recorded with who made it and when.

### Key Entities

- **Page maintenance setting**: who maintains a page — a person or the agent. Currently declared on the page; the source of the ambiguity this feature resolves.
- **Pin attribution**: the record that a specific person set the maintenance setting, and when. Absent on pages nobody has claimed. The unit of evidence every precedence rule reads.
- **Page template**: the administrative configuration supplying a default maintenance setting per page path. Governs pages nobody has claimed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person marking a page as team-maintained can confirm it worked without taking any further action — the page states it.
- **SC-002**: Repeat toggling of the same page's setting by one person within five minutes falls to zero, from a baseline where it occurred on multiple pages.
- **SC-003**: No page claimed by a person is altered by unattended automated maintenance — measured over a full maintenance cycle across all projects, target zero occurrences against a baseline of 20 in the incident window.
- **SC-004**: A change to a template default alters no page that a person has claimed.
- **SC-005**: A person can determine who claimed a page, and when, in a single step from the page itself.
- **SC-006**: A person can determine what governs an unclaimed page, and where that setting lives, in a single step from the page itself.
- **SC-007**: Reports from automated maintenance contain no claim of having changed a page it did not change.
- **SC-008**: A change to a template default alters no page a person handed back to the agent, just as it alters none they claimed.
- **SC-009**: A pin lost by an upload or a raw edit is visible to the reader and restorable in one step, where today it disappears silently.

## Assumptions

- Every claimed page has exactly one current owner: the most recent person to set it. Co-ownership is not modelled.
- Attribution records the decision, not a review workflow — being the owner of a page does not by itself change who may edit it.
- Existing permission rules are unchanged; this feature adds no new authority.
- "Explicitly asked" retains its current meaning: a direct request from a person, rather than an unattended scheduled run.
- Historical attributions, where reconstructed, are best-effort and must be presented no more confidently than the evidence supports.

## Out of Scope

- Renaming the maintenance-setting vocabulary in the interface.
- Recovering previously orphaned draft revisions (issue #613).
- Co-ownership, ownership transfer, or approval workflows.
- Notifying project members when an administrator changes a template default.

## Clarifications

### Q1: Returning a page to the template default — RESOLVED

**Decision**: **Retain it as a recorded decision.** Handing a page back to the agent is
itself a human decision and is recorded as one. A page returns to template governance only
through an explicit "reset to template default" action.

**Why**: Clearing it would reintroduce the original bug mirrored — a page someone
deliberately handed to the agent could be flipped back to team-maintained by a later
template edit, with no record that they chose otherwise. Every human decision is durable
in both directions, or the guarantee is not a guarantee.

### Q2: When the stored decision and the page's declared setting disagree — RESOLVED

**Decision**: **The declared setting wins, and the page surfaces the disagreement** with a
one-step route to restore the recorded decision.

**Why**: The editor exposes a raw mode and people edit front matter directly; making that
silently ineffective would introduce a new silent failure of exactly the kind this feature
exists to remove. Surfacing the conflict instead makes the production failure — an upload
without front matter discarding the uploader's own pin — visible and recoverable rather
than silent.

