#!/usr/bin/env node
// Checks this library before it is published, with Node alone (18 or later).
//
//   node scripts/check-library.mjs [--base <git ref>]
//
// Kalibre reads this repository's default branch directly, so whatever is
// merged is what people download. The checks:
//   - every dataset folder has a manifest of the right shape, and its id is the folder's;
//   - `files` in the manifest lists a SHA-256 for every file but the manifest, matching
//     what is on disk, with nothing extra left in the folder; each text matches its own `sha256`;
//   - passage counts match the passage files, and no text has more passages per length
//     than the dataset's recorded cap (300 when none is recorded);
//   - `index.json` is exactly what the folders say (it is never edited by hand);
//   - with --base: a dataset whose files differ from the base ref's has a higher `revision`,
//     and a revision never goes down.
// A dataset built by an older normaliser than NORMALISER is reported, not failed.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NORMALISER = 3;
const DEFAULT_CAP = 300;
const CATEGORIES = ['short', 'medium', 'long', 'huge', 'massive'];
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const problems = [];
const notes = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

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
const sum = (values) => values.reduce((total, value) => total + value, 0);
const size = async (path) => { try { return (await stat(path)).size; } catch { return 0; } };

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

async function checkDataset(id, folder, manifest) {
  const where = id;
  if (manifest.kalibreDataset !== 1) fail(where, 'manifest is not a Kalibre dataset (kalibreDataset: 1)');
  if (manifest.id !== id) fail(where, `manifest id is "${manifest.id}", not the folder's`);
  if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 1) fail(where, 'revision must be a whole number from 1');
  if (typeof manifest.version !== 'string' || !manifest.version) fail(where, 'version is missing');
  if (manifest.changes !== undefined && (typeof manifest.changes !== 'string' || !manifest.changes.trim() || manifest.changes.length > 200 || /[\r\n]/.test(manifest.changes))) {
    fail(where, 'changes must be one line of at most 200 characters');
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
  const cap = manifest.derived?.maxPerCategory === undefined ? DEFAULT_CAP : manifest.derived.maxPerCategory;
  const passageIndex = (await readJson(join(folder, manifest.derived?.passageIndex ?? 'passage-index.json'))) ?? {};
  for (const work of manifest.works ?? []) {
    const text = await readFile(join(folder, work.file), 'utf8').catch(() => null);
    if (text === null) fail(where, `${work.file} is missing`);
    else if (sha256(text.replace(/\n$/, '')) !== work.sha256) fail(where, `${work.file} doesn't match its own sha256`);
    const counts = passageIndex[work.id];
    if (!counts) { fail(where, `${work.id} is not in the passage index`); continue; }
    for (const category of CATEGORIES) {
      if (cap !== null && (counts[category] ?? 0) > cap) fail(where, `${work.id} has ${counts[category]} ${category} passages; the cap is ${cap}`);
    }
    const passages = await readJson(join(folder, work.passages));
    const found = Array.isArray(passages) ? passages.length : -1;
    if (found !== sum(Object.values(counts))) fail(where, `${work.passages} has ${found} passages; the passage index says ${sum(Object.values(counts))}`);
  }
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Against the base ref: changed files need a higher revision (and one never goes down).
async function checkAgainst(base, manifests) {
  try {
    git('rev-parse', '--verify', `${base}^{commit}`);
  } catch {
    notes.push(`base ${base} isn't available here, so revisions weren't compared`);
    return;
  }
  for (const manifest of manifests) {
    const id = manifest.id;
    let before = null;
    try { before = JSON.parse(git('show', `${base}:${id}/manifest.json`)); } catch { continue; }
    const baseRevision = Number.isSafeInteger(before.revision) ? before.revision : 0;
    const names = (ref) => git('ls-tree', '-r', '--name-only', ref, '--', `${id}/`).split('\n').filter(Boolean).map((path) => path.slice(id.length + 1)).filter((path) => path !== 'manifest.json');
    const was = names(base);
    const now = (await walk(join(ROOT, id))).filter((path) => path !== 'manifest.json');
    let changed = was.length !== now.length || was.some((path, index) => path !== now[index]);
    for (const path of now) {
      if (changed) break;
      if (git('rev-parse', `${base}:${id}/${path}`).trim() !== git('hash-object', join(id, path)).trim()) changed = true;
    }
    if (!Number.isSafeInteger(manifest.revision)) continue;
    if (manifest.revision < baseRevision) fail(id, `revision went down, from ${baseRevision} to ${manifest.revision}`);
    else if (changed && manifest.revision <= baseRevision) fail(id, `files changed but revision is still ${manifest.revision}; rebuild it with the librarian so it takes the next one`);
  }
}

async function main() {
  const flag = process.argv.indexOf('--base');
  const base = flag > -1 ? process.argv[flag + 1] : null;
  const folders = (await readdir(ROOT, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'scripts' && entry.name !== 'node_modules').map((entry) => entry.name).sort();
  const manifests = [];
  for (const id of folders) {
    const manifest = await readJson(join(ROOT, id, 'manifest.json'));
    if (!manifest) { fail(id, 'folder has no manifest.json'); continue; }
    manifests.push(manifest);
    await checkDataset(id, join(ROOT, id), manifest);
  }

  const about = await readJson(join(ROOT, 'library.json'));
  const expected = {
    kalibreDatasetIndex: 1,
    ...(about?.name ? { library: { name: about.name, description: about.description ?? '' } } : {}),
    datasets: await Promise.all(manifests.filter((manifest) => manifest.id).map((manifest) => summarise(join(ROOT, manifest.id), manifest)))
  };
  const index = await readJson(join(ROOT, 'index.json'));
  if (JSON.stringify(index) !== JSON.stringify(expected)) fail('index.json', "isn't what the dataset folders say; regenerate it with the librarian, never by hand");

  if (base) await checkAgainst(base, manifests);

  for (const note of notes) console.log(`note: ${note}`);
  if (problems.length) {
    for (const problem of problems) console.error(`error: ${problem}`);
    console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
    process.exit(1);
  }
  console.log(`${manifests.length} dataset${manifests.length === 1 ? '' : 's'} checked${base ? `, revisions compared with ${base}` : ''}.`);
}

main().catch((error) => { console.error(error.message); process.exit(2); });
