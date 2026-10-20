# devflow-kit

> A stack-agnostic R&D workflow: requirement → contract → implementation → test → verification → release.
> **Zero dependencies** (Node built-ins only), data decoupled from UI.
> Enforcement comes from **artifact contracts + a state machine + executable gates**, not from prose.

> First time here? Read [`docs/00-quickstart.md`](docs/00-quickstart.md).
> Need contract diffing, the board plugin or multi-repo workspaces? See [`docs/08-advanced.md`](docs/08-advanced.md).

## Install in one line

```bash
git clone https://github.com/darkknight110/devflow-kit.git ~/.devflow-kit && ~/.devflow-kit/bin/devflow --help
```

> **Not on npm on purpose.** The name `devflow-kit` belongs to an unrelated project — `npm i -g devflow-kit`
> installs something else. Distribution is git-only, and the CLI needs nothing but Node ≥ 18.

## Ten minutes, end to end

```bash
./bin/devflow init --name my-project      # detects the stack from pom.xml / package.json / pyproject.toml / go.mod
./bin/devflow doctor                      # health check: are these gates trustworthy at all?
./bin/devflow new --slug first --tier light --title "First change"
./bin/devflow clarify <change>            # unresolved questions block implementation
./bin/devflow advance <change> --to verified   # refuses to advance when artifacts are missing
./bin/devflow gate run <change> --to verified  # runs the gates and records the evidence
./bin/devflow report                      # read-only HTML board
```

## What problem it solves

Most "AI workflow" tooling produces documents that *look* compliant. This one refuses to report success when it
cannot prove it:

| Failure mode | How this tool answers |
|---|---|
| Gate is always true (`exit 0`) | Negative-control gate: no non-zero control ⇒ verdict is ⚠, never ✓ |
| Exit code 1 from "no tests found" | Requires explicit failure evidence, not just a non-zero exit |
| Piping through `tail` proves nothing | Uses the invoked command's own exit code |
| 15 tests counted as 4 | Counts **every** match across modules |
| Template placeholders counted as filled | `isRealValue()` treats `（name）` and unselected options as empty |
| "I reviewed it" with no trace | Review claim requires an actor plus timestamp or measured evidence |
| Silent tier downgrade | Heuristic gate flags contract/interface changes made in a light tier |
| Build is green, artifact is broken | G8 scans built artifacts (e.g. leftover `process.env` in mini-program bundles) |

## Gates

`G0` config · `G1` artifacts · `G1b` content · `G2` evidence shape · `G3` negative control · `G4/G4b` context budget ·
`G5` state consistency · `G6` baseline exemptions · `G7` change-surface vs tier · `G8` artifact runtime sanity.

Full criteria, evidence fields and **12 anti-patterns** — quotable on their own:
**[`docs/09-gates-reference.md`](docs/09-gates-reference.md)**

## Verification (must be green before delivery)

```bash
npm test                       # 43 unit tests on the pure-function layer (node:test, zero deps)
node scripts/selfcheck.mjs     # 70/70 self-checks: the gate system validating itself
bash examples/verify-all.sh    # self-check + six end-to-end suites
```

## Design constraints

1. **Zero dependencies** — no third-party packages, no build step.
2. **Canon lives in JSON** — gate rules live in `spec/*.json`, not scattered in code.
3. **Data/UI decoupling** — state lives only in `.devflow/`; terminal, board and views are projections.
4. **Judge against the target state** — advancing checks what the *target* requires, not what the current state has.
5. **Unknown state is an error** — never "no requirements", never a silent pass.
6. **Additive only** — generators never overwrite existing files or rewrite an existing repo.

## Known limits

Read [`docs/01-workflow-spec.md`](docs/01-workflow-spec.md) §11. In short: confirmation points cannot be enforced
with a single person; G7 is heuristic and will miss cases; context budget is estimated in characters, not tokens;
the board is read-only.

## Related

**[md-to-office](https://github.com/darkknight110/md-to-office)** — Markdown → typeset Chinese Word/PDF, with
ASCII diagrams replaced by real layered images. Same maintainer; it covers the "hand over a deliverable" end of the
workflow.

MIT.
