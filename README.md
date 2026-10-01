# Kalibre Main Library

Ready-made datasets for [Kalibre](https://github.com/DoctorScoliosis/kalibre), the adaptive typing trainer: public-domain books, cut into passages and word counts that Kalibre types from.

Kalibre itself only ships a small starter. Everything else lives here, so a clone of Kalibre stays small and the website only downloads what someone asks for.

## Using it

- **In Kalibre:** texts → datasets → *find more in the library*. Search by title, author or language, then download. The dataset is kept in your browser and works offline, and a newer version here shows as *update*.
- **On your own copy of Kalibre** (so every browser using it, a LAN host included, gets the dataset without downloading it):

  ```sh
  npm run datasets -- library                      # what's here
  npm run datasets -- fetch henry-james-en         # into src/assets/static/datasets/
  ```

  Every text is checked against the checksum in its manifest.

## What's here

See [`SOURCES.md`](SOURCES.md) for every work, with its author and where it came from, and `index.json` for a summary of each dataset.

## Adding a dataset

Clone this repository beside Kalibre and point Kalibre's dataset tool at it:

```sh
cd kalibre
npm run datasets -- create gutenberg 1260 1400 --id my-books-en --name "My books" --out ../kalibre-main-library
npm run datasets -- append my-books-en gutenberg 766 --out ../kalibre-main-library
```

The tool writes the dataset's folder, `index.json` and `SOURCES.md`; commit and push them. Never edit `index.json` by hand: it's rewritten from the folders on every change. The tool settles each dataset's `version` and `revision` itself (see below), so Kalibre offers the update.

## Publishing a change

Kalibre reads this repository's default branch directly, so a merge is a publication.

1. Change a dataset only with the librarian (`dataset-library create`, `append`, `rebuild`, `drop`), never by editing files. It leaves a dataset that hasn't changed alone, and gives one that has the next `revision`, today's `version` and a list of checksums. Add `--changes "one line"` to say what changed, 200 characters at most; Kalibre shows it under the update.
2. Open a pull request. The **check** workflow (`scripts/check-library.mjs`, Node alone) fails it if a file doesn't match its checksum or sits outside the list, if a text doesn't match its own checksum, if passage counts disagree with the passage files or a text has more passages per length than the dataset's cap, if `index.json` isn't what the folders say, or if files changed without a higher `revision`. It also notes any dataset built by an older normaliser than the current one, which is republished by rebuilding it.
3. Merge once **check** passes. Make it a required status check on the default branch in the repository's settings.

Run it yourself before pushing: `node scripts/check-library.mjs --base origin/master`.

People see a dataset as an update when its `revision` is higher than theirs, and never when it is lower, so a rollback is published by rebuilding (a new, higher revision with the older content), never by reverting the files.

## The format

A library is a folder, anywhere on the web, holding:

- `index.json`: `{ "kalibreDatasetIndex": 1, "library": { "name", "description" }, "datasets": [ … ] }`, one summary per dataset (id, name, authors, titles, sizes, version, revision, changes).
- `library.json` (optional): `{ "name": "…", "description": "…" }`, the library's name, copied into the index.
- One folder per dataset: `manifest.json`, `passage-index.json`, `frequencies.json`, `passages/*.json` and `works/*.txt`.
- In each manifest: `version` (the date people read), `revision` (a whole number that only goes up, which is what Kalibre compares), an optional one-line `changes`, and `files`, the SHA-256 of every file but the manifest, which Kalibre checks before saving a download.

Anyone can publish one the same way, and Kalibre can add it by `owner/repo`, a GitHub link or its web address.

## Licence

The texts come from [Project Gutenberg](https://www.gutenberg.org) and are in the public domain in the USA. Check the copyright laws of your country before redistributing them. The passages, word counts and indexes derived from them are released into the public domain too.
