# ADR-0021 — The Patchwork Harness tag, and `patchwork-harness approve`

**Status:** accepted, on by default (`PATCHWORK_HARNESS_TAG=off` or `--no-tag` turns it off) · 2026-10-02
**Owner:** maintainers · drafted with Claude
**Depends on:** ADR-0016 (L5 reviewer: a different vendor checks the work)

## Context

Two GitHub issues posted to firelex/jeff on 2 Oct 2026 (#7, #8) were checked
before posting by a cross-vendor review (GPT-6.1 Sol through `patchwork-harness ask`,
three rounds, which caught four overclaims). Each ended with a small line
saying so. the maintainer wants that line on what the harness publishes: commits, PRs
and issues. It should be on by default and easy to turn off.

A tag that says "approved" is a claim. It must only appear when a check
actually happened, or it becomes the sort of unverified success claim the
grounding verifier (ADR-0011) exists to catch.

## Decision

Two strengths, never more than the evidence (`src/core/tag.ts`):

| Strength | When | Commit | Issue / PR |
|---|---|---|---|
| **approved** | the text passed `patchwork-harness approve`: a reviewer from a vendor that did not write it approved it, with no high or medium concern | `Approved-by: Patchwork Harness, cross-vendor review by <model> (<url>)` | `<sub>✓ Patchwork Harness approved: checked before posting by a cross-vendor review (<model>) …</sub>` |
| **made** | a `git_ops` commit or `pr_create` inside a run | `Made-with: Patchwork Harness (<url>)` | `<sub>Made with Patchwork Harness.</sub>` |

- **Commits** get a git trailer, joined to an existing trailer block (such as
  Co-Authored-By) so git reads them all (`git interpret-trailers --parse`).
- **No stacking.** Text that already carries a tag is left alone.
- **Mid-run commits are "made", never "approved".** `git_ops` commits and PRs
  land before the gate and the L5 review have run.
- **`patchwork-harness approve [file] [--as issue|pr|commit|text] [-e evidence]…`** is
  the approved path. It reproduces the #7/#8 process as a command:
  - The reviewer is the first reachable `reviewer` from a vendor that did
    not write the draft. By default the writer's vendor is the executor's.
  - A reviewer that says approve while listing a high or medium concern is
    not believed.
  - An unreadable answer is never an approval.
  - A same-vendor reviewer can approve, but the draft is not tagged as
    cross-vendor.
  - stdout carries only the approved, tagged text, so it pipes into
    `gh issue create --body-file -`. Concerns go to stderr, and the exit
    code is 1 when the draft is not approved.

## Evidence (2 Oct 2026)

- **`tests/tag.test.ts`, 12 tests.** Trailers are read back by git itself,
  and a real `git_ops` commit is checked with `%(trailers)`. Six mutations
  were each caught:
  - the off switch
  - the "approve with a medium concern" rule
  - the cross-vendor rule
  - trailer joining
  - no stacking
  - the env switch
- **Live runs, about $0.01 in all.**
  - A draft claiming "proven the best code reviewer from any vendor, at half
    the cost" was refused. The reviewer flagged the overclaim and the wrong
    cost ratio (14% cheaper, not half).
  - A draft that counted 16 review outcomes as "16 planted bugs" was also
    refused, correctly, because the suite has 8 bugs, each reviewed twice.
  - The corrected draft was approved and tagged. As a commit, git read the
    `Approved-by` trailer.

## Consequences

- On for everyone by default. To opt out, put `PATCHWORK_HARNESS_TAG=off` in the
  environment or `~/.patchwork-harness/.env`, or pass `--no-tag` per command.
- **Not covered yet:**
  - The Claude Code mod (ADR-0020). Mods are still switched off for the
    account.
  - Issues created outside patchwork-harness, unless the text went through
    `patchwork-harness approve` first.
