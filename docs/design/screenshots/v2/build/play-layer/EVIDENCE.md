# P3.2 play layer: evidence

The scripts that produced these files are `scripts/v2-build-shots/play-layer.py` (the shots and `measurements.json`) and `scripts/play-layer-perf.py` (`perf.json`). Both ran against the dev server, with a fake KICKR at 142 W and no hardware.

The data is staged as follows:
- There are two riders: Federico (active) and Anna, who has her own colours.
- Anna has two rides stored on Tiber river park: her last ride (3 Nov, 36:40) and her best (28 Oct, 34:12). Each has real positions along the route and the ride clock.
- Play mode is on.

## Shots
Each shot exists at the four gate viewports: 1440, 1280×648@2 (owner laptop), 390@2 and TV.

- `play-setup-*`: Home → Build your own ride → step 3 "Who rides with you". It shows Anna's ghost (last ride / best ride / no ghost) above the pace partners, with The Diesel picked. Day and night.
- `play-setup-none-1440`: Anna has no ride on the route, so the step shows the one-line hint.
- `play-ride-*`: the ride with Anna's ghost about 10 m ahead, near Valtiera. Valtiera's pin is in the accent colour because its postcard is still to collect; the other places' pins are plain. No text appears in the world.
- `play-ride-pickup-*`: the moment a postcard is collected.
  - On larger viewports the card reads "Postcard from <place>".
  - On phones it shows the place alone and is at most 16rem wide.
- `play-finish-*`: "1:41 ahead of Anna's last ride (3 Nov)" and "7 of 7 postcards found · Ponte San Giovanni, Valtiera, Ponte Valleceppi and 4 more". Day and night.
- `compare/`: the mockup (`docs/design/mockups/p3.2-play-layer.html`) on the left, the build on the right.
  - The icons differ on purpose. The mockup kit has no history, circle-slash, trending-up, zap or flame icons, so it uses stand-ins.
  - The build header and hero follow the shipped Finish page.

## Ride UI area
This uses `hud_area.py`, which measures the sum of surface areas over the viewport. The budget is 15 %.

| | 1440 | 1280×648 | 390 | TV |
| --- | --- | --- | --- | --- |
| Between pickups | 6.1 % | 9.5 % | 12.5 % | 11.6 % |
| Pickup note (6 s) | 6.1 % | 9.5 % | 14.8 % | 11.6 % |

Before this branch, the phone card took the full width and wrapped to two lines, which put it at 17.7 %. On phones the card now shows only the count between pickups.

Other checks across every shot:
- No horizontal overflow.
- Touch targets are at least 40 px (48 px on phones for the step tiles).
- The ghost tiles are 65 px tall, or 113 px on TV.

## Couple ghost accuracy
| Test | Result |
| --- | --- |
| `src/lib/play/ghostReplay.test.ts` | A 4 km ride was recorded through the real `rideStore.tick`, with a 90 s stop and a stretch of 160 ms frames. The ghost is within 1 m of every recorded sample, and within 1 m of every frame on the rider's ride clock. The old wall-clock interpolator was more than 50 m off after the stop. |
| `src/renderers/three/coupleGhost.test.ts` | The same check on the Perugia bundle, through the world renderer's driver: within 1 m of every sample and every frame. |

## Ride tick with the play layer on (measured once)
- **The play layer's own per-frame work.** This covers the couple ghost's pose and the postcard layer's update, over 20,000 frames in node on Tiber park. It took 6.8 µs on average, 8.5 µs at p95 and 15.4 µs at p99, with one GC outlier of 1.5 ms.
- **In the browser** (dev server, 1440×900, 12 s windows, run on and off in alternating order):

| Run | RAF fps | frame p50 | frame p95 | ride `tick()` p50 / p95 / worst | ghost | postcards |
| --- | --- | --- | --- | --- | --- | --- |
| on, round 0 | 25.5 | 16.7 ms | 133 ms | 0.3 / 0.6 / 2.0 ms | yes | 7 |
| off, round 0 | 29.3 | 16.7 ms | 133 ms | 0.2 / 0.5 / 2.6 ms | no | 0 |
| off, round 1 | 12.9 | 33.2 ms | 350 ms | 0.2 / 0.6 / 1.0 ms | no | 0 |
| on, round 1 | 18.5 | 16.7 ms | 283 ms | 0.3 / 0.5 / 1.6 ms | yes | 7 |

How to read these numbers:
- The store's ride step (`tick()`) stays at or below 2.6 ms worst case, with the play layer on or off.
- The frame intervals are bound by the host, not by this code. The load average was 11–18 on 22 cores while shared agents were running. The variance between rounds of the same mode (12.9 vs 29.3 fps with the layer off) is far larger than any difference between on and off.
- The play layer adds microseconds of CPU per frame and a single GLB rider (draw calls 120–123 in both modes).
- I did not run a 60 fps number on an idle machine, so the frame-time figures above are the only browser frame-time evidence.
