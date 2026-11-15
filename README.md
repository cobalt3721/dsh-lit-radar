# dsh-lit-radar

A literature radar for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **and** the command line:
give it your research keywords, and it tells you which papers came out in the last few days — only the ones
it has not already told you about.

Two problems it solves that a plain search box does not:

- **It remembers what it delivered.** Every returned item is recorded, so tomorrow's scan reports only
  what is genuinely new instead of the same list again. Set it on a timer and it becomes a daily digest.
- **It filters hard.** Only journal articles, preprints, reviews, and proceedings inside the date
  window; multi-word keywords are ANDed and re-checked against title/abstract, so `methane pyrolysis`
  does not drag in every paper that happens to contain "pyrolysis".

Sources are [Crossref](https://api.crossref.org), [OpenAlex](https://api.openalex.org), and
[arXiv](https://export.arxiv.org/api/query). All three are public, and no API key is required.

## Install

**1. As a DSH plugin** (gives the agent a `lit_radar` tool)

```sh
git clone https://github.com/cobalt3721/dsh-lit-radar.git
```

Then in DSH open **Plugins → Add plugin** and point it at the cloned directory, or let the agent run
`plugin_manager` with `install_bundle` on that path. The plugin appears in **Settings → Plugins** with
its own icon, title, and description.

**2. As a CLI** (any terminal, no DSH)

```sh
npx -y dsh-lit-radar --help
```

**3. As a DSH skill** (instructions the agent reads on demand, no plugin install)

Copy [`skill/SKILL.md`](skill/SKILL.md) to `.dsh/skills/lit-radar/SKILL.md` in your project (or
`~/.dsh/skills/lit-radar/SKILL.md` for every project). The skill shells out to the CLI, so it needs
option 2 to work.

**4. From a DSH plugin index** (the Discover tab)

This repository publishes a [plugin-market index](market-index.json):

```
https://raw.githubusercontent.com/cobalt3721/dsh-lit-radar/main/market-index.json
```

Enable the experimental plugin-market bundle, add that URL in **Discover** (or Settings), then search
for "literature radar". The entry pins a commit instead of a tag, so an install gets exactly the tree
the index was validated against; to release, bump `version` and `publishTimestamp` in `market-index.json`
and repin the commit.

## Quick start

There are no default keywords — a radar is only useful with terms from your own field.

```sh
# inline: topic=query, separated by ;
lit-radar --keywords "methane pyrolysis;Fischer-Tropsch synthesis" --days 14

# or from a JSON file
lit-radar --keywords-file examples/keywords.methane-catalysis.json --limit 40
```

The keyword list is saved, so later scans only need the flags you want to change:

```sh
lit-radar --days 3 --limit 10
```

In DSH you do not type commands; ask in chat — "what came out on methane pyrolysis this week?" — and the
agent calls `lit_radar` with the keywords it collected from you.

## Output

```
lit-radar · last 7 days (from 2026-11-09) · 2026-11-16 00:11
41 matched · 22 new · returning 22

[1] Control of Metal–Support Interactions for Photocatalyst in Methane Conversion
    venue: ChemSusChem · 2026-11-14 · journal-article
    keyword: 甲烷催化转化
    authors: Cheng Guo, Yingjie Hu, Jianhui Li, et al.
    doi: 10.1002/cssc.71214
    abstract: Methane (CH4) in natural gas, shale gas, and hydrates represents an abundant ...
```

`--json` prints the same data as an object (`matched`, `fresh`, `withheld`, `errors`, `bySource`,
and `items[]` with `title` / `venue` / `date` / `doi` / `url` / `abstract` / `authors` / `kind` /
`keyword`), which is what the skill and any scripting should use.

## CLI reference

| Flag | Default | Meaning |
|---|---|---|
| `--keywords "t=q;t=q"` | — | set and save the keyword list (`topic=` is optional) |
| `--keywords-file <path>` | — | JSON array of `{ "topic", "query" }`, or `{ "keywords": [...] }` |
| `--days <n>` | 7 | lookback window, 1–90 |
| `--limit <n>` | 25 | maximum items printed per scan, 1–60 |
| `--per-keyword <n>` | 8 | OpenAlex records requested per keyword |
| `--sources <list>` | all three | `crossref,openalex,arxiv` subset |
| `--state <dir>` | `~/.dsh/lit-radar` | state directory |
| `--mailto <email>` | — | polite-pool contact; greatly reduces 429s |
| `--openalex-key <key>` | — | OpenAlex key; removes the shared anonymous budget |
| `--status` | | counters, active keywords, last scan |
| `--list-keywords` | | current keyword list |
| `--reset --yes` | | erase the delivered history |
| `--json` | | machine-readable output |

Exit codes: `0` success, `1` failure, `2` missing keywords or a refused destructive action.

## DSH tool reference

`lit_radar` takes `action` = `scan` (default) · `status` · `keywords` · `set_keywords` · `reset`,
plus `days`, `limit`, `keywords: [{ topic, query }]`, and `confirm` for `reset`.

The plugin's row `config` accepts the same settings as the CLI plus `stateDir`, `perKeyword`, and
`keywords` (a seed list, since a fresh install has none):

```yaml
- insert:
    - id: lit-radar
      name: 'dsh-lit-radar'
      config:
        days: 7
        limit: 25
        sources: [crossref, openalex, arxiv]
        mailto: you@example.com
        keywords:
          - { topic: 甲烷裂解, query: methane pyrolysis }
```

## How it decides what to show

1. **Crossref** (primary, per-client limits): relevance-ranked *inside* the date window — asking
   Crossref to sort by date instead throws the ranking away and returns unrelated newest work — then
   kept only when every query word appears in title/abstract, or when it ranks in the top three and
   carries at least half the words.
2. **OpenAlex**: `title_and_abstract.search` with a `type` and date filter. Unquoted, so several words
   are ANDed rather than matched as one literal phrase.
3. **arXiv**: one OR-ed query over all keywords, newest submissions first.
4. **Merge**: duplicates collapse on the normalized title, because one paper can carry several DOIs
   (an *Angewandte Chemie* article has both a German and an international-edition DOI). Missing
   abstracts, DOIs, or authors are filled in from whichever source has them.
5. **Deliver**: sorted newest first, cut at `--limit`, the rest waiting for the next scan.

## Limitations

- **OpenAlex's anonymous budget is shared per egress IP.** Burn through it and it answers `429` with a
  `retry-after` until the quota resets; those keywords return nothing that day and the digest says so.
  Crossref and arXiv keep working. Set `mailto` or `openalexKey` to avoid it.
- **Crossref has no title/abstract field search**, so its recall depends on abstracts being deposited;
  records without one are judged on the title alone.
- Coverage is those three indexes only — Web of Science or Scopus exclusives, and brand-new articles
  not yet indexed, can be missing.
- Keywords are matched as words, with no synonyms or stemming expansion: too many words is narrow, too
  few is noisy. `--status` plus a couple of scans is the fastest way to tune them.
- arXiv is sparse in most engineering fields; a 7-day window often returns nothing.
- Two concurrent scans race on the same state file: last writer wins, and a few items may be delivered
  twice or skipped.
- Abstracts are truncated to about 700 characters, and only the first three authors are kept.
- It writes no notes. The digest is text; saving it is the caller's job.

## Privacy and state

The tool only talks to the three APIs above, with a `User-Agent` of `dsh-lit-radar/<version>`. It reads
no local files. The only thing it stores is `state.json` in the state directory: the delivered titles,
the saved keyword list, and the last scan time. Delete that file (or run `--reset --yes`) to start over.

## Development

```sh
node test/scan.mjs --once --sources=crossref,arxiv   # real network, throws away its own state
```

`radar.js` holds the retrieval core with no DSH imports; `index.js` is the DSH tool wrapper;
`cli.mjs` is the command line. `skill/SKILL.md` is the skill wrapper.

## Publishing checklist

Before pushing to a repository or to npm:

1. Bump `version` and commit; the `repository`, `homepage`, and `author` fields are already filled in.
2. `npm pack --dry-run` to confirm the published file list (it is `files` plus README and LICENSE).
3. `npm publish` if you want the `npx -y dsh-lit-radar` and skill one-liners to work; otherwise tell
   users to run `node <checkout>/cli.mjs`.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文速览

给 DSH 和命令行用的文献雷达：输入你的研究关键词，它只告诉你**上次之后新出现**的论文。

**装法三选一**：① 克隆后 DSH 里「插件 → 添加插件」指向该目录，agent 就多出 `lit_radar` 工具；
② 直接 `npx -y dsh-lit-radar --keywords "甲烷裂解=methane pyrolysis"`；③ 把 `skill/SKILL.md` 拷到
`.dsh/skills/lit-radar/`，让 agent 按需读指令调 CLI。

**关键词**：topic 是你在日报里看到的标签（可用中文），query 是真正发给数据库的英文短语——两到四个实词最准。
关键词会存下来，之后 `lit-radar --days 30` 就够。

**为什么不是普通搜索**：交付过的条目会被记住，所以每天跑只看到新增；多词按 AND 匹配并在标题/摘要里复核，
不会因为出现 "pyrolysis" 就把所有热解论文都算成甲烷裂解；跨来源按标题归并，同一篇论文的德文版/国际版
两个 DOI 不会重复出现。

**已知坑**：OpenAlex 的匿名额度是按出口 IP 共享的，用尽当天会 429（Crossref 和 arXiv 仍可用），
填 `--mailto` 或 `--openalex-key` 可避开；Crossref 没有标题/摘要字段检索，召回受摘要是否收录影响。

状态只有 `~/.dsh/lit-radar/state.json` 一个文件，删了或 `--reset --yes` 就从头开始。
