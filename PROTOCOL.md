# PeakDo Link-Power BLE protocol

Reverse-engineered from PeakDo's own **public** Web Bluetooth app, which is served
unminified:

- Base: `https://pwa.peakdo.ca/link-power-1/`
- `js/ble.js` — GATT constants + BLE manager
- `js/lp-ble-cmds.js` — command opcode / action tables
- `js/utils.js` — the custom 16-bit float codec
- `views/main-view.js` — telemetry frame layouts + command construction

This is the same base the commercial LinkPower Companion app was built against
("we reverse-engineered the BLE protocol from PeakDo's public Web App sources").

## GATT

Advertised name contains `Link-Power`. Filter on service `0x5301` or the name prefix.

| UUID | Purpose |
| --- | --- |
| `00005301-0000-1000-8000-00805f9b34fb` | LinkPower service (primary) |
| `00004301-...` | OTA |
| `00004302-...` | **Command in / response out** |
| `00004303-...` | Extended battery info — **notify** |
| `00004304-...` | DC port status — **notify** |
| `00004305-...` | USB-C port status — **notify** |
| `00004310-...` | Factory mode |
| `device_information` (0x180A) | model / firmware / hardware / software / manufacturer strings |
| `battery_service` (0x180F) | `battery_level` |
| `current_time` (0x1805) | device clock sync |

## Number encoding — "BLE float16"

Voltages, currents, powers and temperatures are **not** IEEE-754 half floats.
They are 12-bit signed mantissa × 10^(4-bit signed exponent), little-endian:

```js
function parseBLEFloat16(raw) {
  const mRaw = raw & 0x0FFF;
  const eRaw = raw >> 12;
  const mantissa = (mRaw & 0x0800) ? mRaw - 0x1000 : mRaw;
  const exponent = (eRaw & 0x08) ? eRaw - 0x10 : eRaw;
  return mantissa * Math.pow(10, exponent);
}
```

Verified round-trip (see `tests/protocol.test.mjs`): all of 12.9, 20.1, 62.3,
-2.41, 99.0 encode and decode within 0.005% relative error.

## Command frames

Write to `0x4302`. The response is read back from `0x4302`.

```
[ opcode, action, payload... ]
```

- Actions: `0x00` GET, `0x01` SET, `0x02` DEL
- Opcodes:

| Opcode | Name | Notes |
| --- | --- | --- |
| `0x01` | DC_CONTROL | payload `1` = on, `0` = off → `01 01 01` / `01 01 00` |
| `0x02` | TYPEC_POWER_LIMIT | `0..5` ≈ 30W–140W |
| `0x03` | BARRIER_FREE_MODE | |
| `0x04` | BLE_PIN | 4 bytes LE, 0–999,999 |
| `0x05` | IP2366_REG_DEFAULT_VALUE | |
| `0x06` | SCHEDULED_ON_OFF | on-device timers, up to 6 |
| `0x10` | DEVICE_ID | |
| `0x11` | RESTART | |
| `0x12` | IP2366_REG_VALUE | raw charger register access |
| `0x13` | TYPEC_CONTROL | `13 01 <state_out> <op>` |
| `0x14` | DC_BYPASS_CONTROL | `14 01 <op>` |
| `0x15` | DC_BYPASS_THRESHOLD | |
| `0x17` | GET_USB_FW_VERSION | |
| `0x19` | LCD_BRIGHTNESS_CTL | |
| `0x20` | BLUETOOTH_CTL | `20 01 01` = switch the device's own BLE radio **off** (releases it from a holding client; requires triple-press to restore) |
| `0xE0` | RUNNING_MODE_CONTROL | `0` = user, `1` = factory |
| `0xFE` | FEATURES | capability bitmask |

Legacy frames observed in `ble.js` (13 bytes, zero padded) also work for DC power:
`[0x01,0,0...]` = on, `[0x00,0,0...]` = off.

## Telemetry frames

`status` is `int8`, and the app maps `-1 → 2`, so **0 = idle, 1 = charging, 2 = discharging**.

### `0x4303` EXT_BATTERY_INFO — 16 bytes

| Offset | Type | Field |
| --- | --- | --- |
| 0 | uint8 | enabled |
| 1 | int8 | status |
| 2 | uint8 | isFull |
| 3 | uint16 LE, float16 | max capacity (Wh) |
| 5 | uint16 LE, float16 | capacity (Wh) |
| 7 | uint8 | level (%) |
| 8 | uint16 LE, float16 | voltage |
| 10 | uint16 LE, float16 | current |
| 12 | uint16 LE, float16 | power |
| 14 | uint16 LE | remaining (minutes) |

### `0x4304` DC_PORT_STATUS — 8 or 9 bytes

