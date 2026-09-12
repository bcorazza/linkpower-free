#!/usr/bin/env python3
"""Two-point internal-resistance calibration for a PeakDo Link-Power Pack.

R = (V_resting - V_loaded) / I_loaded

More accurate than fitting V/I over a load swing, because it removes any drift
confound: the two voltages are taken seconds apart at the same state of charge.

This briefly switches the DC output OFF (about 10 s) - it powers the Starlink
Mini down and back up. The output is always restored, including on error.
"""
import asyncio, statistics, sys, time
from bleak import BleakClient, BleakScanner

SVC     = "00005301-0000-1000-8000-00805f9b34fb"
CHR_CMD = "00004302-0000-1000-8000-00805f9b34fb"
CHR_DC  = "00004304-0000-1000-8000-00805f9b34fb"

def f16(r):
    m, e = r & 0x0FFF, r >> 12
    return (m - 0x1000 if m & 0x0800 else m) * (10 ** (e - 0x10 if e & 0x08 else e))

def dc(b):
    st = b[1] - 256 if b[1] > 127 else b[1]
    return b[0] == 1, st, f16(int.from_bytes(b[2:4], 'little')), \
           f16(int.from_bytes(b[4:6], 'little')), f16(int.from_bytes(b[6:8], 'little'))

async def sample(c, seconds, hz=4):
    out, t0 = [], time.time()
    while time.time() - t0 < seconds:
        try:
            out.append(dc(await c.read_gatt_char(CHR_DC)))
        except Exception:
            pass
        await asyncio.sleep(1.0 / hz)
    return out

def show(label, rows):
    if not rows:
        print(f"  {label}: no samples"); return
    v = statistics.mean(r[2] for r in rows); a = statistics.mean(r[3] for r in rows)
    w = statistics.mean(r[4] for r in rows)
    print(f"  {label}: V={v:.3f}  A={a:.3f}  W={w:.2f}   ({len(rows)} samples)")
    return v, a, w

async def main():
    print("locating the pack…", flush=True)
    dev = None
    for _ in range(10):
        found = await BleakScanner.discover(timeout=6, return_adv=True)
        for d, a in found.values():
            if SVC in [str(u).lower() for u in (a.service_uuids or [])]:
                dev = d; break
        if dev: break
    if not dev:
        print("pack not advertising — disconnect the app first"); sys.exit(1)
    print(f"found {dev.name}\n")

    async with BleakClient(dev, timeout=30) as c:
        cmd = c.services.get_characteristic(CHR_CMD)
        restored = False
        try:
            print("=== loaded, before (baseline) ===")
            before = await sample(c, 4)
            b = show("loaded  ", before)

            print("\n=== switching DC output OFF ===")
            await c.write_gatt_char(cmd, bytearray([0x01, 0x01, 0x00]), response=True)
            await asyncio.sleep(0.4)
            print("  (letting the voltage rebound)")
            rest_rows = await sample(c, 9)
            # the last few samples are the settled ones
            settled = rest_rows[-int(len(rest_rows) * 0.4):] if len(rest_rows) >= 5 else rest_rows
            ok = [r for r in settled if r[3] < 0.05]
            show("all off ", rest_rows)
            r = show("resting ", settled)
            if not ok:
                print("  WARNING: current not near zero while 'off'; resting voltage unreliable")

            print("\n=== switching DC output back ON ===")
            await c.write_gatt_char(cmd, bytearray([0x01, 0x01, 0x01]), response=True)
            restored = True
            await asyncio.sleep(4)
            after = await sample(c, 5)
            a = show("loaded  ", after)

            print("\n=== result ===")
            if not (b and a and r):
                print("  insufficient data"); return
            v_loaded = (b[0] + a[0]) / 2
            i_loaded = (b[1] + a[1]) / 2
            v_rest = r[0]
            if i_loaded < 0.2:
                print(f"  load too small ({i_loaded:.2f} A) to resolve resistance")
            drop = v_rest - v_loaded
            print(f"  resting  {v_rest:.3f} V")
            print(f"  loaded   {v_loaded:.3f} V  at {i_loaded:.3f} A")
            print(f"  drop     {drop:.3f} V")
            if i_loaded > 0.2:
                R = drop / i_loaded
                print(f"  => internal resistance R = {R*1000:.0f} mOhm  ({R:.4f} ohm)")
                print(f"     (earlier V/I fit estimate: 181 mOhm)")
            cell = v_rest / 5
            print(f"  resting cell voltage {cell:.3f} V")
            print("  -> update R_OHM_AT_2_PACKS in soc.js with the value above")
        finally:
            if not restored:
                print("\n!! restoring DC output")
                try:
                    await c.write_gatt_char(cmd, bytearray([0x01, 0x01, 0x01]), response=True)
                    print("   DC output restored")
                except Exception as e:
                    print(f"   RESTORE FAILED: {e} — hold the power button 2s")

asyncio.run(main())
