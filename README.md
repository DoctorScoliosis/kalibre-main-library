# Kalibre Main Library

Ready-made datasets for [Kalibre](https://github.com/DoctorScoliosis/kalibre-kanary), the adaptive typing trainer: public-domain books, cut into passages and word counts that Kalibre types from.

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

The tool writes the dataset's folder, `index.json` and `SOURCES.md`; commit and push them. Never edit `index.json` by hand: it's rewritten from the folders on every change. Bump a dataset's `version` (the tool does when it refetches) so Kalibre offers the update.

## The format

A library is a folder, anywhere on the web, holding:

- `index.json`: `{ "kalibreDatasetIndex": 1, "library": { "name", "description" }, "datasets": [ … ] }`, one summary per dataset (id, name, authors, titles, sizes, version).
- `library.json` (optional): `{ "name": "…", "description": "…" }`, the library's name, copied into the index.
- One folder per dataset: `manifest.json`, `passage-index.json`, `frequencies.json`, `passages/*.json` and `works/*.txt`.

Anyone can publish one the same way, and Kalibre can add it by `owner/repo`, a GitHub link or its web address.

## Licence

The texts come from [Project Gutenberg](https://www.gutenberg.org) and are in the public domain in the USA. Check the copyright laws of your country before redistributing them. The passages, word counts and indexes derived from them are released into the public domain too.
