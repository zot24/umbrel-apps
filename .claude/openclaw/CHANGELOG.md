# Changelog

## [4.0.0](https://github.com/zot24/skills/compare/openclaw-v3.1.0...openclaw-v4.0.0) (2026-02-17)


### ⚠ BREAKING CHANGES

* Skill renamed from `clawdbot` to `openclaw` following the upstream project rename from Clawdbot to OpenClaw. Update your commands:
  - `/plugin install openclaw@zot24-skills`
  - `/openclaw setup` (was `/clawdbot setup`)
  - The `clawdbot` and `moltbot` CLI commands still work as backward-compatible aliases.

### Features

* **openclaw:** rename skill from clawdbot to openclaw ([#TBD](https://github.com/zot24/skills/issues/TBD))
* **openclaw:** add new channels: Google Chat, BlueBubbles, Matrix, Zalo
* **openclaw:** update all documentation URLs to docs.openclaw.ai
* **openclaw:** update install method to `npm install -g openclaw@latest`

## [3.1.0](https://github.com/zot24/skills/compare/clawdbot-v3.0.0...clawdbot-v3.1.0) (2026-01-18)


### Features

* **clawdbot:** add MCP server support via MCPorter ([536d015](https://github.com/zot24/skills/commit/536d0159e8953bdcbd4348a932d39b4b7d8d1e67))

## [3.0.0](https://github.com/zot24/skills/compare/clawdbot-v2.1.0...clawdbot-v3.0.0) (2026-01-18)


### ⚠ BREAKING CHANGES

* Repository renamed from zot24/claude-plugins to zot24/skills. Update your marketplace commands:   /plugin marketplace add zot24/skills   /plugin install <skill>@zot24-skills

### refactor

* rename repository from claude-plugins to skills ([a29abcc](https://github.com/zot24/skills/commit/a29abccc4168211988feaf2c4f8405d9eda58217))

## [2.1.0](https://github.com/zot24/claude-plugins/compare/clawdbot-v2.0.0...clawdbot-v2.1.0) (2026-01-15)


### Features

* **clawdbot:** add Clawdbot AI assistant framework plugin ([#1](https://github.com/zot24/claude-plugins/issues/1)) ([b43b767](https://github.com/zot24/claude-plugins/commit/b43b767b7d073fa88c3e295ec96787cbc622375b))
* **clawdbot:** expand to complete documentation with 12 specialized skills ([3a28c44](https://github.com/zot24/claude-plugins/commit/3a28c441bf60811ef22ecfec0e38fc3b32a40a38))


### Documentation

* update marketplace name references and fix clawdbot plugin.json ([0946ef8](https://github.com/zot24/claude-plugins/commit/0946ef8eca720fbd170d3255a3fdfc7964b25c38))
