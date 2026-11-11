# Contributing to Velo

Thanks for helping. Velo is a small project, so a short issue before a big
change saves everyone time.

## Ground rules

- **Local-first, no backend.** Rides, riders and settings stay in the browser
  (localStorage and IndexedDB). Don't add accounts, analytics or a server the
  app depends on. The network calls the app makes are listed in
  [docs/worlds/CREDITS.md](docs/worlds/CREDITS.md#services-the-app-calls-at-ride-time);
  a new one needs a reason in the pull request and an entry there.
- **No token needed.** Every feature has to work without a Cesium ion token,
  an AI key or any other credential. Optional services stay optional.
- **Always keep the no-Bluetooth path.** Safari, Firefox and iOS have no Web
  Bluetooth; the demo rider has to keep working there. Detect a capability
  before showing UI that needs it, and never ask for a permission on page load.
- **One trainer controller at a time.** Changes to the trainer, controller or
  gear code (`src/lib/ftms*`, `src/lib/controllers/`, virtual gears) need a test
  on real hardware described in the pull request.
- **Credit the data.** A new data source goes in [NOTICE.md](NOTICE.md) and
  [docs/worlds/CREDITS.md](docs/worlds/CREDITS.md) with its licence.

## UI changes

Read [docs/design/UI-RULES.md](docs/design/UI-RULES.md) before touching the
interface: tokens and shared components only (no raw colours or pixel
values), the copy rules in §6, and the review rubric in §9. Attach screenshots
at 1440 px and 390 px wide to the pull request. `src/test/uiRules.test.ts`
checks the mechanical rules.

## Worlds

To add a place, follow [docs/worlds/ADDING-A-WORLD.md](docs/worlds/ADDING-A-WORLD.md).
Commit the recipe with the bundle, and run
`node tools/worldbake/checkBundles.mjs` and
`node tools/worldbake/syncDestinations.mjs --check` before you push. The
bake-validate workflow runs both on any pull request that touches the bake.

## Before you push

```bash
npm run check    # typecheck + lint + unit tests (what CI and Vercel gate on)
npm run build    # the static build
```

Run the end-to-end test closest to your change locally
(`npx playwright test e2e/<spec> --project=chromium`); CI runs the full set.

## Pull requests

- One change per pull request, with a short description of what changed and
  how you checked it (tests, screenshots, the device you rode on).
- Keep commits focused; don't mix formatting churn with behaviour changes.
- No comments that only make sense today ("added in wave 3", "TODO for
  Tuesday"). Explain why the code is the way it is.
- Never commit `.env.local`, keys or tokens. `.env.example` lists every
  variable.

## Reporting a security problem

Don't open a public issue. Use GitHub's private reporting on this repository
(**Security → Report a vulnerability**).

## Licence

By contributing you agree that your contribution is licensed under the
project's [MIT licence](LICENSE). Velo is a fork of
[GlobeRide](https://github.com/masonwyatt23/globeride); keep its credit intact.
