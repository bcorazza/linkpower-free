#!/usr/bin/env python3
"""Live BLE watcher for the PeakDo LinkPower Pack.

Prints every device the moment it is first seen, so you can press the pack's
power button three times and watch whether its Bluetooth actually turns on.

    ./.venv/bin/python tools/scan-live.py            # runs until Ctrl-C
    ./.venv/bin/python tools/scan-live.py --seconds 900 --log /tmp/lp.log
"""
import argparse, asyncio, sys, time
from datetime import datetime
from bleak import BleakScanner

HINTS = ('link', 'pack', 'peak', 'bp4', 'sl3', 'power', 'lp1', 'lp2', 'dock')
LP_SERVICE = '00005301-0000-1000-8000-00805f9b34fb'

def stamp():
    return datetime.now().strftime('%H:%M:%S')

async def run(seconds, out):
    seen = {}
    def emit(line):
        print(line, flush=True)
        if out:
            out.write(line + '\n'); out.flush()

    def cb(device, adv):
        if device.address in seen:
            seen[device.address][1] = adv.rssi
            # The pack often advertises with no local name and supplies it only
            # in the scan response. Record the name when it finally shows up.
            if device.name and not seen[device.address][0]:
                seen[device.address][0] = device.name
                uuids = [str(u).lower() for u in (adv.service_uuids or [])]
                emit(f'[{stamp()}] name resolved        {adv.rssi:>5} dBm  {device.name}'
                     f'{"  svc=" + ",".join(uuids) if uuids else ""}')
            return
        name = device.name or ''
        uuids = [str(u).lower() for u in (adv.service_uuids or [])]
        mfr = sorted((adv.manufacturer_data or {}).keys())
        seen[device.address] = [name, adv.rssi]
        hit = (any(h in name.lower() for h in HINTS) or LP_SERVICE in uuids)
        tag = '*** LINKPOWER CANDIDATE' if hit else 'new'
        emit(f'[{stamp()}] {tag:<22} {adv.rssi:>5} dBm  {name or "(no name)"}'
             f'{"  svc=" + ",".join(uuids) if uuids else ""}'
             f'{"  mfr=" + str(mfr) if mfr else ""}')
        if hit:
            emit(f'[{stamp()}]     full adv: local_name={adv.local_name!r} tx_power={adv.tx_power}'
                 f' uuids={uuids} mfr={adv.manufacturer_data}')
            emit(f'[{stamp()}] *** MATCH FOUND — connect from the web app now; it advertises'
                 f' {"WITH a name" if name else "with NO name (use the service filter, not the name)"}')

    emit(f'[{stamp()}] watching for BLE devices… press the power button 3x on the LinkPower Pack NOW')
    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    start = time.time()
    try:
        while time.time() - start < seconds:
            await asyncio.sleep(15)
            matches = [v[0] for v in seen.values() if v[0] and any(h in v[0].lower() for h in HINTS)]
            emit(f'[{stamp()}] heartbeat — {len(seen)} devices seen so far'
                 + (f' | MATCHES: {matches}' if matches else ' | no LinkPower Pack yet'))
    finally:
        await scanner.stop()
    emit(f'[{stamp()}] done — {len(seen)} devices total')

ap = argparse.ArgumentParser()
ap.add_argument('--seconds', type=float, default=0, help='0 = run until Ctrl-C')
ap.add_argument('--log', default=None)
a = ap.parse_args()
fh = open(a.log, 'w') if a.log else None
try:
    asyncio.run(run(a.seconds or 1e9, fh))
except KeyboardInterrupt:
    print('\nstopped')
