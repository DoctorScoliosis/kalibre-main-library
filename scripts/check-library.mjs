#!/usr/bin/env node
// Checks this library before it is published, with Node alone (18 or later).
//
//   node scripts/check-library.mjs [--base <git ref>]
//
// Kalibre reads this repository's default branch directly, so whatever is
// merged is what people download. The checks:
//   - every dataset folder has a manifest of the right shape, and its id is the folder's;
//   - no dataset manifests declare prohibited sources (e.g. source.type: 'wikipedia', D389);
//   - every dataset manifest declares a recognised, valid language code;
//   - dataset folder name suffixes agree with their manifest language (e.g. -en);
//   - the library as a whole contains exactly one language across all datasets;
//   - `files` in the manifest lists a SHA-256 for every file but the manifest, matching
//     what is on disk, with nothing extra left in the folder; each text matches its own `sha256`;
//   - passage counts match the passage files, and per-category limits match the
//     dataset's normaliser: v3 defaults to 300, while v4 uses adaptive budgets;
//   - `index.json` is exactly what the folders say (it is never edited by hand), including
//     the library's language in its `library` block (D393), as the librarian writes it;
//   - with --base: a dataset whose files differ from the base ref's has a higher `revision`,
//     and a revision never goes down.
// A dataset built by an older normaliser than NORMALISER is reported, not failed.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const NORMALISER = 4;
export const DEFAULT_CAP = 300;
export const CATEGORIES = ['short', 'medium', 'long', 'huge', 'massive'];
export const CATEGORY_SCALING = {
  short: { floor: 30, factor: 0.8, max: 400 },
  medium: { floor: 35, factor: 0.9, max: 450 },
  long: { floor: 25, factor: 0.7, max: 350 },
  huge: { floor: 15, factor: 0.5, max: 250 },
  massive: { floor: 8, factor: 0.35, max: 150 }
};

export const PROHIBITED_SOURCE_TYPES = Object.freeze(['wikipedia']);

export function isValidLanguageCode(code) {
  if (!code || typeof code !== 'string') return false;
  return /^[a-z]{2,3}(?:-[a-zA-Z0-9]+)*$/i.test(code.trim());
}

