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

test('real Kalibre Main Library passes all checks', async () => {
  const result = await checkLibrary(ROOT);
  assert.equal(result.problems.length, 0, `Expected 0 problems in real library, got: ${result.problems.join('; ')}`);
  assert.ok(result.checkedCount >= 10, `Expected at least 10 datasets, checked ${result.checkedCount}`);
});
