# ADR-002 — Publishing: one public repo, a neutral public build

- **Status:** Accepted. Implemented by P4.1 (repo hygiene and attribution).
- **Date:** 2026-11-11
- **Deciders:** the project owner
- **Closes:** blueprint [§5](./VELO-V2-BLUEPRINT.md#5-open-questions-for-the-owner-answer-before-p15--p41) question 1 and the P4.1 decision line

## Context

Velo started as a private fork that one household rode at home. The blueprint
left one publishing question open: keep the code where it is, or move it to a
new organisation before the first release. The release also has to stop
exposing the household (rider names, which places are "home", internal host
names and agent paths in comments) without breaking the household's own
deploy.

## Decision

1. **The release lives at [github.com/Custodia-Admin/velo](https://github.com/Custodia-Admin/velo).**
   `Custodia-Admin` is the owner's personal GitHub account (a User account,
   not an organisation). The repo is already public, MIT-licensed and a GitHub
   fork of [masonwyatt23/globeride](https://github.com/masonwyatt23/globeride).
   Nothing is transferred and no new repo or organisation is created.
2. **Licence and credit.** MIT with both copyright lines: GlobeRide's and
   Velo's. GlobeRide is credited in the README's
   first paragraph, `LICENSE`, `NOTICE.md`, `package.json` (`contributors`)
   and the app footer (UI-RULES §6). Data credits live in `NOTICE.md` and
   [`docs/worlds/CREDITS.md`](../worlds/CREDITS.md).
3. **The public build is neutral.**
   - The two riders start as "Rider 1" and "Rider 2". People rename them on
     first run; names and profiles stay in the browser's own storage.
   - Perugia and Lugano are the featured worlds. Home titles their sections
     with the place name only.
   - A private deploy can label them "Home · Perugia" and "Hometown · Lugano"
     by building with `VITE_HOUSEHOLD_LABELS=1` (see `.env.example`). Only the
     household's own build sets it; CI and the public build never do.
4. **No internal details in tracked files.** No private host names, tailnet
   names, home-directory paths or agent handoff paths. Measurement notes say
   "the test host" or "the bake host".
5. **CI proves a stranger can run it.** The `fresh-clone` job clones the
   commit from GitHub and runs `npm ci`, `npm run check`, `npm run build` and
   a token-free smoke ride with no env file. The `bake-validate` workflow
   checks the world tools and every shipped bundle whenever the bake changes.

## Secret audit (2026-11-11, before the first release)

The whole history (`git log --all -p`, 943 commits) was searched. Results:

| Search | Result |
| --- | --- |
| JWT-shaped strings (`eyJhbGciOi…`, `eyJ0eXAiOi…`) | 9 hits, all placeholders inherited from upstream: `eyJhbGciOi...` input placeholders and docs examples (10–13 characters) and one redacted test stub in `cf2251b` (42 characters, 2 segments). A real Cesium ion token is about 300 characters with 3 segments. |
| Three-segment JWTs (`eyJ…​.…​.…`) | none |
| Cloud and service keys (`AKIA`/`ASIA`, `sk-`, `ghp_`/`github_pat_`, `xai-`, `AIza`, `xox?-`, `tskey-`) | none |
| Private keys (`BEGIN … PRIVATE KEY`) | none |
| `client_secret` / `secret_access_key` / `api_key` / `access_token` assignments with a value | none |
| The owner's live Cesium ion token (compared against the local env file without printing it) | never committed |
| Env files ever added | only `.env.example` and `.env.local.example` (templates without values) |
| `scripts/vercel-env-push.sh` (upstream) | reads the gitignored `.env.local` by relative path; no values and no absolute paths in any revision |

Nothing needs rotating. History is not rewritten: there is nothing to remove,
and rewriting a public fork would not take anything back from existing clones.

## Consequences

- Strangers get a working, token-free app from a clean clone, and CI fails if
  that stops being true.
- The household keeps its labels through one build variable; rider names
  that are already saved in its browsers stay as they are. A browser that
  never saved a roster starts at "Rider 1"/"Rider 2" and needs one rename.
- Some evidence documents no longer name the machine a number was measured
  on. The numbers and methods stay.
