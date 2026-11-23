# mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Gordon809/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Gordon809/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls — to a tree of text files. It finds the lines an edit names at the first of three matching tiers, tolerating drifted whitespace and indentation, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]` — Node 22, standard library only. The patch is read from `PATCH`, or from standard input when it is absent or `-`. See `SPEC.md` in the kit for the full contract (the specification ships with the competition kit, not this repository).

---

<sub>Entered on [make.fun](https://make.fun/?ref=5g7k5t7n&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
