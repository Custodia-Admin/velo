# Ride V2 handlebar controllers: research spike

Status: research done 29 Oct 2026, before any code. Hardware session still
pending (see "Hardware session checklist" at the end). Nothing here has been
checked against Federico's own controllers yet; every protocol fact below comes
from the public sources listed, cross-checked between at least two of them.

Velo's UI never shows the maker's brand (UI-RULES §6). This document names the
product because it describes its wire protocol.

## Hardware

- Frame: Zwift Ride V2 smart frame. The handlebar has two controllers (left and
  right). Each has a D-pad or letter buttons, two shift paddles, a "power-up"
  hood button, an on/off button and one orange analog lever on the inside of
  the hood (steering / braking).
- Trainer: Wahoo KICKR CORE 2 with the Zwift Cog. It speaks standard FTMS
  (0x1826), which Velo already drives. It also exposes the maker's own trainer
  service for native virtual shifting; Velo does **not** use that (see
  "Native trainer shifting" below).

## Sources

| Source | Licence | What we took |
| --- | --- | --- |
| Makinolo, "Zwift Ride protocol" (makinolo.com/blog/2024/07/26/zwift-ride-protocol), incl. the Jan 2025 edit | blog post | Advertising data, handshake, message ids, button bitmap, analog lever layout, haptic and info commands, the FC82 UUID change |
| Makinolo, "Connecting to Zwift Play controllers" (2023) | blog post | Characteristic roles (async / sync RX / sync TX), idle message, battery |
| Makinolo's `.proto` posted in ajchellew/zwiftplay#5 | issue text | Field numbers for `RideKeyPadStatus`, `RideAnalogKeyGroup`, `PlayCommand` |
| chrisperkles/serpentine `src/devices/zwift.ts`, `src/devices/index.ts`, `scripts/test-devices.ts` | MIT | Confirmation of UUIDs and masks, the "locked" failure mode, a second analog layout seen in the field, the FTMS gear-emulation idea |
| BikeControl web page (bikecontrol.app) and the old `web/zwift_ride.html` in jonasbark/swiftcontrol | "other" licence | Read only, to confirm the Web Bluetooth flow and the daily-unlock behaviour. No code taken |
| cagnulein/qdomyos-zwift (QZ) | GPL-3 | Not used. Its wiki page on virtual gearing was read for the unlock steps only. No code, no tables copied |
| KickrShiftr | — | Not needed; the above covered everything |

Velo's code is written from the protocol description, not copied. Serpentine
is MIT, so taking ideas from it is fine; it is credited here and in the module
headers.

## BLE layout

### Advertising

- Name: `Zwift SF2` per Makinolo; BikeControl's test page filters on
  `Zwift Ride`. Both start with `Zwift`, so Velo filters on `namePrefix: 'Zwift'`.
- Manufacturer data, company id `0x094A` (2378, Zwift Inc.): one device-type
  byte, then the last two bytes of the BLE address.

| Device type byte | Device |
| --- | --- |
| 1 | Hub trainer |
| 2 / 3 | Play right / left |
| 7 | Ride right |
| 8 | **Ride left** |
| 9 | Click |

Only the **left** controller needs a connection: the right one tunnels its
presses through the left one. Web Bluetooth does not let a page read
manufacturer data before the chooser, so the chooser lists both sides under
the same name ("Zwift Ride").

After the pick, Velo calls `device.watchAdvertisements()` for up to 2.5 s
(before connecting: a connected controller stops advertising) and reads the
type byte of company `0x094A` (`optionalManufacturerData` makes it visible):
`0x08` → left, `0x07` → right. On the right unit the panel and the in-ride chip
say "Right controller paired — buttons need the left one" with a "Pair the
other controller" button, until a press actually comes through (some firmware
forwards them). Browsers without `watchAdvertisements` (it is behind a flag in
some Chrome builds) skip the check; the silent detection below still catches a
dead link and the help text suggests pairing the other entry.

### Services

| UUID | Name | Use |
| --- | --- | --- |
| `0000fc82-0000-1000-8000-00805f9b34fb` (16-bit `FC82`) | Controller service, firmware from Jan 2025 on | Main |
| `00000001-19ca-4651-86e5-fa29dcdd09d1` | Same service on older firmware | Fallback |
| `0x180F` Battery | Standard | Battery level |
| `0x180A` Device information | Standard | Not needed |

