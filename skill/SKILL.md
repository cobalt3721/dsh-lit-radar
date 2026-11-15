---
name: lit-radar
description: Search recent literature by keyword across Crossref, OpenAlex, and arXiv and report only the papers not delivered before. Use when the user asks for new papers, a literature digest, a daily literature watch, or "what came out on X lately".
whenToUse: The user wants recent publications on a topic rather than a known-paper lookup or a general web search.
---

# Literature radar

A small CLI that turns keywords into a scan of Crossref, OpenAlex, and arXiv, then prints only the
papers that were not returned by an earlier scan. State lives in `~/.dsh/lit-radar/state.json`, shared
with the `dsh-lit-radar` DSH plugin, so a scan from chat and a scan from a shell drain the same history.

## Run it

```sh
npx -y dsh-lit-radar --keywords "topic=query;topic=query" --days 14 --limit 20
```

If the package is not published or offline, run the checkout instead:

```sh
node path/to/dsh-lit-radar/cli.mjs --keywords "topic=query" --days 14 --limit 20
```

Use `--json` when you want to post-process the items yourself instead of printing the digest:

```sh
npx -y dsh-lit-radar --keywords-file keywords.json --days 30 --limit 50 --json
```

`--json` prints `{ windowDays, fromDate, scannedAt, matched, fresh, withheld, errors, bySource, items }`,
where each item carries `title`, `venue`, `date`, `doi`, `url`, `abstract`, `authors`, `kind`, `keyword`.

## Before the first scan: get keywords

There are no default keywords — a radar is only useful with terms that match the user's own field.
Ask for their topics and turn each into `topic=query`:

- `topic` is a short label in the user's own language; it is what they see in the digest.
- `query` is the English phrase sent to the databases. Search matches words inside titles and
  abstracts, so two to four content words work best (`methane pyrolysis`, not `research on methane`).

Save them with `--keywords-file` (a JSON array of `{ "topic", "query" }`, see
`examples/keywords.methane-catalysis.json`) or inline `--keywords "甲烷裂解=methane pyrolysis"`.
Saving is idempotent: the last saved list wins.

## After a scan

- Every item printed is marked delivered, so a second scan in the same window returns only what is
  left. That is intentional; do not clear the history to "see everything again".
- `N more new items beyond limit=…` means the window holds more than one digest prints. Raise
  `--limit` or run again next time; nothing is lost.
- When a line under `Sources that failed` names OpenAlex with `429`, the anonymous daily budget for
  this egress IP is spent. Crossref and arXiv results are still valid. Suggest `--mailto <email>` or
  `--openalex-key <key>` to remove the limit.

## Then write the brief

Summarize in the user's language: what each paper did, why it matters for their topic, and whether it
is worth reading in full. Group by keyword when the list is long, drop items that are off-topic
(abstract-level word matches do let adjacent fields through), and never invent a finding that the
abstract excerpt does not state.

## Useful flags

| Flag | Meaning |
|---|---|
| `--days <n>` | lookback window, 1–90 (default 7) |
| `--limit <n>` | maximum items printed, 1–60 (default 25) |
| `--sources <list>` | `crossref,openalex,arxiv` subset |
| `--state <dir>` | alternate state directory |
| `--status` | counters, active keywords, last scan |
| `--list-keywords` | current keyword list |
| `--reset --yes` | erase the delivered history |
