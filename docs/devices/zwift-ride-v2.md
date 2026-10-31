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
manufacturer data before the chooser, so the chooser may list both sides. If
the rider picks the right side the buttons on both sides still arrive in some
firmware, but if nothing arrives the help text tells them to pick the other
entry.

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
brand. The 29 Oct scan saw no controller advertising at all, which matches
"asleep or locked".

## How Velo uses it

Velo is for easy scenic rides. The controllers add comfort, not racing.

| Control | Velo action |
| --- | --- |
| Shift up (either side) | One gear harder |
| Shift down (either side) | One gear easier |
| D-pad up / down | Hills feel harder / easier (trainer difficulty ±5 %) |
| D-pad left / right | Previous / next camera |
| A | Pause / resume |
| Orange levers | Steer: move across the lane; let go and the bike drifts back to the line |
| Others (B, Y, Z, power-up, on/off) | Nothing for now |

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
- Browsers without Web Bluetooth: the "Handlebar controls" section does not
  render.

## Where it lives in the code

| File | What |
| --- | --- |
| `src/lib/controllers/rideProtocol.ts` | Pure codec: UUIDs, button masks, keypad / lever / battery parsing, haptic and info commands |
| `src/lib/controllers/rideController.ts` | Web Bluetooth client: chooser, handshake, notifications, lock / silent detection, reconnect, buzz, hex log |
| `src/lib/controllers/controllerActions.ts` | Button → Velo action mapping and the legend text |
| `src/lib/virtualGears.ts` | Gear table and the equivalent-grade formula |
| `src/lib/laneOffset.ts` | Steering: lane offset easing and the sideways shift |
| `src/stores/controllerStore.ts` | Status, battery, gear, steering input; only "steer with the levers" is saved |
| `src/hooks/useRideControllerActions.ts` | Runs the actions during a ride (Ride page only) |
| `src/components/velo/ControllerPanel.tsx`, `ControllerChip.tsx` | Trainer-panel section and the in-ride gear / hills readout |
| `scripts/ui-shots-controls.py` | Screenshots with a fake controller in headless Chromium (runs the real pairing code) |

The chooser filter is `namePrefix: 'Zwift'` or manufacturer `0x094A`; older
Chrome rejects manufacturer filters with a TypeError, in which case Velo
retries with the name filter only.

## Hardware session checklist (Federico)

Do this with nobody on the bike for steps 1 to 6.

1. Controllers charged and awake (press any button, LED blinks).
2. Unlock: maker's app → pair trainer, then handlebar controls → 30 s and one
   button press → quit the app completely.
3. Within 24 h, on the laptop, Chrome or Edge, open Velo → Home → Trainer →
   "Pair handlebar controls". Pick the entry that starts with "Zwift". If two
   show, pick either; if buttons do not register, unpair and pick the other.
4. Open DevTools console and run `window.__veloController.log()` while pressing
   every button and both levers. Copy the hex lines into a comment on the PR.
   This confirms the analog layout (§ "Analog layout varies").
5. Check the panel shows battery and that "Test buzz" makes the controller
   vibrate.
6. Expected results to report: all 16 buttons named correctly in the log,
   levers go to about ±100, battery shows a percent.
7. Then ride: start an Easy & Scenic route, shift a few gears on a flat and on
   a climb, try D-pad up/down, steer with the levers.

If step 3 fails with "Handlebar controls are locked", repeat step 2 and make
sure the maker's app is fully closed (on a phone, force-quit it; on a Mac,
Cmd-Q).
