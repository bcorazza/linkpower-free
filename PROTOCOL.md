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
| `0x20` | BLUETOOTH_CTL | |
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

## Safety notes

- Only one BLE client can hold the connection. Close other apps before connecting.
- `0xE0` factory mode, `0x12` raw charger registers, `0x11` restart and
  `0x04` BLE PIN can leave the device in a state that needs a physical power
  cycle. Use them deliberately.
- Power-limit and timer commands are persisted **on the device**, not in the app.