Characteristics inside the controller service (same UUIDs under both service
UUIDs):

| UUID | Role | Properties |
| --- | --- | --- |
| `00000002-19ca-4651-86e5-fa29dcdd09d1` | **Async**: button and battery notifications | notify |
| `00000003-19ca-4651-86e5-fa29dcdd09d1` | **Sync RX**: we write commands here | write / write-without-response |
| `00000004-19ca-4651-86e5-fa29dcdd09d1` | **Sync TX**: replies to our commands | indicate / read |

### Handshake

No encryption on the Ride (the Play used ECDH + AES-CCM; the Ride does not).

1. Subscribe to Async and Sync TX.
2. Write the ASCII bytes `RideOn` (`52 69 64 65 4f 6e`) to Sync RX.
3. The controller answers `RideOn` on Sync TX. From then on Async carries
   protobuf messages (proto2), each prefixed by a one-byte message id.

### Messages from the controller (Async)

| Id | Meaning |
| --- | --- |
| `0x23` | `RideKeyPadStatus`: buttons + analog levers |
| `0x19` | Battery / status. Field 1 = battery percent (e.g. `19 08 55` = 85 %). Sent about once a second when idle |
| `0x15` | Idle tick, no payload of interest |
| `0x3c` | Device information reply (to command `0x00`) |
| `0xfe` | Seen when another app takes the controller over |

`RideKeyPadStatus` (`0x23`):

```
message RideKeyPadStatus {
  optional uint32 ButtonMap = 1;           // 32-bit bitmap, INVERSE logic: 0 = pressed
  optional RideAnalogKeyGroup AnalogButtons = 2;
}
message RideAnalogKeyGroup { repeated RideAnalogKeyPress GroupStatus = 1; }
message RideAnalogKeyPress {
  optional uint32 Location = 1;            // 0 = left lever, 1 = right lever, 2/3 unused
  optional sint32 AnalogValue = 2;         // zigzag, -100..100
}
```

Button masks (bit cleared = pressed):

| Mask | Button | Mask | Button |
| --- | --- | --- | --- |
| `0x00001` | D-pad left | `0x00200` | Left shift up |
| `0x00002` | D-pad up | `0x00400` | Left shift down |
| `0x00004` | D-pad right | `0x00800` | Left power-up (hood) |
| `0x00008` | D-pad down | `0x01000` | Left on/off |
| `0x00010` | A | `0x02000` | Right shift up |
| `0x00020` | B | `0x04000` | Right shift down |
| `0x00040` | Y | `0x10000` | Right power-up (hood) |
| `0x00100` | Z | `0x20000` | Right on/off |

Example, D-pad left held, both levers at rest:

```
23 08 fe ff ff ff 0f 12 18 0a 04 08 00 10 00 0a 04 08 01 10 00 0a 04 08 02 10 00 0a 04 08 03 10 00
```

**Analog layout varies.** Makinolo's capture nests the levers as field 2 →
repeated field 1 → {location, value}. Serpentine's tests also accept field 2
or field 3 holding {location, value} directly ("firmware variant"). Velo's
decoder accepts all three shapes. This is the first thing to confirm on the
real hardware (see checklist).

### Commands to the controller (Sync RX)

| Bytes | Meaning |
| --- | --- |
| `52 69 64 65 4f 6e` | `RideOn` handshake |
| `00 08 00` | Request device information (reply `0x3c` on Sync TX: name, serial, hardware version). Optional |
| `12` + `PlayCommand` | Haptic buzz. `PlayCommand { CommandContents(2) { CommandParameters(1) { param1(1), param2(2), HapticPattern(3) } } }`. The short buzz used by BikeControl and Serpentine is param1 = 2, param2 = 0, pattern = 0x20: `12 12 08 0a 06 08 02 10 00 18 20` |

All of these go to the **controller**, never to the trainer. None changes
resistance.

**Haptics (P2.5).** The buzz above is the only haptic write in the public
notes, and the only one Velo sends. Its semantics, as far as the sources go:
`param1 = 2` and `pattern = 0x20` is the "short buzz" both BikeControl and
Serpentine send as shift feedback; `param2 = 0`. Nobody documents other
`param1` / `pattern` values or an intensity field, so Velo does **not** try a
"weaker" pattern: "subtle" means short and rare instead. Velo buzzes:

