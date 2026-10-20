import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkDataset,
  checkLibrary,
  isValidLanguageCode,
  extractLanguageFromId,
  resolveLibraryLanguage,
  adaptiveBudget,
  ROOT
} from './check-library.mjs';

test('isValidLanguageCode validates ISO 639-1 and BCP-47 codes', () => {
  assert.equal(isValidLanguageCode('en'), true);
  assert.equal(isValidLanguageCode('de'), true);
  assert.equal(isValidLanguageCode('en-GB'), true);
  assert.equal(isValidLanguageCode('pt-BR'), true);
  assert.equal(isValidLanguageCode('zh-Hans'), true);
  assert.equal(isValidLanguageCode(''), false);
  assert.equal(isValidLanguageCode(null), false);
  assert.equal(isValidLanguageCode('123'), false);
});

test('extractLanguageFromId handles single-part, multi-word names, and region codes', () => {
  assert.equal(extractLanguageFromId('starter-en'), 'en');
  assert.equal(extractLanguageFromId('henry-james-en'), 'en');
  assert.equal(extractLanguageFromId('edgar-allan-poe-en'), 'en');
  assert.equal(extractLanguageFromId('classic-fiction-de'), 'de');
  assert.equal(extractLanguageFromId('scottish-tales-en-gb'), 'en-gb');
  assert.equal(extractLanguageFromId('sample'), null);
  assert.equal(extractLanguageFromId('sample-123'), null);
});

test('checkDataset rejects Wikipedia datasets (decision D389)', async () => {
  const problems = [];
  const notes = [];
  const fail = (where, msg) => problems.push(`${where}: ${msg}`);

  const folder = await mkdtemp(join(tmpdir(), 'kalibre-main-wiki-'));
  const mockManifest = {
    kalibreDataset: 1,
    id: 'wikipedia-article-en',
    version: '2026-10-20',
    revision: 1,
    language: 'en',
    source: {
      type: 'wikipedia',
      host: 'en.wikipedia.org',
      titles: ['Ada Lovelace']
    },
    kind: 'quotes',
    quoteCount: 1,
    files: {}
  };

  await checkDataset('wikipedia-article-en', folder, mockManifest, { fail, notes });

  assert.ok(
    problems.some((p) => p.includes('prohibits Wikipedia datasets (decision D389)')),
    `Expected D389 rejection problem, got: ${problems.join('; ')}`
  );
});

test('checkDataset rejects invalid language codes and suffix mismatches', async () => {
  const problems = [];
  const notes = [];
  const fail = (where, msg) => problems.push(`${where}: ${msg}`);
  const folder = await mkdtemp(join(tmpdir(), 'kalibre-main-lang-'));

  // Invalid language code
  const badLangManifest = {
    kalibreDataset: 1,
    id: 'my-books-en',
    version: '2026-10-20',
    revision: 1,
    language: 'invalid-lang-code-12345!',
    source: { type: 'gutenberg' },
    kind: 'quotes',
    files: {}
  };
  await checkDataset('my-books-en', folder, badLangManifest, { fail, notes });
  assert.ok(problems.some((p) => p.includes('invalid or missing language code')));

  // Suffix mismatch
  problems.length = 0;
  const mismatchManifest = {
    kalibreDataset: 1,
    id: 'my-books-de',
    version: '2026-10-20',
    revision: 1,
    language: 'en',
    source: { type: 'gutenberg' },
    kind: 'quotes',
    files: {}
  };
  await checkDataset('my-books-de', folder, mismatchManifest, { fail, notes });
  assert.ok(problems.some((p) => p.includes('suffix "-de" does not match manifest language "en"')));
});

test('checkLibrary rejects libraries with multiple languages across datasets', async () => {
  const mockRoot = await mkdtemp(join(tmpdir(), 'kalibre-main-library-test-'));

  // Dataset 1: English
  await mkdir(join(mockRoot, 'books-en'), { recursive: true });
  await writeFile(
    join(mockRoot, 'books-en', 'manifest.json'),
    JSON.stringify({
      kalibreDataset: 1,
      id: 'books-en',
      name: 'Books EN',
      version: '2026-10-20',
      revision: 1,
      language: 'en',
      source: { type: 'gutenberg' },
      kind: 'quotes',
      quoteCount: 1,
      files: {}
    }, null, 2)
  );

  // Dataset 2: German
  await mkdir(join(mockRoot, 'books-de'), { recursive: true });
  await writeFile(
    join(mockRoot, 'books-de', 'manifest.json'),
    JSON.stringify({
      kalibreDataset: 1,
      id: 'books-de',
      name: 'Books DE',
      version: '2026-10-20',
      revision: 1,
      language: 'de',
      source: { type: 'gutenberg' },
      kind: 'quotes',
      quoteCount: 1,
      files: {}
    }, null, 2)
  );

  const result = await checkLibrary(mockRoot);
  assert.ok(
    result.problems.some((p) => p.includes('must contain exactly one language across all datasets')),
    `Expected cross-language library rejection, got: ${result.problems.join('; ')}`
  );
});

