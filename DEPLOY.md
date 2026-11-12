# Deploying Velo

Velo is a static site: `npm run build` writes everything to `dist/`, and the
app runs in the browser. There is no server and no database. Remote worlds
come from a public R2 bucket at ride time, so a deploy never uploads them.

## The public site (Cloudflare Pages)

**https://velo-trainer.pages.dev** is the public build: Cloudflare Pages
project `velo-trainer`, free tier, no custom domain.

It is always the **public configuration**:

- no env file and no `VITE_` variables, so no Cesium ion token is baked in
  (the 3D worlds need none; a rider can still add their own token in
  Settings for the photoreal view);
- neutral destination titles ("Perugia", "Lugano") and seed riders
  "Rider 1" and "Rider 2" ([ADR-002](docs/architecture/ADR-002-publishing.md)).

`scripts/pages-dist.mjs` refuses any other build. It fails if the repo root
has an env file other than the examples, if a `VITE_*TOKEN/KEY/SECRET` or
`VITE_HOUSEHOLD_LABELS` is set, or if the bundle carries household labels.
It then writes `dist/_headers` from `vercel.json`'s headers, so Pages sends
the same Content Security Policy and caching. Pages serves `index.html` for
any unknown path on its own (there's no `404.html`), which is what the
single-page app needs.

### Releases deploy from a tag

`.github/workflows/deploy-pages.yml` runs on every `v*` tag, and by hand from
the Actions tab (**Deploy (Cloudflare Pages)** → **Run workflow**, on a tag or
branch). It:

1. runs the same gate as CI on main (`npm run check` with the remote worlds
   fetched);
2. builds, checks the bundle budget and runs `scripts/pages-dist.mjs`;
3. uploads `dist/` with `wrangler pages deploy` to the production branch;
4. waits until the site serves the new `index-*.js`;
5. rides the live site in a fresh browser: the Perugia smoke ride, token-free,
   and Chengdu downloaded from the bucket, then ridden again offline.

Main itself doesn't deploy: it changes several times a day, and the public
site follows releases.

To cut a release:

```bash
# CHANGELOG.md has the new version's section, package.json its version
git tag -a v2.1.0 -m "Velo 2.1.0"
git push origin v2.1.0
gh release create v2.1.0 --verify-tag --notes-file <notes.md>
```

The workflow needs two repository secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that owns the Pages project |
| `CLOUDFLARE_API_TOKEN` | An API token with **Account → Cloudflare Pages → Edit** on that account, nothing else |

A fork that wants its own site creates its own Pages project
(`npx wrangler pages project create <name> --production-branch main`), sets
the repository variable `CF_PAGES_PROJECT` to its name, and adds the two
secrets. Without the variable the workflow runs only on `Custodia-Admin/velo`.

### Deploying by hand

From a clean checkout (no env file in the root):

```bash
npm ci
npm run build
node scripts/pages-dist.mjs
npx wrangler login            # once
npx wrangler pages deploy dist --project-name velo-trainer --branch main
```

### Verify a release

The live checks the workflow runs work from any machine:

```bash
VELO_BASE_URL=https://velo-trainer.pages.dev \
  npx playwright test e2e/smoke-ride.spec.ts e2e/remote-world.spec.ts \
  --project=chromium --grep "token-free smoke ride|chengdu-luxelakes"
```

Each test opens a fresh browser context, with no storage, caches or service
worker, like a first visit. Software WebGL is slow; on a machine with a GPU,
`PW_GL_ARGS="--use-angle=vulkan --enable-features=Vulkan --enable-gpu --ignore-gpu-blocklist"`
makes the Perugia ride take seconds instead of minutes.

## Your own copy

Any static host works, as long as it serves `index.html` for unknown paths
(`/app`, `/ride` and `/devices` are client-side routes) and doesn't cache
`sw.js`. Point `VITE_WORLDS_REMOTE_URL` at your own mirror of the worlds if you
don't want to use the project's bucket ([ADDING-A-WORLD.md](docs/worlds/ADDING-A-WORLD.md),
"Hosting"). Settings for a private deploy, such as the household destination
titles, go in `.env.production.local` ([`.env.example`](.env.example)).

`vercel.json` describes a Vercel deploy: the same routing and headers, plus
the `/xai` proxy (`api/xai.ts`) for the optional AI commentary inherited from
GlobeRide. The Pages site has no `/xai` proxy, so that commentary isn't
available there.
