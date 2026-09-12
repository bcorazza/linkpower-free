# LinkPower Free

> **Also in this repo:** [Starlink Test](starlink/) — a WiFi connection reliability
> monitor for the Starlink Mini (dish telemetry, latency/jitter/loss, real ICMP ping).
> Live: <https://bcorazza.github.io/linkpower-free/starlink/>

A free, open, web-based replacement for the subscription companion app for
**PeakDo Link-Power** batteries (LinkPower 1 / 2 / 3 / Pod 1 / Power Dock) used on
**Starlink Mini** setups.

Live DC voltage, current and wattage, one-tap DC power on/off, battery pack
telemetry, USB-C status, power charting, low-battery alerting and auto-shutoff —
all over Bluetooth, all client-side. No account, no server, no analytics, no
subscription.

## Live

<https://bcorazza.github.io/linkpower-free/>

## Status — verified on real hardware

Verified 2026-09-12 against a **LinkPower Pack** (`BP4SL3`, firmware 2.0.1,
hardware V1#0201) driving a Starlink Mini:

| Item | Result |
| --- | --- |
| BLE connect | works — advertises as `Link-Power-Pack`, service `0x5301` |
| Live telemetry | works — 20.09 V / 1.62 A / 32.60 W under normal dish load |
| DC output **OFF** | works — `enabled=False`, 0.00 A, 0.00 W |
| DC output **ON** | works — restored to ~32 W |
| Pack gauge (0x4303) / USB-C (0x4305) | not implemented on this model — badged in the UI |

Two hardware gotchas worth knowing, both handled:

1. **`0x4302` supports `write` but not `write without response`.** Commands must be
   *acknowledged* writes; a no-response write is accepted by the OS and ignored by
   the device, which looks exactly like "the button did nothing".
2. **`0x4304` notifies on change, not on a timer** — it produced zero frames over
   3 s at steady load, so the app polls every 2 s for a live readout.

## Why this exists

The hardware's control protocol is fully exposed by PeakDo's own **public** Web
Bluetooth app, so a paid third-party client isn't required for basic monitoring
and DC control. This tool speaks that protocol directly.

## Use it

| Platform | How |
| --- | --- |
| macOS / Windows / Linux | Open the page in **Chrome** or **Edge** (Web Bluetooth). |
| Android | Open in **Chrome**. Add to Home Screen to install as an app. |
| iPhone / iPad | Install **Bluefy** (free) from the App Store, open the page in Bluefy, then Share → **Add to Home Screen**. Safari itself cannot do Web Bluetooth. |

Then: **Connect to battery** → pick your device. If it doesn't appear, tick
*Show all nearby Bluetooth devices*.

Only one Bluetooth client can hold the connection — close the paid app (or any
other client) first.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | UI shell |
| `app.js` | BLE client, telemetry parsers, charting, automation |
| `sw.js` | Service worker — app shell cache so it opens offline |
| `manifest.webmanifest` | PWA manifest for Add to Home Screen |
| `PROTOCOL.md` | The reverse-engineered BLE protocol, written up |
| `tests/protocol.test.mjs` | Codec round-trip + frame decode tests (`node tests/protocol.test.mjs`) |
| `starlink/` | Separate app: Starlink connection reliability monitor |
| `tools/starlink-agent.py` | Local agent for the Starlink Test app (dish telemetry + ICMP ping) |

## Development

```sh
python3 -m http.server 8765     # Web Bluetooth needs http(s), not file://
open -a "Google Chrome" http://localhost:8765/
node tests/protocol.test.mjs
```

## Caveats

- Reverse-engineered from PeakDo's public web app source. Firmware revisions can
  change; use **Dump GATT tree** and the raw console to re-probe if a field goes blank.
- `0xE0` factory mode, `0x12` raw charger registers, `0x11` restart and `0x04` BLE PIN
  can leave the device needing a physical power cycle. Use those deliberately.
- Client-side automation only runs while the page is open. Device-side timers
  (`0x06`) are a separate, on-device mechanism.

## Disclaimer

Unofficial community tool. Not affiliated with, endorsed by, or supported by
PeakDo Tech, Inc. or SpaceX/Starlink. Link-Power, PeakDo and Starlink are
trademarks of their respective owners. Use at your own risk.