- once after pairing or reconnecting (which unit is held),
- on "Test buzz" (a tap),
- on a gear change, only during a ride, only with "Buzz on gear change" on
  (Trainer panel → Handlebar controls, default on), at most one buzz per
  150 ms, so a fast double shift gives one buzz. No buzz at the end of the
  gear range (nothing changed).

`encodeHaptic()` reproduces the documented bytes exactly
(`12 12 08 0a 06 08 02 10 00 18 20`, pinned in `rideProtocol.test.ts`).

## The daily lock (firmware 1.3+, "Ride V2")

From firmware 1.3 the Ride ships locked to its maker's app. Two symptoms are
reported:

- the controller service is missing from GATT (Serpentine treats a missing
  service as "locked"), or
- the service is there but stops sending presses after a short while.

Neither BikeControl nor Serpentine has a workaround for the Ride V2 (BikeControl
has one for the Click V2 only). The fix is manual, once per ~24 h:

1. Open the maker's desktop or mobile app (a free account is enough, no
   subscription).
2. Go to the pairing screen, connect the trainer, then the handlebar controls.
3. Keep them connected for 30 s and press a button so the app sees it.
4. Quit the app completely (it must release the controller: only one app can
   hold it at a time).
5. Pair the handlebar controls in Velo.

Velo detects both symptoms and says so in plain words; it never shows the
brand. "No message at all within 10 s of the handshake" counts as the second
symptom: the panel and the in-ride chip then show this recipe (shortened) with
a Reconnect button. The 29 Oct scan saw no controller advertising at all, which matches
"asleep or locked".

## How Velo uses it

Velo is for easy scenic rides. The controllers add comfort, not racing.

| Control | Velo action |
| --- | --- |
| Shift up (either side) | One gear harder |
| Shift down (either side) | One gear easier |
| D-pad up / down | Hills feel harder / easier (trainer difficulty ±5 %) |
| D-pad left / right | Previous / next camera (in show mode this takes over from the auto camera) |
| Power-up (hood) left / right | Camera closer / further (close, standard, far, overview) |
| A | Pause / resume |
| Orange levers | Steer: move across the lane; let go and the bike drifts back to the line |
| On/off | Never mapped: they power the controllers |

Show mode (watching your own videos) gives the letter buttons to the player:

| Control | Show mode action |
| --- | --- |
| Y | Play / pause the video |
| Z | Next video |
| B | Auto camera on / off |

Outside show mode B, Y and Z do nothing. The map and the action runner are
pure (`controllerActions.ts`, tested); the Ride page wires them to the stores.

### Steering feel

`src/lib/controllers/steerFeel.ts`, applied once per frame by both renderers:

1. Deadzone 12 % of lever travel, rescaled so the response starts at 0 at
   the edge (no jump).
2. Expo curve, 45 % cubic: small pushes make fine lane changes, a full push
   still reaches the full 1.6 m.
3. Lane-centring spring: critically damped, so lane changes start and stop
   softly and never overshoot. Steering stiffness ω = 5 rad/s (about 0.9 s
   to settle), release ω = 2 rad/s (back on the line in about 2.4 s). The
   step is the exact solution per frame, so the feel is the same at 30, 60
   or 144 fps.

The raw lever reading (`steerFrom`) is unchanged and is what the debug log
shows; only `activeSteer()` is shaped.

### Virtual gears on plain FTMS

The KICKR in FTMS SIM mode turns a gradient into resistance at the flywheel
speed it measures. With the Zwift Cog the physical ratio is fixed, so "a gear"
has to be made in software:

- Gear factor `k` (harder gear = larger `k`). Velo has 11 gears, gear 6 is
  neutral (`k = 1`), each step is ×1.1 (0.62 to 1.61).
- Virtual speed = trainer speed × `k` (same cadence, harder gear, faster).
- The resistance at the wheel must be `k` times the road force at the
  virtual speed, so the rider's power matches the virtual world:
  `F_trainer = k · F_road(grade, v_virtual)`.