| Offset | Type | Field |
| --- | --- | --- |
| 0 | uint8 | enabled (1 = output on) |
| 1 | int8 | status |
| 2 | uint16 LE, float16 | voltage |
| 4 | uint16 LE, float16 | current |
| 6 | uint16 LE, float16 | power |
| 8 | uint8 | bypass active *(only present on 9-byte frames → bypass supported)* |

### `0x4305` TYPEC_PORT_STATUS — 10 / 12 / 13 bytes

| Offset | Type | Field |
| --- | --- | --- |
| 0 | uint8 | enabled |
| 1 | int8 | status |
| 2 | uint16 LE, float16 | voltage |
| 4 | uint16 LE, float16 | current |
| 6 | uint16 LE, float16 | power |
| 8 | uint16 LE, float16 | temperature |
| 11 | uint8 | mode *(≥12 bytes → output control supported)* |
| 12 | uint8 | is DC input *(≥13 bytes → DC input supported)* |

Frame **length** is used as the capability signal: shorter frames mean the
firmware doesn't expose that feature. Handle both.

## Known model strings

| Model | Product |
| --- | --- |
| `BP4SL3V1` / `PK-LINK-POWER-1` | LinkPower 1 |
| `BP4SL3V2` | LinkPower 2 |
| `BP4SL3` | LinkPower+ |
| `BP4SL3-D2` | Power Dock with Adapter (DeWalt/Makita/Milwaukee, 2-battery) |
| `BP4SL3-D4` | Power Dock (4-battery) |

## Verified against real hardware

Confirmed by direct connection on 2026-09-12 to a **LinkPower Pack** (`BP4SL3`),
advertised as `Link-Power-Pack`, firmware 2.0.1 / hardware V1#0201 / software 1.2.1.

Actual GATT tree of that unit — note how little of the full protocol it implements:

```
00005301-...  LinkPower service
   00004301  OTA                 write, read
   00004302  LinkPower command   write, read
   00004304  DC port status      notify, read
0000180a-...  device_information  read  (model/fw/hw/sw/manufacturer)
00001805-...  current_time        read, write, notify
```

Absent on this model: `0x4303` (pack gauge), `0x4305` (USB-C), `0x4310` (factory).
The Pack has no battery gauge or USB-C port of its own, so this is correct rather
than broken — treat a failed read as "not on this model".

### Command responses are acknowledged

Writing `01 01 01` (DC_CONTROL SET ON) to `0x4302` returns:

```
01 81 00      [opcode, 0x80 | action, status]      status 0x00 = OK
```

So `0x80` marks a response, the low bit mirrors the action (`0x00` GET / `0x01` SET),
and byte 2 is a status/error code. The capability query (`FE 00`) returned `fe 80 9c`
— 3 bytes, below the 7 the official PWA requires, so it takes the "features unknown"
path and falls back to inferring capability from frame lengths. Do the same.

### The command characteristic requires an ACKNOWLEDGED write

`0x4302` exposes **`read` + `write` only — no `write without response`**:

```
chr 00004302-...  write read
```

PeakDo's own client therefore uses `writeValueWithResponse` (its `write()` helper
defaults `withoutResponse = false`). Sending a no-response write can be silently
accepted by the OS and ignored by the device, which looks exactly like "the button
did nothing". Always use an acknowledged write.

Verified toggle on hardware:

```
BEFORE     enabled=True  status=2  V=20.05  A=1.62  W=32.50
DC OFF 01 01 00  -> ACK 018100
AFTER OFF  enabled=False status=0  V=19.89  A=0.00  W=0.00
DC ON  01 01 01  -> ACK 018100
AFTER ON   enabled=True  status=2  V=20.30  A=0.44  W=8.86   (dish booting)
```

Note the ACK does **not** echo the resulting state — read `0x4304` back to confirm.

### Notifications are change-driven, not periodic

`start_notify` on `0x4304` is accepted but produced **zero frames in 3 seconds**
while the load sat steady at 20.09 V / 1.62 A. A notification-only UI shows stale
data on this firmware. **Poll the characteristics** (~2 s) and use notifications
only as an extra trigger.

### Observed sample

```
DC 0x4304 raw = 01 ff d9 e7 54 d6 46 f1
  enabled=1  status=0xff -> -1 -> 2 (discharging)
  d9 e7 -> 0xE7D9 -> mantissa 2009, exp -2 -> 20.09 V
  54 d6 -> 0xD654 -> mantissa 1620, exp -3 ->  1.62 A
  46 f1 -> 0xF146 -> mantissa  326, exp -1 -> 32.60 W
```

20.09 V x 1.62 A = 32.5 W, matching the reported 32.6 W — a Starlink Mini under
normal load. Eight bytes, so no bypass byte: bypass is correctly reported as absent.

