#!/usr/bin/env python3
"""Look for any pack/slot/battery-count information on a PeakDo Link-Power Pack.

Waits for the device to advertise (it stops advertising while another client
holds it), then:
  1. dumps every service and characteristic with its properties
  2. sweeps the safe read-only command opcodes on 0x4302
  3. measures internal resistance from a V/I fit under changing load, which is
     the one physical signal that varies with the number of packs in parallel

Sends no state-changing commands.
"""
import asyncio, statistics, subprocess, sys, time
from bleak import BleakClient, BleakScanner

SVC   = "00005301-0000-1000-8000-00805f9b34fb"
CHR_CMD = "00004302-0000-1000-8000-00805f9b34fb"
CHR_DC  = "00004304-0000-1000-8000-00805f9b34fb"

# Read-only GET opcodes. Deliberately excludes 0x11 restart, 0x20 bluetooth-off
# and 0xE0 factory mode.
GETS = [0x01, 0x02, 0x03, 0x05, 0x06, 0x10, 0x12, 0x15, 0x17, 0x18, 0x19, 0xFE]

def f16(r):
    m, e = r & 0x0FFF, r >> 12
    return (m - 0x1000 if m & 0x0800 else m) * (10 ** (e - 0x10 if e & 0x08 else e))

def dc(b):
    st = b[1] - 256 if b[1] > 127 else b[1]
    return b[0] == 1, st, f16(int.from_bytes(b[2:4], 'little')), \
           f16(int.from_bytes(b[4:6], 'little')), f16(int.from_bytes(b[6:8], 'little'))

async def wait_for_device(timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        found = await BleakScanner.discover(timeout=6, return_adv=True)
        for d, a in found.values():
            if SVC in [str(u).lower() for u in (a.service_uuids or [])]:
                return d
        print(f"  … waiting ({int(time.time()-t0)}s)", flush=True)
    return None

async def main():
    print("waiting up to 300s for the LinkPower Pack to advertise…", flush=True)
    dev = await wait_for_device(300)
    if not dev:
        print("never appeared — it is still held by another client"); return
    print(f"\nFOUND {dev.name}\n")

    async with BleakClient(dev, timeout=30) as c:
        print("=== 1. complete GATT tree ===")
        for s in c.services:
            print(f"  svc {s.uuid}")
            for ch in s.characteristics:
                print(f"     chr {ch.uuid}  [{' '.join(ch.properties)}]")

        print("\n=== 2. read-only opcode sweep on 0x4302 ===")
        cmd = c.services.get_characteristic(CHR_CMD)
        for op in GETS:
            try:
                await c.write_gatt_char(cmd, bytearray([op, 0x00]), response=True)
                await asyncio.sleep(0.25)
                v = await c.read_gatt_char(cmd)
                print(f"  0x{op:02x} GET -> {v.hex()}")
            except Exception as e:
                print(f"  0x{op:02x} GET -> {type(e).__name__}: {e}")

        print("\n=== 3. internal resistance from V/I under changing load ===")
        rows, dl, t0 = [], None, time.time()
        while time.time() - t0 < 40:
            try:
                en, st, v, a, w = dc(await c.read_gatt_char(CHR_DC))
                rows.append((v, a))
            except Exception:
                pass
            if dl is None and time.time() - t0 > 10:
                dl = subprocess.Popen(["curl", "-s", "-o", "/dev/null",
                    "https://speed.cloudflare.com/__down?bytes=150000000"])
            await asyncio.sleep(0.25)
        if dl: dl.terminate()
        good = [(v, a) for v, a in rows if a > 0.05]
        print(f"  {len(rows)} samples, {len(good)} under load")
        if len(good) > 8:
            xs = [a for _, a in good]; ys = [v for v, _ in good]
            mx, my = statistics.mean(xs), statistics.mean(ys)
            den = sum((x - mx) ** 2 for x in xs)
            slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den if den else 0
            inter = my - slope * mx
            ss_tot = sum((y - my) ** 2 for y in ys)
            ss_res = sum((y - (inter + slope * x)) ** 2 for x, y in zip(xs, ys))
            r2 = 1 - ss_res / ss_tot if ss_tot else 0
            print(f"  current range {min(xs):.2f}-{max(xs):.2f} A, voltage {min(ys):.2f}-{max(ys):.2f} V")
            print(f"  fit: V = {inter:.3f} - {abs(slope):.4f} * I     (R^2 = {r2:.3f})")
            print(f"  => internal resistance ~ {abs(slope)*1000:.0f} mOhm")
            print("     one healthy 5 Ah pack is ~100-150 mOhm; packs in parallel divide it")

asyncio.run(main())
