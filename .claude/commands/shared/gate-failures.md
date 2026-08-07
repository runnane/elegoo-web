---
description: SHARED (byte-identical in RCP/ANS/SPND/VTK) — what to do when a gate fails: capture the evidence before re-running, attribute a flake, prove a guard is load-bearing.
---

# shared: when a gate fails

**This file is byte-identical in all four sibling repos** (RCP, ANS, SPND, VTK) and is
verified that way — `/sync-commands` compares `sha256sum`. Do not edit it in one repo
alone; a change here is a change in four places, in the same pass. Anything that names a
specific command, test runner, linter or known flake belongs in that repo's
[`local/gates.md`](../local/gates.md) instead, which is what makes byte-identity possible
at all.

Read this when a gate has **actually failed**. It is not pre-flight reading — the commands
you run before finishing a change live in the repo's own `/fix` and `/auto`.

The whole file exists because of one recurring failure: a gate goes red, the evidence gets
destroyed by the next command, and the pass ends up either waving a real bug through as
flake or spending an hour re-deriving what the first run already said.

## 1. Capture WHICH check failed before you run anything else

A gate summary names the **gate**, not the failure: `✗ unit tests` tells you nothing you
can act on, and the test name that would have is in the output you are about to scroll
past. **A re-run destroys it.** So before re-running, before reasoning, before touching
the code: extract the failing check's name and its assertion into the transcript.

Two transient failures in one 2026-07-31 pass are unattributable *forever* because the
summary was read and the suite simply re-run. That is the entire cost model: the evidence
is free at the moment it exists and unrecoverable ten seconds later.

## 2. Redirect the run to a file; never pipe it through `tail`

Piping a gate run through `tail -25` keeps the summary and discards everything that
explains it — which is exactly backwards, because the summary is the part you can
reproduce for free. Redirect to a log file, echo the exit status, and `grep` the file:

```
<gate command> > <scratchpad>/gates.log 2>&1; echo "exit=$?"
```

Then grep for the failure marker (whatever your runner prints — see `local/gates.md`) to
get the failing names, and read around them. One pass lost a unit-test failure this way
and had to re-run the whole suite to discover it was a single banned-pattern check.

## 3. Know your linter's exit-code semantics before you trust a green tick

Some linters exit 0 on warnings and non-zero only on errors. Where that is true, a wall of
familiar-looking output can contain one **new error** buried among dozens of standing
warnings, and the run still passes or the eye still skips it. Do not read the list and
judge; **diff against `main`** — stash, run the linter, compare. On 2026-08-03 that
distinguished 28 pre-existing warnings from two real errors in new code.

Your repo may have closed this gap deliberately (treating warnings as errors). If so its
`local/gates.md` says so, and this section is a reminder not to assume the looser
behaviour. Either way, the thing to know is which one you are in — not to guess.

## 4. Attributing a flake: cheapest test first

Work down this ladder and stop at the first step that answers it.

**a. Could this branch possibly have caused it?** If the failing check reads files your
diff does not touch, the branch content *is* the proof and no probe is needed. Twice in one
2026-08-04 pass the same test failed — once on a **docs-only** branch, once on a branch
touching an unrelated module — and neither diff goes anywhere near it. Record the sighting
**with the actual failing assertion** on the known-flake issue and move on.

The trap is the mirror image: when the branch *could* plausibly have caused it, do not skip
the probe. Reason about which files the failing check actually reads before deciding, not
about how unrelated the change feels.

**b. Stash and test `main`.** When the branch plausibly could have caused it, neither
re-running nor reasoning settles it. This does:

```
git stash push -u -m probe && git switch main
<rebuild if the check runs against a build artefact>
<run only the failing check, repeated ~20 times>
git switch - && git stash pop
```

A failure on clean `main` proves it is not yours. Twenty green runs on `main` against a
failure on your branch is strong evidence it is. Used twice in one 2026-08-03 pass; once it
exonerated a shared change, and the repeat loop also produced the **actual failing
assertion**, which two earlier sightings of that flake had never captured.

Two things that make this probe useless if you get them wrong, both in `local/gates.md`:
whether the check needs a **rebuild** first, and whether running it in isolation resets
whatever state it shares with the rest of the suite. A low-frequency flake also needs ~20
repeats to appear at all — five proves nothing.

**c. Never wave a *reproducible* failure through as flake.** A known-flake issue is an
explanation for an intermittent failure, not a licence. If it fails every time, it is
yours.

## 5. A hypothesis you tested and refuted is worth writing down

The 2026-08-04 flake looked like a leaked child process outliving its test and calling a
later test's sink — plausible, and a shape already documented in an earlier PR. It was
**wrong**: forcing the orphan's exit left the suite green. Recording the elimination on the
issue stops the next person spending the same hour, and the hygiene bug the investigation
exposed was still worth its own issue.

So: an untested hypothesis in a comment is noise; a tested one is evidence **either way**.
Write down what you ruled out, not just what you found.

## 6. To prove a new guard is load-bearing, patch and reverse-patch

Make a new assertion **refuse before you make it pass**. Neutralising the condition and
watching the test fail is the right check — it caught two guards that were genuinely doing
work in one pass, and it is the only way to know a new test is not vacuously green. Also
confirm the config key or flag you are asserting on is one the code actually reads.

**Undo the neutralisation with an inverse patch, never `git checkout <file>`.** That
discards *every* uncommitted change in the file: in one pass it silently reverted ~145
lines of finished work, and in another ~50. Write the mutation with a script that asserts
its own match count, then write the inverse — and if a no-op `replace` plus an unchecked
`find()` is your tool, prefer an editor that fails loudly on a missed match over one that
corrupts on one.

**The cheapest inverse patch is a copy taken immediately before the mutation.** Copy the
file, mutate, run, restore from the copy — and then **diff the restored file against the
copy** rather than assuming. A restore that half-applied looks exactly like a clean one
until much later:

    cp path/to/file .bak && <mutate> && <run> && cp .bak path/to/file && diff path/to/file .bak

Take the copy *per mutation*, not once for the whole session; a stale copy restores the
previous mutation's state and the next result is attributed to the wrong change.

**After the last restore, re-run the suite once and check the total matches the
pre-mutation baseline.** A different number means something was lost, and this is the only
step that catches it — a run of green mutations is exactly when you have stopped reading
the output carefully, and the next red run reads as though the mutation caused it.

## Where the concrete commands are

Everything above is deliberately tool-free. Your repo's exact gate command, failure
markers, known flakes, rebuild requirements and isolation caveats are in
[`local/gates.md`](../local/gates.md) — read it alongside this file the first time a gate
fails in a pass.