## Device-family differences

The Pack / Power Dock (`BP4SL3-D4`, `BP4SL3-D2`) implements **only the DC port
telemetry** (`0x4304`). It has no pack gauge and no USB-C port of its own, so
`0x4303` and `0x4305` are typically absent — treat a failed read/subscribe on
those as "not on this model", not as an error. The official PWA hard-gates them
behind `device.model == BP4SL3V1 | BP4SL3V2`, which confirms this.

Also required by the official PWA before it will talk to a device: read the OTA
info char (`0x4301`, command `84`) and check `mode` — `1` = APP mode, `2` = OTA
mode. It throws `Unknown mode` otherwise. Worth replicating if a device
misbehaves.

## Battery state of charge — there is no fuel gauge

The Pack / Power Dock (`BP4SL3`) does **not** implement `0x4303`
(EXT_BATTERY_INFO), so there is no fuel-gauge reading to fetch: no percentage,
no remaining-energy field. PeakDo's own PWA gates that characteristic to
`BP4SL3V1 | BP4SL3V2` only.

What you *can* use is the DC port voltage, for two reasons:

1. The port runs **15–21 V**, which is exactly a **5S Li-ion** pack
   (3.0–4.2 V/cell). The port voltage *is* the DeWalt pack voltage.
2. With the DC output switched **off**, the port still reports the pack voltage
   (measured: `enabled=False, V=19.89, A=0.00`) — i.e. a true open-circuit sample.

### There is no pack/slot count on the BLE interface

Confirmed by enumerating every service and characteristic on a real unit, then
sweeping every read-only opcode:

```
0x01 GET -> 01 80 00 01            supported   DC output state
0x02 GET -> 02 80 9c               not implemented
0x03 GET -> 03 80 00 ff            supported
0x05 GET -> 05 80 9c               not implemented
0x06 GET -> 06 80 ff 03            supported
0x10 GET -> 10 80 00 52bee0f517c8  supported   DEVICE_ID
0x12 GET -> 12 80 9c               not implemented
0x15 GET -> 15 80 9c               not implemented
0x17 GET -> 17 80 9c               not implemented
0x18 GET -> 18 80 9c               not implemented
0x19 GET -> 19 80 9c               not implemented
0xFE GET -> fe 80 9c               not implemented
```

Nothing reports how many packs are installed. That is consistent with the
hardware: the dock parallels the packs onto one 20 V bus, so the DC telemetry is
a single bus measurement and telling packs apart would need per-slot sensing.
The app therefore asks the user for **packs installed**.

`0x10` returns the device MAC. Measured `52 be e0 f5 17 c8`, which is exactly the
BLE address `C8:17:F5:E0:BE:52` byte-reversed — confirming the note in PeakDo's
own source that the "device ID" is the MAC address.

The one indirect signal is **internal resistance**, which packs in parallel
divide. Measured on a 2-pack setup by fitting `V = a - R*I` over a 0.55-1.67 A
load swing: **R = 0.181 ohm** (R^2 = 0.70). That is well above what fresh packs
imply, so pack age and dock/wiring resistance dominate — too confounded to count
packs with, but good enough to calibrate the sag correction.

### Method used by the app (`soc.js`)

- **Voltage → SoC** via an open-circuit-voltage lookup table for Li-ion,
  used as an absolute anchor.
- **Load sag** corrected with `V_ocv = V_measured + I × R`, `R ≈ 0.06 Ω`
  (packs in parallel). At the ~32 W this setup draws (1.6 A) the correction is
  only ~0.1 V, so voltage-based SoC is unusually reliable here.
- **Coulomb counting** carries the anchor between voltage samples:
  `SoC = anchor − (Wh used ÷ nameplate Wh) × 100`. Pure voltage is noisy under
  changing load; pure counting drifts. Anchoring on voltage and integrating
  energy is the standard fix.
- Re-anchors automatically whenever a genuine resting voltage appears
  (output confirmed off), and on demand via **Re-anchor**.

Energy maths uses **20 V** per pack to match how DeWalt labels 20V MAX capacity
(e.g. a 5.0 Ah pack is sold as 100 Wh).

Accuracy: roughly ±10%. It assumes the packs are healthy, balanced and similar —
one weak pack in a 4-pack dock will drag the real runtime below the estimate.
The curve is covered by `tests/soc.test.mjs` (21 assertions).

## Safety notes

- Only one BLE client can hold the connection. Close other apps before connecting.
- `0xE0` factory mode, `0x12` raw charger registers, `0x11` restart and
  `0x04` BLE PIN can leave the device in a state that needs a physical power
  cycle. Use them deliberately.
- Power-limit and timer commands are persisted **on the device**, not in the app.
