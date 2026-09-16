// The changelog gate's pure half (ELEG-112). The CLI around it is
// scripts/check-landing-subject.ts, run by .github/workflows/changelog.yml.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkSubject,
  landingSubject,
  parseConventionalSubject,
  releaseItTypes,
} from '../../scripts/landing-subject';

const TYPES = ['feat', 'fix', 'chore'];

describe('parseConventionalSubject', () => {
  it('splits type, scope, breaking marker and description', () => {
    expect(parseConventionalSubject('feat(ui)!: drop the legacy layout')).toEqual({
      type: 'feat',
      scope: 'ui',
      breaking: true,
      description: 'drop the legacy layout',
    });
  });

  it('accepts a bare type with no scope', () => {
    expect(parseConventionalSubject('fix: keep the filter focused')).toMatchObject({
      type: 'fix',
      scope: null,
      breaking: false,
    });
  });

  it.each([
    ['Update stuff', 'no type'],
    ['fix keep the filter focused', 'no colon'],
    ['fix:keep the filter focused', 'no space after the colon'],
    ['fix(ui):', 'empty description'],
    ['fix(ui): ', 'whitespace-only description'],
    ['fix (ui): x', 'space before the scope'],
  ])('rejects %j (%s)', (subject) => {
    expect(parseConventionalSubject(subject)).toBeNull();
  });

  it('is case-sensitive, as conventional-changelog is', () => {
    // `Feat:` parses as a subject whose type is "Feat" — which then fails the type check
    // below. Pinned so nobody "helpfully" lower-cases here and diverges from the generator.
    expect(parseConventionalSubject('Feat: shout')?.type).toBe('Feat');
    expect(checkSubject('Feat: shout', TYPES).ok).toBe(false);
  });
});

describe('checkSubject', () => {
  it('passes a known type', () => {
    expect(checkSubject('chore(deps): bump vite', TYPES)).toMatchObject({ ok: true });
  });

  it('fails a type .release-it.json does not list, naming the list', () => {
    const v = checkSubject('wip: half done', TYPES);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('feat, fix, chore');
  });

  it('fails an unparseable subject with a different reason than an unknown type', () => {
    const v = checkSubject('Update stuff', TYPES);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('not a conventional commit subject');
  });
});

describe('landingSubject — the COMMIT_OR_PR_TITLE rule', () => {
  it('lands the sole commit subject for a one-commit PR, whatever the title says', () => {
    expect(
      landingSubject({ title: 'Update stuff', commitSubjects: ['fix(ui): the real subject'] }),
    ).toEqual({ subject: 'fix(ui): the real subject', source: 'commit' });
  });

  it('lands the PR title for a multi-commit PR, whatever the commits say', () => {
    expect(
      landingSubject({
        title: 'feat(server): presets',
        commitSubjects: ['wip', 'fixup! wip'],
      }),
    ).toEqual({ subject: 'feat(server): presets', source: 'title' });
  });
});

describe('releaseItTypes', () => {
  it('reads every type from the preset, hidden ones included', () => {
    const config = {
      plugins: {
        '@release-it/conventional-changelog': {
          preset: {
            types: [
              { type: 'feat', section: 'Features' },
              { type: 'chore', hidden: true },
            ],
          },
        },
      },
    };
    expect(releaseItTypes(config)).toEqual(['feat', 'chore']);
  });

  it('refuses to guess when the list is missing', () => {
    expect(() => releaseItTypes({ plugins: {} })).toThrow(/refuses to guess/);
  });

  it('agrees with the committed .release-it.json', () => {
    // The gate reads the real file in CI; this pins that the real file is in the shape the
    // reader expects, so a config edit that breaks the reader fails here and not on
    // someone's unrelated PR.
    const real = JSON.parse(
      readFileSync(new URL('../../.release-it.json', import.meta.url), 'utf8'),
    );
    const types = releaseItTypes(real);
    expect(types).toContain('feat');
    expect(types).toContain('fix');
    expect(types).toContain('chore');
  });
});
