# Run Velo locally

For the laptop next to the trainer. Takes about five minutes the first time.

## 1. Requirements

- Node 20 or newer (verified on Node 24) and npm.
- **Chrome or Edge** for riding. Web Bluetooth (the trainer link) only works
  there. Other browsers fall back to Demo Mode.

## 2. Install

```sh
git clone https://github.com/Custodia-Admin/velo.git
cd velo
npm install
```

## 3. Cesium ion token (Federico does this step)

The 3D globe streams terrain and imagery from Cesium ion. It needs a token from
your own free account. Agents must not create the account or the token.

1. Sign in or sign up at <https://ion.cesium.com/> (free personal tier, no card).
2. Open <https://ion.cesium.com/tokens> and click **Create token**. The default
   scopes are fine.
3. Copy the token, then:

   ```sh
   cp .env.local.example .env.local
   # edit .env.local and paste the token after VITE_CESIUM_ION_TOKEN=
   ```

`.env.local` is gitignored. Never commit it.

No token yet? Skip this step. Home still works and the ride screen asks for a
token in the browser and keeps it in `localStorage`.

## 4. Start

```sh
npm run dev
```

Open <http://localhost:5173/app> in Chrome.

On the TV or tablet, use the production build instead (installable PWA):

```sh
npm run build
npm run preview -- --host   # serves on http://<laptop-ip>:4173
```

Web Bluetooth needs a secure context: `localhost` is fine, a LAN IP is not. Pair
the trainer from the browser running on the laptop, or serve over HTTPS.

## 5. Pair the trainer and ride

1. Pick who's riding at the top of Home (Federico or the second rider; rename
   with the pencil).
2. Set **Hills feel** (35 % is easy, 100 % is the real road).
3. Under **Trainer**, press the pair button and choose the KICKR in Chrome's
   Bluetooth picker. Close Zwift and the Wahoo app first: the trainer accepts
   one controller at a time.
4. Press **Ride** on Today's ride or any Easy & Scenic route.

## Checks before pushing

```sh
npm run check   # typecheck + lint + unit tests (the Vercel gate)
npm run build
```

UI changes also follow `docs/design/UI-RULES.md`; render the before/after
screenshots with:

```sh
uv run --with playwright python scripts/ui-shots.py /tmp/velo-shots http://localhost:5173
```
