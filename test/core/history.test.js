import { describe, test, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  REVISION_ERROR_UNTERMINATED,
  appendRevision,
  readHistory
} from '../../src/core/history.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('history', () => {
  test('appendRevision creates per-message history file with revision metadata', async () => {
    project = createTmpProject();
    const sessionsDir = join(project.wtDir, '.sessions');
    await appendRevision(sessionsDir, '01ABC', {
      revision: 1,
      editedAt: '2026-05-14T15:32:00Z',
      editedBy: 'cs_xyz',
      priorBody: 'first version body'
    });
    const filePath = join(sessionsDir, '01ABC.history.md');
    expect(existsSync(filePath)).toBe(true);
    const text = readFileSync(filePath, 'utf8');
    expect(text).toContain('## Revision 1');
    expect(text).toContain('Edited at: 2026-05-14T15:32:00Z');
    expect(text).toContain('Edited by: cs_xyz');
    expect(text).toContain('first version body');
  });

  test('appendRevision appends to an existing history file', async () => {
    project = createTmpProject();
    const sessionsDir = join(project.wtDir, '.sessions');
    await appendRevision(sessionsDir, '01ABC', {
      revision: 1,
      editedAt: 't1',
      editedBy: 'a',
      priorBody: 'one'
    });
    await appendRevision(sessionsDir, '01ABC', {
      revision: 2,
      editedAt: 't2',
      editedBy: 'a',
      priorBody: 'two'
    });
    const history = await readHistory(sessionsDir, '01ABC');
    expect(history.length).toBe(2);
    expect(history[0].body).toBe('one');
    expect(history[1].body).toBe('two');
  });

  test('readHistory returns empty array when no history file exists', async () => {
    project = createTmpProject();
    const history = await readHistory(join(project.wtDir, '.sessions'), 'nope');
    expect(history).toEqual([]);
  });
});

// The reader ended a revision at the first `\n\n---`, so a prior body containing an
// ordinary markdown horizontal rule came back truncated at that rule — silently, with the
// full bytes still on disk. `GET /channel/message/:id` is the only surface that serves a
// prior revision, so this was the whole feature quietly lying.
//
// The asymmetry is why nothing caught it: YAML front matter and unified diffs SURVIVE,
// because their `---` is not preceded by a blank line. Only the idiomatic markdown rule
// died — so a test written with front matter or a diff passes while this is broken. All
// three shapes are pinned below.
describe('revision bodies survive their own delimiters', () => {
  const RULE_BODY = ['A', '', '---', '', 'B', '', '---', '', 'C must survive'].join('\n');
  const FRONT_MATTER_BODY = ['---', 'title: x', '---', '', 'real content'].join('\n');
  const DIFF_BODY = ['```diff', '--- a/x.js', '+++ b/x.js', '-old', '+new', '```'].join('\n');

  async function roundTrip(priorBody) {
    project = createTmpProject();
    const sessionsDir = join(project.wtDir, '.sessions');
    await appendRevision(sessionsDir, '01ABC', {
      revision: 1,
      editedAt: 't1',
      editedBy: 'cs_xyz',
      priorBody
    });
    return { sessionsDir, history: await readHistory(sessionsDir, '01ABC') };
  }

  test('a body containing markdown horizontal rules comes back whole', async () => {
    const { history } = await roundTrip(RULE_BODY);
    expect(history).toHaveLength(1);
    expect(history[0].body).toBe(RULE_BODY);
    // The specific loss: 30 of 31 bytes, leaving just "A".
    expect(history[0].body).not.toBe('A');
    expect(history[0].body).toContain('C must survive');
    expect(history[0].editedAt).toBe('t1');
    expect(history[0].editedBy).toBe('cs_xyz');
    expect(history[0].revision).toBe(1);
  });

  test('front matter and diffs — the shapes that always worked — still work', async () => {
    expect((await roundTrip(FRONT_MATTER_BODY)).history[0].body).toBe(FRONT_MATTER_BODY);
    expect((await roundTrip(DIFF_BODY)).history[0].body).toBe(DIFF_BODY);
  });

  test('a body containing a revision heading does not fabricate a revision', async () => {
    // Splitting on `\n## Revision ` turned the tail of a real revision into an extra
    // entry. Fence-delimited blocks cannot be split by their own content.
    const { history } = await roundTrip(['before', '', '## Revision 99', '', 'after'].join('\n'));
    expect(history).toHaveLength(1);
    expect(history[0].revision).toBe(1);
    expect(history[0].body).toContain('## Revision 99');
    expect(history[0].body).toContain('after');
  });

  test('several fenced revisions each keep their own rules and metadata', async () => {
    project = createTmpProject();
    const sessionsDir = join(project.wtDir, '.sessions');
    await appendRevision(sessionsDir, '01ABC', {
      revision: 1,
      editedAt: 't1',
      editedBy: 'a',
      priorBody: RULE_BODY
    });
    await appendRevision(sessionsDir, '01ABC', {
      revision: 2,
      editedAt: 't2',
      editedBy: 'b',
      priorBody: FRONT_MATTER_BODY
    });
    const history = await readHistory(sessionsDir, '01ABC');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ revision: 1, editedAt: 't1', editedBy: 'a', body: RULE_BODY });
    expect(history[1]).toMatchObject({
      revision: 2,
      editedAt: 't2',
      editedBy: 'b',
      body: FRONT_MATTER_BODY
    });
  });

  test('an unterminated fence is reported, never truncated into a plausible body', async () => {
    project = createTmpProject();
    const sessionsDir = join(project.wtDir, '.sessions');
    await appendRevision(sessionsDir, '01ABC', {
      revision: 1,
      editedAt: 't1',
      editedBy: 'a',
      priorBody: RULE_BODY
    });
    const filePath = join(sessionsDir, '01ABC.history.md');
    writeFileSync(
      filePath,
      readFileSync(filePath, 'utf8').replace(/^<!-- walkie:rev-end .*-->$/m, '')
    );
    const history = await readHistory(sessionsDir, '01ABC');
    expect(history).toHaveLength(1);
    // A confident partial body is worse than a named failure: the only use for a prior
    // revision is forensics on an edited message.
    expect(history[0].body).toBeNull();
    expect(history[0].bodyError).toBe(REVISION_ERROR_UNTERMINATED);
  });

  test('pre-fence history files still read through the legacy path', async () => {
    project = createTmpProject();
    const sessionsDir = join(project.wtDir, '.sessions');
    const filePath = join(sessionsDir, '01ABC.history.md');
    writeFileSync(
      filePath,
      ['## Revision 1', 'Edited at: t1', 'Edited by: a', '', 'legacy body', '', '---', ''].join('\n')
    );
    const history = await readHistory(sessionsDir, '01ABC');
    expect(history).toEqual([
      { revision: 1, editedAt: 't1', editedBy: 'a', body: 'legacy body' }
    ]);
  });
});