test('resolveLibraryLanguage follows D393: library.json, then folder suffixes, then manifests', () => {
  const named = (id, language) => ({ id, language });
  assert.equal(resolveLibraryLanguage({ language: ' EN ' }, [named('a-de', 'de')]), 'en');
  assert.equal(resolveLibraryLanguage({ language: 'not a code!' }, [named('a-en', 'en')]), null);
  assert.equal(resolveLibraryLanguage({}, [named('a-en', 'en'), named('b-en', 'en')]), 'en');
  assert.equal(resolveLibraryLanguage(null, [named('a-en', 'en'), named('b-de', 'de')]), null);
  assert.equal(resolveLibraryLanguage(null, [named('plain', 'fr'), named('other', 'FR')]), 'fr');
  assert.equal(resolveLibraryLanguage(null, [named('plain', 'fr'), named('other', undefined)]), null);
  assert.equal(resolveLibraryLanguage(null, []), null);
});

test('checkLibrary expects the library language in index.json, as the librarian writes it (D393)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kalibre-main-library-index-'));
  const manifestText = JSON.stringify({
    kalibreDataset: 1, id: 'books-en', name: 'Books EN', version: '2026-10-20', revision: 1,
    language: 'en', licence: 'PD', source: { type: 'gutenberg' }, kind: 'quotes', quoteCount: 1, files: {}
  }, null, 2);
  await mkdir(join(root, 'books-en'));
  await writeFile(join(root, 'books-en', 'manifest.json'), manifestText);
  await writeFile(join(root, 'library.json'), JSON.stringify({ name: 'test shelf', description: 'For tests.' }));
  const entry = {
    id: 'books-en', path: 'books-en/manifest.json', name: 'Books EN', kind: 'quotes', language: 'en', version: '2026-10-20',
    revision: 1, licence: 'PD', authors: [], titles: [], works: 0, quotes: 1, passages: 0, bytes: Buffer.byteLength(manifestText), textBytes: 0
  };
  const write = (library) => writeFile(join(root, 'index.json'), JSON.stringify({ kalibreDatasetIndex: 1, updatedAt: '2026-10-20', library, datasets: [entry] }));
  const indexProblems = async () => (await checkLibrary(root)).problems.filter((problem) => problem.startsWith('index.json'));

  await write({ name: 'test shelf', description: 'For tests.', language: 'en' });
  assert.deepEqual(await indexProblems(), []);
  await write({ name: 'test shelf', description: 'For tests.' });
  assert.equal((await indexProblems()).length, 1, 'an index without the language is not what the librarian writes');
  await write({ name: 'test shelf', description: 'For tests.', language: 'de' });
  assert.equal((await indexProblems()).length, 1, 'an index with the wrong language is rejected');
});

test('adaptive budgets: v4 datasets are held to them, v3 to the flat 300, and an explicit ceiling always wins', async () => {
  assert.equal(adaptiveBudget(400, 'short', false), 46);
  assert.ok(adaptiveBudget(400, 'short', true) > adaptiveBudget(400, 'short', false));
  assert.ok(adaptiveBudget(1e6, 'massive', false) <= 150, 'the practical maximum bounds a very large work');
  assert.equal(adaptiveBudget(400, 'short', false, 10), 10);

  const build = async (derived) => {
    const folder = await mkdtemp(join(tmpdir(), 'kalibre-main-budget-'));
    await mkdir(join(folder, 'passages'));
    await mkdir(join(folder, 'works'));
    await writeFile(join(folder, 'works', 'w.txt'), `${Array(400).fill('word').join(' ')}\n`);
    await writeFile(join(folder, 'passages', 'w.json'), JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: `w.s${i}` }))));
    await writeFile(join(folder, 'passage-index.json'), JSON.stringify({ w: { short: 100, medium: 0, long: 0, huge: 0, massive: 0 } }));
    const manifest = {
      kalibreDataset: 1, id: 'budget-en', name: 'Budget', version: '2026-10-20', revision: 1, language: 'en', source: { type: 'gutenberg' },
      works: [{ id: 'w', file: 'works/w.txt', passages: 'passages/w.json', wordCount: 400 }],
      derived: { passageIndex: 'passage-index.json', ...derived }
    };
    const problems = [];
    await checkDataset('budget-en', folder, manifest, { fail: (where, message) => problems.push(`${where}: ${message}`), notes: [] });
    return problems.filter((problem) => /passages; the /.test(problem));
  };
  assert.equal((await build({ normaliserVersion: 4 })).length, 1, 'v4: 100 short passages exceed the adaptive budget of 46');
  assert.match((await build({ normaliserVersion: 4 }))[0], /v4 adaptive budget is 46/);
  assert.deepEqual(await build({ normaliserVersion: 3 }), [], 'v3: the flat 300 still applies');
  assert.equal((await build({ normaliserVersion: 4, maxPerCategory: 20 })).length, 1, 'v4 with a ceiling: the ceiling is the limit');
  assert.deepEqual(await build({ normaliserVersion: 4, maxPerCategory: null }), [], 'no limit stays unlimited');
});

test('real Kalibre Main Library passes all checks', async () => {
  const result = await checkLibrary(ROOT);
  assert.equal(result.problems.length, 0, `Expected 0 problems in real library, got: ${result.problems.join('; ')}`);
  assert.ok(result.checkedCount >= 10, `Expected at least 10 datasets, checked ${result.checkedCount}`);
});