export function extractLanguageFromId(id) {
  if (!id || typeof id !== 'string') return null;
  const parts = id.trim().split('-');
  if (parts.length < 2) return null;
  if (parts.length >= 3) {
    const twoPart = `${parts[parts.length - 2]}-${parts[parts.length - 1]}`.toLowerCase();
    if (/^[a-z]{2}-(?:[a-z]{2}|[0-9]{3}|[a-z]{4})$/i.test(twoPart) && isValidLanguageCode(twoPart)) {
      return twoPart;
    }
  }
  const last = parts[parts.length - 1].toLowerCase();
  if (/^[a-z]{2,3}$/i.test(last) && isValidLanguageCode(last)) {
    return last;
  }
  return null;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${path}: ${error.message}`);
  }
}

async function walk(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(dir, path));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

const unique = (values) => [...new Set(values.filter(Boolean))];

// D393: a library has one language: library.json's own, else the one its dataset
// folders' suffixes agree on, else the one its manifests agree on. The index's `library`
// block copies it, exactly as the librarian writes it (null when none can be settled;
// a disagreement is reported separately, as a library holding several languages).
export function resolveLibraryLanguage(about, manifests) {
  if (about?.language) return isValidLanguageCode(about.language) ? about.language.trim().toLowerCase() : null;
  if (!manifests.length) return null;
  const suffixes = manifests.map((manifest) => extractLanguageFromId(manifest.id)).filter(Boolean);
  if (suffixes.length === manifests.length) return unique(suffixes).length === 1 ? suffixes[0] : null;
  const languages = manifests.map((manifest) => manifest.language?.toLowerCase()).filter(Boolean);
  if (languages.length === manifests.length) return unique(languages).length === 1 ? languages[0] : null;
  return null;
}

const sum =(values) => values.reduce((total, value) => total + value, 0);
const size = async (path) => { try { return (await stat(path)).size; } catch { return 0; } };

export function adaptiveBudget(wordCount, category, flowPass, ceiling = null) {
  const spec = CATEGORY_SCALING[category];
  const raw = Math.round((spec.floor + spec.factor * Math.sqrt(wordCount)) * (flowPass ? 1.3 : 1));
  const maxBound = ceiling !== null ? ceiling : Math.round(spec.max * (flowPass ? 1.25 : 1));
  const budget = Math.max(spec.floor, Math.min(raw, maxBound));
  return ceiling !== null ? Math.min(budget, ceiling) : budget;
}

// One dataset's entry in index.json, as the librarian writes it.
async function summarise(folder, manifest) {
  const derived = manifest.derived ?? {};
  const passageIndex = (await readJson(join(folder, derived.passageIndex ?? 'passage-index.json'))) ?? {};
  const works = manifest.works ?? [];
  const quotes = manifest.kind === 'quotes';
  return {
    id: manifest.id,
    path: `${manifest.id}/manifest.json`,
    name: manifest.name,
    kind: quotes ? 'quotes' : 'books',
    language: manifest.language ?? null,
    version: manifest.version ?? null,
    ...(Number.isSafeInteger(manifest.revision) && manifest.revision >= 0 ? { revision: manifest.revision } : {}),
    ...(typeof manifest.changes === 'string' && manifest.changes ? { changes: manifest.changes } : {}),
    licence: manifest.licence ?? null,
    authors: unique(works.map((work) => work.author)),
    titles: quotes ? [] : works.map((work) => work.title),
    works: quotes ? 0 : works.length,
    quotes: quotes ? manifest.quoteCount ?? 0 : 0,
    passages: sum(Object.values(passageIndex).map((counts) => sum(Object.values(counts)))),
    bytes: sum(await Promise.all(['manifest.json', derived.passageIndex, derived.frequencies, ...works.map((work) => work.passages)].filter(Boolean).map((file) => size(join(folder, file))))),
    textBytes: sum(await Promise.all(works.map((work) => size(join(folder, work.file)))))
  };
}

export async function checkDataset(id, folder, manifest, { fail, notes }) {
  const where = id;
  if (manifest.kalibreDataset !== 1) fail(where, 'manifest is not a Kalibre dataset (kalibreDataset: 1)');
  if (manifest.id !== id) fail(where, `manifest id is "${manifest.id}", not the folder's`);
  if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 1) fail(where, 'revision must be a whole number from 1');
  if (typeof manifest.version !== 'string' || !manifest.version) fail(where, 'version is missing');
  if (manifest.changes !== undefined && (typeof manifest.changes !== 'string' || !manifest.changes.trim() || manifest.changes.length > 200 || /[\r\n]/.test(manifest.changes))) {
    fail(where, 'changes must be one line of at most 200 characters');
  }

  // D389: Reject Wikipedia datasets from Main Library
  if (manifest.source?.type === 'wikipedia' || PROHIBITED_SOURCE_TYPES.includes(manifest.source?.type)) {
    fail(where, 'Kalibre Main Library prohibits Wikipedia datasets (decision D389); full books, essays, and standalone quotes only');
  }

  // Language code validation and directory suffix agreement
  if (!manifest.language || typeof manifest.language !== 'string' || !isValidLanguageCode(manifest.language)) {
    fail(where, `manifest declares invalid or missing language code: "${manifest.language}"`);
  } else {
    const lang = manifest.language.toLowerCase();
    const suffix = extractLanguageFromId(id);
    if (!suffix) {
      fail(where, `dataset directory "${id}" lacks a language suffix (e.g. "-${lang}")`);
    } else if (suffix !== lang) {
      fail(where, `dataset directory suffix "-${suffix}" does not match manifest language "${lang}"`);
    }
  }

  if ((manifest.derived?.normaliserVersion ?? 0) < NORMALISER) {
    notes.push(`${where}: built by normaliser v${manifest.derived?.normaliserVersion ?? 0}, current is v${NORMALISER}; rebuild it with the librarian to republish`);
  }

  const onDisk = (await walk(folder)).filter((path) => path !== 'manifest.json');
  const listed = manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files) ? Object.keys(manifest.files).sort() : null;
  if (!listed) {
    fail(where, 'manifest has no `files` list of checksums');
  } else {
    for (const path of listed) {
      if (!onDisk.includes(path)) fail(where, `${path} is listed but missing`);
      else if (sha256(await readFile(join(folder, path), 'utf8')) !== manifest.files[path]) fail(where, `${path} doesn't match its checksum`);
    }
    for (const path of onDisk) if (!listed.includes(path)) fail(where, `${path} is in the folder but not in \`files\``);
  }

  if (manifest.kind === 'quotes') return;
  const derived = manifest.derived ?? {};
  const normaliserVersion = Number.isSafeInteger(derived.normaliserVersion) ? derived.normaliserVersion : 0;
  const hasRecordedCap = Object.hasOwn(derived, 'maxPerCategory');
  const recordedCap = derived.maxPerCategory;
  if (hasRecordedCap && recordedCap !== null && (!Number.isSafeInteger(recordedCap) || recordedCap < 0)) {
    fail(where, 'derived.maxPerCategory must be a non-negative whole number or null');
  }
  const legacyCap = hasRecordedCap ? recordedCap : DEFAULT_CAP;
  const passageIndex = (await readJson(join(folder, manifest.derived?.passageIndex ?? 'passage-index.json'))) ?? {};
  for (const work of manifest.works ?? []) {
    const text = await readFile(join(folder, work.file), 'utf8').catch(() => null);
    if (text === null) fail(where, `${work.file} is missing`);
    else if (sha256(text.replace(/\n$/, '')) !== work.sha256) fail(where, `${work.file} doesn't match its own sha256`);
    const wordCount = Number.isSafeInteger(work.wordCount) && work.wordCount >= 0
      ? work.wordCount
      : (text?.trim() ? text.trim().split(/\s+/).length : 0);
    const counts = passageIndex[work.id];
    if (!counts) { fail(where, `${work.id} is not in the passage index`); continue; }
    for (const category of CATEGORIES) {
      let cap = legacyCap;
      if (normaliserVersion >= 4) {
        cap = recordedCap === null
          ? null
          : adaptiveBudget(wordCount, category, Boolean(derived.flowPass), typeof recordedCap === 'number' ? recordedCap : null);
      }
      if (cap !== null && (counts[category] ?? 0) > cap) {
        fail(where, `${work.id} has ${counts[category]} ${category} passages; the ${normaliserVersion >= 4 ? 'v4 adaptive budget' : 'cap'} is ${cap}`);
      }
    }
    const passages = await readJson(join(folder, work.passages));
    const found = Array.isArray(passages) ? passages.length : -1;
    if (found !== sum(Object.values(counts))) fail(where, `${work.passages} has ${found} passages; the passage index says ${sum(Object.values(counts))}`);
  }
}

