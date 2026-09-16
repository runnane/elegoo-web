// The changelog gate's CLI (ELEG-112). Run by .github/workflows/changelog.yml on every
// pull request; the logic is in ./landing-subject.ts, which is what the tests cover.
//
//   PR_TITLE=<title> PR_COMMITS_FILE=<json array of commit subjects> \
//     pnpm exec tsx scripts/check-landing-subject.ts
//
// Exit 1 when the subject that would land on `main` is not a conventional commit subject
// with a type `.release-it.json` knows about. Everything it decides is also written to
// $GITHUB_STEP_SUMMARY when that is set, so the verdict is readable from the check page
// without opening the log.
//
// Inputs come in through the environment on purpose: a PR title is outside-user text on a
// public repo, and `${{ github.event.pull_request.title }}` interpolated into a `run:`
// script is the textbook Actions injection. An env var is inert.

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkSubject, landingSubject, releaseItTypes } from './landing-subject.js';

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}

function summary(lines: string[]): void {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) {
    // Append: the workflow may have written to the summary already.
    appendFileSync(file, text);
  }
}

function main(): number {
  const configPath = process.env.RELEASE_IT_CONFIG ?? '.release-it.json';
  const types = releaseItTypes(JSON.parse(readFileSync(configPath, 'utf8')));
  const title = env('PR_TITLE');
  const commitSubjects: unknown = JSON.parse(readFileSync(env('PR_COMMITS_FILE'), 'utf8'));
  if (!Array.isArray(commitSubjects) || !commitSubjects.every((s) => typeof s === 'string')) {
    throw new Error('PR_COMMITS_FILE must hold a JSON array of strings');
  }

  const landing = landingSubject({ title, commitSubjects });
  const verdict = checkSubject(landing.subject, types);

  const lines: string[] = ['### Changelog gate', ''];
  const where =
    landing.source === 'commit'
      ? 'the sole commit’s subject (1-commit PR under `COMMIT_OR_PR_TITLE`)'
      : `the PR title (${commitSubjects.length} commits under \`COMMIT_OR_PR_TITLE\`)`;
  lines.push(
    `Subject that lands on \`main\` when squashed — ${where}:`,
    '',
    `> ${landing.subject}`,
    '',
  );

  if (verdict.ok) {
    const { type, scope, breaking } = verdict.parsed;
    const bump = breaking
      ? 'major'
      : type === 'feat'
        ? 'minor'
        : type === 'fix'
          ? 'patch'
          : 'none by itself';
    lines.push(
      `✅ \`${type}\`${scope ? `(\`${scope}\`)` : ''}${breaking ? ' — **breaking**' : ''}; release bump: ${bump}.`,
    );
  } else {
    lines.push(`❌ ${verdict.reason}`);
    lines.push(
      '',
      landing.source === 'commit'
        ? 'Fix it by amending the commit subject (or by adding a second commit, after which the PR title is what lands — and is then what this check reads).'
        : 'Fix it by editing the PR title.',
    );
  }

  // Under a rebase or merge-commit merge every commit lands as-is. Report, never fail:
  // fixup commits in a multi-commit PR are normal and the squash path drops them.
  const dropped = commitSubjects.filter((s) => !checkSubject(s, types).ok);
  if (dropped.length > 0) {
    lines.push(
      '',
      `${dropped.length} of ${commitSubjects.length} commit subject(s) would be dropped from the changelog if this PR were rebase-merged rather than squashed (informational):`,
      '',
      ...dropped.map((s) => `- \`${s}\``),
    );
  }

  summary(lines);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
