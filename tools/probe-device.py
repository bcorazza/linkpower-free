#!/usr/bin/env python3
"""Read-only protocol probe for a PeakDo LinkPower device.

Scans, connects, dumps the GATT tree, reads device_information, the DC port
telemetry and the capability bitmask. Sends no state-changing commands.

    ./.venv/bin/python tools/probe-device.py
"""
import asyncio, sys
from bleak import BleakClient, BleakScanner

SVC_LP   = "00005301-0000-1000-8000-00805f9b34fb"
CHR_CMD  = "00004302-0000-1000-8000-00805f9b34fb"
CHR_BAT  = "00004303-0000-1000-8000-00805f9b34fb"
CHR_DC   = "00004304-0000-1000-8000-00805f9b34fb"
CHR_TYPEC= "00004305-0000-1000-8000-00805f9b34fb"
FIELDS = {
    "Model":        "00002a24-0000-1000-8000-00805f9b34fb",
    "Firmware":     "00002a26-0000-1000-8000-00805f9b34fb",
    "Hardware":     "00002a27-0000-1000-8000-00805f9b34fb",
    "Software":     "00002a28-0000-1000-8000-00805f9b34fb",
    "Manufacturer": "00002a29-0000-1000-8000-00805f9b34fb",
}

def f16(raw):
    m, e = raw & 0x0FFF, raw >> 12
    return (m - 0x1000 if m & 0x0800 else m) * (10 ** (e - 0x10 if e & 0x08 else e))

def parse_dc(b):
    st = b[1] - 256 if b[1] > 127 else b[1]
    st = 2 if st == -1 else st
    row = (f"enabled={b[0] == 1} status={st} "
           f"V={f16(int.from_bytes(b[2:4],'little')):.2f} "
           f"A={f16(int.from_bytes(b[4:6],'little')):.2f} "
           f"W={f16(int.from_bytes(b[6:8],'little')):.2f}")
    if len(b) >= 9: row += f" bypass={bool(b[8])}"
    return row

def parse_bat(b):
    st = b[1] - 256 if b[1] > 127 else b[1]
    return (f"level={b[7]}% cap={f16(int.from_bytes(b[5:7],'little')):.0f}/"
            f"{f16(int.from_bytes(b[3:5],'little')):.0f}Wh "
            f"V={f16(int.from_bytes(b[8:10],'little')):.2f} "
            f"A={f16(int.from_bytes(b[10:12],'little')):.2f} "
            f"W={f16(int.from_bytes(b[12:14],'little')):.2f} "
            f"remain={int.from_bytes(b[14:16],'little')}min status={st} full={b[2]==1}")

def parse_tc(b):
    st = b[1] - 256 if b[1] > 127 else b[1]
    return (f"enabled={b[0]} status={st} "
            f"V={f16(int.from_bytes(b[2:4],'little')):.2f} "
            f"A={f16(int.from_bytes(b[4:6],'little')):.2f} "
            f"W={f16(int.from_bytes(b[6:8],'little')):.2f} "
            f"T={f16(int.from_bytes(b[8:10],'little')):.1f}C")

async def main():
    print("scanning for a LinkPower device (15s)…")
    found = await BleakScanner.discover(timeout=15, return_adv=True)
    target = None
    for dev, adv in found.values():
        uuids = [str(u).lower() for u in (adv.service_uuids or [])]
        name = (dev.name or adv.local_name or "")
        if SVC_LP in uuids or "link" in name.lower() or "pack" in name.lower():
            target = (dev, adv); break
    if not target:
        print(f"NOT FOUND in {len(found)} devices. The pack is not advertising:")
        print("  - still connected to another client (iPhone/macOS), or")
        print("  - its own Bluetooth is off -> triple-press the power button")
        sys.exit(1)
    dev, adv = target
    print(f"FOUND  name={dev.name!r} local_name={adv.local_name!r} rssi={adv.rssi} addr={dev.address}")
    print(f"       advertised services={[str(u) for u in (adv.service_uuids or [])]}")

    async with BleakClient(dev, timeout=30) as c:
        print("\nCONNECTED — GATT tree:")
        for s in c.services:
            print("  svc", s.uuid)
            for ch in s.characteristics:
                print("     chr", ch.uuid, " ".join(ch.properties))
        print("\ndevice_information:")
        for label, u in FIELDS.items():
            try: print(f"  {label:13} { (await c.read_gatt_char(u)).decode('utf-8','replace').strip()!r}")
            except Exception as e: print(f"  {label:13} (unavailable: {type(e).__name__})")
        for label, u, fn in (("DC 0x4304", CHR_DC, parse_dc), ("BAT 0x4303", CHR_BAT, parse_bat),
                             ("TC 0x4305", CHR_TYPEC, parse_tc)):
            try:
                v = await c.read_gatt_char(u)
                print(f"\n{label} raw={v.hex()}\n  {fn(v)}")
            except Exception as e:
                print(f"\n{label}: not implemented on this model ({type(e).__name__})")
        print("\ncapability query  0xFE GET  (read-only):")
        try:
            ch = c.services.get_characteristic(CHR_CMD)
            await c.write_gatt_char(ch, bytearray([0xFE, 0x00]), response=True)
            await asyncio.sleep(0.4)
            v = await c.read_gatt_char(ch)
            print("  raw:", v.hex())
            if len(v) >= 7 and v[0] == 0xFE:
                print(f"  status_byte=0x{v[2]:02x} features=0x{int.from_bytes(v[3:7],'little'):08x}")
        except Exception as e:
            print("  failed:", type(e).__name__, e)

asyncio.run(main())