function git(rootDir, ...args) {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Against the base ref: changed files need a higher revision (and one never goes down).
async function checkAgainst(rootDir, base, manifests, { fail, notes }) {
  try {
    git(rootDir, 'rev-parse', '--verify', `${base}^{commit}`);
  } catch {
    notes.push(`base ${base} isn't available here, so revisions weren't compared`);
    return;
  }
  for (const manifest of manifests) {
    const id = manifest.id;
    let before = null;
    try { before = JSON.parse(git(rootDir, 'show', `${base}:${id}/manifest.json`)); } catch { continue; }
    const baseRevision = Number.isSafeInteger(before.revision) ? before.revision : 0;
    const names = (ref) => git(rootDir, 'ls-tree', '-r', '--name-only', ref, '--', `${id}/`).split('\n').filter(Boolean).map((path) => path.slice(id.length + 1)).filter((path) => path !== 'manifest.json');
    const was = names(base);
    const now = (await walk(join(rootDir, id))).filter((path) => path !== 'manifest.json');
    let changed = was.length !== now.length || was.some((path, index) => path !== now[index]);
    for (const path of now) {
      if (changed) break;
      if (git(rootDir, 'rev-parse', `${base}:${id}/${path}`).trim() !== git(rootDir, 'hash-object', join(id, path)).trim()) changed = true;
    }
    if (!Number.isSafeInteger(manifest.revision)) continue;
    if (manifest.revision < baseRevision) fail(id, `revision went down, from ${baseRevision} to ${manifest.revision}`);
    else if (changed && manifest.revision <= baseRevision) fail(id, `files changed but revision is still ${manifest.revision}; rebuild it with the librarian so it takes the next one`);
  }
}

export async function checkLibrary(rootDir = ROOT, { base = null } = {}) {
  const problems = [];
  const notes = [];
  const fail = (where, message) => problems.push(`${where}: ${message}`);

  const folders = (await readdir(rootDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'scripts' && entry.name !== 'node_modules')
    .map((entry) => entry.name)
    .sort();

  const manifests = [];
  for (const id of folders) {
    const manifest = await readJson(join(rootDir, id, 'manifest.json'));
    if (!manifest) { fail(id, 'folder has no manifest.json'); continue; }
    manifests.push(manifest);
    await checkDataset(id, join(rootDir, id), manifest, { fail, notes });
  }

  // Validate single library language across all datasets
  const libraryLanguages = new Set(manifests.map((m) => m.language?.toLowerCase()).filter(Boolean));
  if (libraryLanguages.size > 1) {
    fail('library', `Kalibre Main Library must contain exactly one language across all datasets; found: ${[...libraryLanguages].sort().join(', ')}`);
  }

  const about = await readJson(join(rootDir, 'library.json'));
  if (about?.language && !isValidLanguageCode(about.language)) {
    fail('library.json', `language "${about.language}" is not a valid language code`);
  }
  if (about?.language) {
    const declared = about.language.toLowerCase();
    for (const manifest of manifests) {
      if (manifest.language && manifest.language.toLowerCase() !== declared) {
        fail(manifest.id, `dataset language "${manifest.language}" does not match library.json language "${declared}"`);
      }
    }
  }

  const latestDatasetDate = manifests.map((manifest) => manifest.version).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')).sort().at(-1);
  const libraryLanguage = resolveLibraryLanguage(about, manifests);
  const libraryBlock = about?.name
    ? { name: about.name, description: about.description ?? '', ...(libraryLanguage ? { language: libraryLanguage } : {}) }
    : libraryLanguage ? { language: libraryLanguage } : null;
  const expected = {
    kalibreDatasetIndex: 1,
    ...(about?.updatedAt ? { updatedAt: about.updatedAt } : latestDatasetDate ? { updatedAt: latestDatasetDate } : {}),
    ...(libraryBlock ? { library: libraryBlock } : {}),
    datasets: await Promise.all(manifests.filter((manifest) => manifest.id).map((manifest) => summarise(join(rootDir, manifest.id), manifest)))
  };
  const index = await readJson(join(rootDir, 'index.json'));
  if (index && JSON.stringify(index) !== JSON.stringify(expected)) {
    fail('index.json', "isn't what the dataset folders say; regenerate it with the librarian, never by hand");
  }

  if (base) await checkAgainst(rootDir, base, manifests, { fail, notes });

  return { problems, notes, checkedCount: manifests.length };
}

async function main() {
  const flag = process.argv.indexOf('--base');
  const base = flag > -1 ? process.argv[flag + 1] : null;
  const result = await checkLibrary(ROOT, { base });

  for (const note of result.notes) console.log(`note: ${note}`);
  if (result.problems.length) {
    for (const problem of result.problems) console.error(`error: ${problem}`);
    console.error(`\n${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}.`);
    process.exit(1);
  }
  console.log(`${result.checkedCount} dataset${result.checkedCount === 1 ? '' : 's'} checked${base ? `, revisions compared with ${base}` : ''}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(error.message); process.exit(2); });
}