- Velo sends the equivalent grade that makes the trainer produce that force,
  given the trainer adds its own rolling and air resistance from the Crr and
  Cw Velo already sends:
  `grade_sent = k·grade + 100·(k·(m g Crr + Cw v_virtual²) − (m g Crr + Cw v_trainer²)) / (m g)`.
  At `k = 1` this is exactly the input grade.
- Applied after the comfort scaling (trainer difficulty), clamped to the same
  −10 % … 20 % limits, sent through the existing single FTMS writer and
  throttle (a shift is sent at once instead of waiting for the next tick).
  ERG mode ignores gears.
- The ride store keeps the trainer's own speed (`trainerSpeed`) next to the
  shown speed, so the geared speed is always computed from the trainer's
  figure and never compounds frame to frame.

Serpentine has the same idea as its "FTMS fallback"; Velo's formula is
derived independently and keeps the k = 1 case an exact identity, so with no
controllers paired nothing changes.

### Native trainer shifting (not used)

The KICKR CORE 2 also exposes the maker's trainer service (same FC82 /
19ca UUIDs on the trainer): `RideOn 02 01` handshake, then `0x04` commands
carrying grade and a gear ratio (`GearRatioX10000`). This gives smoother
shifting but:

- it is a second control channel to the trainer next to FTMS, which conflicts
  with Velo's "one FTMS consumer" rule and needs care so both never fight,
- it cannot be tested without someone on the bike.

So it is a follow-up, not part of this card.

### Graceful degradation

- No controller, or controller asleep or locked: gear stays neutral, `k = 1`,
  steering 0. The ride loop sends exactly what it sent before this change.
- Controller drops mid-ride: Velo retries five times (1, 2, 4, 8, 15 s).
  While it retries the gear stays where it was, so the resistance does not
  jump. If it does not come back it is shown as "asleep" and the trainer goes
  back to the neutral gear (plain trainer feel). "Reconnect" in the Trainer
  panel tries again without the chooser.

### Battery and reconnect (P2.5)

- **Battery** comes from the standard Battery Service (0x180F, Battery Level
  0x2A19) on both the controllers and the trainer: read once at connect,
  then followed by notifications (`src/lib/controllers/battery.ts`). The
  controller's own `0x19` messages also update it. Shown as an icon and
  "76 %" next to the status in the Trainer panel (controls and trainer) and
  in the in-ride chip; at or below 20 % it turns red and the in-ride chip
  says "Battery low: charge after this ride".
- **After a reload**, the controls paired last (remembered as
  `velo.lastController`, id + name) come back through
  `navigator.bluetooth.getDevices()` without the chooser: silently when a
  ride opens, or with one tap ("Reconnect Zwift Ride") in the panel.
  "Forget" drops the memory. The trainer has done the same since 098dd81.
- **Wake.** Controls that went to sleep (asleep after the retries) and a
  trainer whose own retries gave up (0.6, 1.2, 2.4, 4 s) are watched with
  `watchAdvertisements()`; the first advert (a button press, a pedal stroke)
  reconnects them. During the ride only: on Home nothing reconnects by
  itself. The trainer comes back from Demo Mode to trainer mode, and the
  ride loop re-sends the current SIM grade on the next frame.
- **What may write when.** Resistance (FTMS 0x05 / 0x11) goes out only while
  a ride the rider started is riding (`rideFsm.resistanceOf`, unchanged).
  Reconnects re-run the full FTMS handshake (Request Control 0x00, Start
  0x07) and nothing else. Automatic reconnects, wake reconnects and gear
  buzzes happen only inside the ride session (`rideSession.ts`: the Ride
  page is open); outside it every Bluetooth write follows a tap. Pinned in
  `src/lib/deviceLayer.test.ts` (real FTMS client on a fake KICKR) and
  `rideController.test.ts`.
- Browsers without Web Bluetooth: the "Handlebar controls" section does not
  render.

## Where it lives in the code

