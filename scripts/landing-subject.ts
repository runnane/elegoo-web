// The pure half of the changelog gate (ELEG-112). No I/O here — this is the part a
// unit test can reach; scripts/check-landing-subject.ts is the CLI around it.
//
// WHAT IS BEING CHECKED
//
// There are no changesets in this repo: `release-it` + `@release-it/conventional-changelog`
// build CHANGELOG.md and the GitHub release notes from commit subjects on `main`. So the
// only "changeset" a PR can carry is the subject that will land when it merges, and a PR
// whose subject does not parse — `Update stuff`, `WIP`, `Fix bug` — merges fine and then
// silently vanishes from the next release's notes. That is drift in the one place users
// look, and nothing else catches it.
//
// WHICH SUBJECT LANDS
//
// The repository's squash setting is `COMMIT_OR_PR_TITLE` (read with
// `gh api repos/runnane/elegoo-web --jq .squash_merge_commit_title` on 2026-09-16):
//
//   1 commit in the PR  → that commit's subject becomes the squash commit's subject
//   2+ commits          → the PR title does
//
// So the check is aimed at exactly that string — not at the title alone, which is what a
// generic "semantic PR title" action checks and which is NOT what lands for the common
// one-commit PR. The other two merge strategies (rebase, merge commit) land every commit
// as-is; those are reported, never failed, because a multi-commit PR's fixup commits are
// normal and the squash path drops them anyway.
//
// The allowed types come from `.release-it.json`'s `preset.types`, read by the CLI, so the
// gate and the changelog generator share one list and cannot drift apart (ELEG-5's rule,
// applied to a different pair of files).

export interface ConventionalSubject {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
}

// conventional-changelog's own parser: `^(\w*)(?:\((.*)\))?!?: (.*)$` — case-sensitive,
// type then optional scope, optional `!`, and a colon-space. Mirrored here rather than
// imported so the check has no dependency on a package whose parser could change shape
// under a Dependabot bump without this file noticing.
const SUBJECT_RE = /^(?<type>\w+)(?:\((?<scope>[^()]+)\))?(?<bang>!)?: (?<description>\S.*)$/;

export function parseConventionalSubject(subject: string): ConventionalSubject | null {
  const m = SUBJECT_RE.exec(subject);
  if (!m || !m.groups) return null;
  return {
    type: m.groups.type,
    scope: m.groups.scope ?? null,
    breaking: m.groups.bang === '!',
    description: m.groups.description,
  };
}

export type SubjectVerdict =
  | { ok: true; parsed: ConventionalSubject }
  | { ok: false; reason: string };

export function checkSubject(subject: string, allowedTypes: readonly string[]): SubjectVerdict {
  const parsed = parseConventionalSubject(subject);
  if (!parsed) {
    return {
      ok: false,
      reason:
        `"${subject}" is not a conventional commit subject — expected ` +
        '`type(scope)!: description`, e.g. `fix(ui): keep the filter focused across updates`.',
    };
  }
  if (!allowedTypes.includes(parsed.type)) {
    return {
      ok: false,
      reason:
        `type "${parsed.type}" is not one .release-it.json knows about — ` +
        `use one of: ${allowedTypes.join(', ')}.`,
    };
  }
  return { ok: true, parsed };
}

export interface LandingInput {
  /** The PR title as GitHub holds it now. */
  title: string;
  /** The first line of every commit message in the PR, in PR order. */
  commitSubjects: readonly string[];
}

export interface LandingSubject {
  subject: string;
  /** Which string the squash would use, per COMMIT_OR_PR_TITLE. */
  source: 'commit' | 'title';
}

// The COMMIT_OR_PR_TITLE rule, in one place. A PR with no commits cannot merge at all,
// so that case falls to the title only to give the caller something to report.
export function landingSubject(input: LandingInput): LandingSubject {
  if (input.commitSubjects.length === 1) {
    return { subject: input.commitSubjects[0], source: 'commit' };
  }
  return { subject: input.title, source: 'title' };
}

// `.release-it.json` → the type names the changelog generator recognises. Hidden types
// count: `chore:` is a legitimate subject that merely does not get a changelog line.
export function releaseItTypes(config: unknown): string[] {
  const types = (config as { plugins?: Record<string, { preset?: { types?: unknown } }> })
    ?.plugins?.['@release-it/conventional-changelog']?.preset?.types;
  if (!Array.isArray(types) || types.length === 0) {
    throw new Error(
      '.release-it.json has no plugins["@release-it/conventional-changelog"].preset.types — ' +
        'the changelog gate reads its allowed types from there and refuses to guess.',
    );
  }
  return types.map((t: { type?: unknown }) => {
    if (typeof t?.type !== 'string' || t.type.length === 0) {
      throw new Error(
        `.release-it.json preset.types entry without a string "type": ${JSON.stringify(t)}`,
      );
    }
    return t.type;
  });
}