| File | What |
| --- | --- |
| `src/lib/controllers/rideProtocol.ts` | Pure codec: UUIDs, button masks, keypad / lever / battery parsing, haptic and info commands |
| `src/lib/controllers/rideController.ts` | Web Bluetooth client: chooser, handshake, notifications, lock / silent detection, reconnect, buzz, hex log |
| `src/lib/controllers/controllerActions.ts` | Button → Velo action mapping (ride and show mode), the action runner and the legend text |
| `src/lib/controllers/battery.ts` | Standard Battery Service read + notifications, display bands |
| `src/lib/controllers/reconnect.ts` | Backoff retries, wake watch, remembered / granted devices (controls and trainer) |
| `src/lib/controllers/rideSession.ts` | The ride session: when devices may act on their own |
| `src/lib/controllers/steerFeel.ts` | Steering feel: deadzone, expo, lane-centring spring |
| `src/lib/virtualGears.ts` | Gear table and the equivalent-grade formula |
| `src/lib/laneOffset.ts` | The sideways shift for a lane offset |
| `src/stores/controllerStore.ts` | Status, battery, gear, steering input; only "steer with the levers" is saved |
| `src/hooks/useRideControllerActions.ts` | Runs the actions during a ride (Ride page only) |
| `src/components/velo/ControllerPanel.tsx`, `ControllerChip.tsx` | Trainer-panel section and the in-ride gear / hills readout |
| `scripts/ui-shots-controls.py` | Screenshots with a fake controller in headless Chromium (runs the real pairing code) |

The chooser filter is `namePrefix: 'Zwift'` or manufacturer `0x094A`; older
Chrome rejects manufacturer filters with a TypeError, in which case Velo
retries with the name filter only.

## Owner hardware check (P2.5, about 5 minutes)

Ride V2 + KICKR CORE 2, Chrome on the laptop. Record the result in the PR.

1. **Battery %.** Home → Trainer: pair the handlebar controls (left unit) and
   the trainer. Both rows show a battery icon and a percent. Compare with the
   maker's app if handy (within a few %).
2. **Reconnect on wake.** Start a ride. Leave the bars untouched until the
   chip says "Asleep" (or switch the left unit off and on). Press any button:
   the chip goes back to Controls within a few seconds and the bars buzz once.
   Stop pedalling until the trainer drops (or unplug it for 10 s and plug it
   back), then pedal: it reconnects, the toast says so, and resistance follows
   the road again.
3. **Reload.** Reload the page, open a ride: trainer and controls reconnect
   without the chooser.
4. **Gear buzz.** Shift up and down a few times: one short buzz per shift, a
   fast double shift gives one buzz, nothing at gear 1 or 11. Turn "Buzz on
   gear change" off in the Trainer panel: shifting is silent.
5. **Steering feel.** Push a lever lightly: a small, slow move across the
   lane. Push fully: the bike reaches the lane edge in about a second without
   overshooting. Let go: it eases back to the line in about 2–3 s.
6. In show mode: Y plays/pauses, Z skips, B toggles the auto camera; the hood
   buttons move the camera closer / further.

## Hardware session checklist (Federico)

Do this with nobody on the bike for steps 1 to 6.

1. Controllers charged and awake (press any button, LED blinks).
2. Unlock: maker's app → pair trainer, then handlebar controls → 30 s and one
   button press → quit the app completely.
3. Within 24 h, on the laptop, Chrome or Edge, open Velo → Home → Trainer →
   "Pair handlebar controls". Pick the entry that starts with "Zwift". If two
   show, pick either; if Velo says "Right controller paired", tap "Pair the
   other controller" and pick the other entry.
4. The controller buzzes once when it connects: that is the unit Velo holds.
   The panel reads "Left controller · connected · buzzed · battery N %".
5. Field log without DevTools: Home → Trainer → "Controller debug" on. The
   ride view then shows the last 8 raw messages (hex) with their reading
   (`keys shiftUpR · press shiftUpR→gearHarder · gear 6→7`), screenshot-ready,
   and a "Copy log" button. On a laptop `window.__veloController.log()` in the
   console still prints the full 300-line log. Press every button and both
   levers; this confirms the analog layout (§ "Analog layout varies").
6. Check the panel shows battery and that "Test buzz" makes the controller
   vibrate.
7. Expected results to report: all 16 buttons named correctly in the log,
   levers go to about ±100, battery shows a percent.
8. Then ride: start an Easy & Scenic route, shift a few gears on a flat and on
   a climb, try D-pad up/down, steer with the levers.

If step 3 fails with "Handlebar controls are locked", repeat step 2 and make
sure the maker's app is fully closed (on a phone, force-quit it; on a Mac,
Cmd-Q).
