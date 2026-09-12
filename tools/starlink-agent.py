#!/usr/bin/env python3
"""Starlink reliability agent — local helper for the Starlink Test web app.

Why a local agent exists: the dish exposes its API over gRPC-Web on
http://192.168.100.1:9201, but a page hosted on HTTPS cannot call it (mixed
content) and the endpoint answers OPTIONS with 405, so no CORS preflight can
succeed. Browsers also cannot send ICMP. This agent runs on your machine, talks
to the dish, and runs real pings.

It serves the UI at http://localhost:8790/ and proxies:

    GET /api/health                 agent + dish reachability
    GET /api/status                 full dish telemetry (decoded JSON)
    GET /api/ping?host=&count=      real ICMP ping (system ping)

Stdlib only. Run it with any Python 3.9+.

    python3 tools/starlink-agent.py                 # localhost only
    python3 tools/starlink-agent.py --lan           # also reachable from your phone
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI_DIR = ROOT / "starlink"

DISH_DEFAULT = "192.168.100.1"
GWEB_PORT = 9201
HANDLE_PATH = "/SpaceX.API.Device.Device/Handle"

# Field 1004 in Request{get_status} -> Response{dish_get_status = 2004}
FIELD_GET_STATUS = 1004
FIELD_DISH_GET_STATUS = 2004


# ---------------------------------------------------------------------------
# minimal protobuf / gRPC-Web codec
# ---------------------------------------------------------------------------

def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | 0x80 if n else b)
        if not n:
            return bytes(out)


def _read_varint(buf: bytes, i: int):
    n = shift = 0
    while True:
        b = buf[i]
        i += 1
        n |= (b & 0x7F) << shift
        if not b & 0x80:
            return n, i
        shift += 7


def _len_delim(field: int, payload: bytes) -> bytes:
    return _varint((field << 3) | 2) + _varint(len(payload)) + payload


def _decode(buf: bytes, schema: dict) -> dict:
    """Decode a protobuf message using {field_number: (name, type, subschema)}.

    Unknown fields are consumed and skipped so the decoder stays robust across
    firmware revisions.
    """
    out: dict = {}
    i = 0
    while i < len(buf):
        tag, i = _read_varint(buf, i)
        f, w = tag >> 3, tag & 7
        entry = schema.get(f)
        name = entry[0] if entry else None
        kind = entry[1] if entry else None
        sub = entry[2] if entry and len(entry) > 2 else None
        if w == 0:
            v, i = _read_varint(buf, i)
            if name:
                if kind == "i32":            # protobuf int32 arrives as a uint64 varint
                    v &= 0xFFFFFFFF
                    if v >= 0x80000000:
                        v -= 0x100000000
                out[name] = v
        elif w == 1:
            if name:
                out[name] = struct.unpack("<d", buf[i:i + 8])[0]
            i += 8
        elif w == 5:
            if name:
                out[name] = struct.unpack("<f", buf[i:i + 4])[0]
            i += 4
        elif w == 2:
            ln, i = _read_varint(buf, i)
            chunk, i = buf[i:i + ln], i + ln
            if name:
                if kind == "m":
                    out[name] = _decode(chunk, sub or {})
                elif kind == "s":
                    out[name] = chunk.decode("utf-8", "replace")
                elif kind == "b":
                    out[name] = chunk.hex()
                else:
                    out[name] = chunk.hex()
        else:
            raise ValueError(f"unsupported wire type {w}")
    return out


DEVICE_INFO = {
    1: ("id", "s"), 2: ("hardware_version", "s"), 3: ("software_version", "s"),
    4: ("country_code", "s"), 5: ("utc_offset_s", "i32"), 8: ("bootcount", "v"),
    12: ("generation_number", "v"), 14: ("board_rev", "i32"), 15: ("build_id", "s"),
}
DEVICE_STATE = {1: ("uptime_s", "v")}
OBSTRUCTION = {
    1: ("fraction_obstructed", "f"), 4: ("valid_s", "f"),
    5: ("currently_obstructed", "v"), 6: ("avg_prolonged_obstruction_duration_s", "f"),
    7: ("avg_prolonged_obstruction_interval_s", "f"),
    8: ("avg_prolonged_obstruction_valid", "v"), 9: ("time_obstructed", "f"),
    10: ("patches_valid", "v"),
}
DISH_STATUS = {
    1: ("device_info", "m", DEVICE_INFO),
    2: ("device_state", "m", DEVICE_STATE),
    1004: ("obstruction_stats", "m", OBSTRUCTION),
    1002: ("seconds_to_first_nonempty_slot", "f"),
    1003: ("pop_ping_drop_rate", "f"),
    1007: ("downlink_throughput_bps", "f"),
    1008: ("uplink_throughput_bps", "f"),
    1009: ("pop_ping_latency_ms", "f"),
    1011: ("boresight_azimuth_deg", "f"),
    1012: ("boresight_elevation_deg", "f"),
    1016: ("eth_speed_mbps", "i32"),
    1018: ("is_snr_above_noise_floor", "v"),
    1020: ("class_of_service", "v"),
    1022: ("is_snr_persistently_low", "v"),
}


def _grpc_web_call(host: str, path: str, message: bytes, timeout: float = 6.0):
    """POST one gRPC-Web framed message; return the response message bytes."""
    frame = b"\x00" + len(message).to_bytes(4, "big") + message
    req = urllib.request.Request(
        f"http://{host}:{GWEB_PORT}{path}", data=frame, method="POST",
        headers={"Content-Type": "application/grpc-web+proto",
                 "X-Grpc-Web": "1", "Accept": "application/grpc-web+proto"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        status = resp.headers.get("grpc-status")

    # gRPC-Web body = one or more [flag][len][payload] frames; 0x80 marks trailers.
    i, data_frames = 0, []
    while i + 5 <= len(body):
        flag = body[i]
        ln = int.from_bytes(body[i + 1:i + 5], "big")
        chunk = body[i + 5:i + 5 + ln]
        i += 5 + ln
        if flag & 0x80:
            m = re.search(rb"grpc-status:\s*(\d+)", chunk)
            if m:
                status = m.group(1).decode()
            m = re.search(rb"grpc-message:\s*([^\r\n]+)", chunk)
            if m and status not in (None, "0"):
                raise RuntimeError(f"grpc {status}: {m.group(1).decode('utf-8', 'replace')}")
        else:
            data_frames.append(chunk)

    if not data_frames:
        raise RuntimeError(f"no data frame (grpc-status={status})")
    return data_frames[0]


def dish_status(host: str = DISH_DEFAULT, timeout: float = 6.0) -> dict:
    """Fetch and decode DishGetStatus."""
    req = _len_delim(FIELD_GET_STATUS, b"")
    reply = _grpc_web_call(host, HANDLE_PATH, req, timeout)

    i = 0
    payload = None
    while i < len(reply):
        tag, i = _read_varint(reply, i)
        f, w = tag >> 3, tag & 7
        if w == 0:
            _, i = _read_varint(reply, i)
        elif w == 2:
            ln, i = _read_varint(reply, i)
            chunk, i = reply[i:i + ln], i + ln
            if f == FIELD_DISH_GET_STATUS:
                payload = chunk
        else:
            raise ValueError(f"unexpected wire type {w} at top level")
    if payload is None:
        raise RuntimeError("response carried no dishGetStatus")

    return _decode(payload, DISH_STATUS)


# ---------------------------------------------------------------------------
# ping
# ---------------------------------------------------------------------------

PING_SUMMARY = re.compile(
    r"(\d+) packets transmitted,\s*(\d+) (?:packets )?received.*?([\d.]+)% packet loss", re.S)
PING_RTT = re.compile(r"=\s*([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+)\s*ms")


def ping(host: str, count: int = 5, timeout_ms: int = 1500) -> dict:
    """Real ICMP ping via the system binary."""
    count = max(1, min(int(count), 20))
    cmd = ["/sbin/ping", "-c", str(count), "-i", "0.3", "-W", str(timeout_ms), host]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=count * 2 + 6)
        out = (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return {"host": host, "ok": False, "error": "ping timed out", "raw": ""}

    res = {"host": host, "ok": False, "transmitted": None, "received": None,
           "loss_pct": None, "min_ms": None, "avg_ms": None, "max_ms": None,
           "jitter_ms": None, "elapsed_s": round(time.time() - t0, 3)}
    m = PING_SUMMARY.search(out)
    if m:
        res["transmitted"] = int(m.group(1))
        res["received"] = int(m.group(2))
        res["loss_pct"] = float(m.group(3))
    m = PING_RTT.search(out)
    if m:
        res["min_ms"], res["avg_ms"], res["max_ms"], res["jitter_ms"] = (float(g) for g in m.groups())
    res["ok"] = bool(res["received"])
    if not res["ok"] and not m:
        res["error"] = out.strip().splitlines()[0] if out.strip() else "no response"
    return res


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(UI_DIR), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)

        # Accept both http://host:8790/ and http://host:8790/starlink/ so the
        # agent URL and the hosted-app URL can't be mixed up into a 404.
        route = u.path
        if route == "/starlink" or route.startswith("/starlink/"):
            route = route[len("/starlink"):] or "/"

        if route == "/api/health":
            dish_ok, detail = False, None
            try:
                dish_status(self.server.dish_host, timeout=3.0)
                dish_ok = True
            except Exception as e:
                detail = f"{type(e).__name__}: {e}"
            return self._json({
                "agent": True, "version": 1,
                "dish_host": self.server.dish_host,
                "dish_reachable": dish_ok, "dish_error": detail,
                "time": time.time(),
            })

        if route == "/api/status":
            try:
                st = dish_status(self.server.dish_host)
                st["ok"] = True
                st["fetched_at"] = time.time()
                return self._json(st)
            except Exception as e:
                return self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 502)

        if route == "/api/ping":
            q = parse_qs(u.query)
            host = (q.get("host") or ["1.1.1.1"])[0]
            if not re.fullmatch(r"[A-Za-z0-9_.:\-]{1,80}", host):
                return self._json({"ok": False, "error": "invalid host"}, 400)
            count = int((q.get("count") or ["5"])[0])
            return self._json(ping(host, count))

        if route == "/":
            route = "/index.html"
        self.path = route
        if route.startswith("/icons/") or route.startswith("/icons?"):
            # shared icons live at the repo root, one level above the UI dir
            self.directory = str(ROOT)
        return super().do_GET()


def main():
    ap = argparse.ArgumentParser(description="Starlink reliability agent")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--lan", action="store_true", help="bind 0.0.0.0 so your phone can use it")
    ap.add_argument("--dish", default=DISH_DEFAULT)
    a = ap.parse_args()

    bind = "0.0.0.0" if a.lan else a.host
    srv = ThreadingHTTPServer((bind, a.port), Handler)
    srv.dish_host = a.dish

    print(f"Starlink agent  ->  http://localhost:{a.port}/")
    if a.lan:
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("1.1.1.1", 80))
            print(f"                  http://{s.getsockname()[0]}:{a.port}/   (for your phone)")
            s.close()
        except Exception:
            pass
    try:
        st = dish_status(a.dish, timeout=4)
        di = st.get("device_info", {})
        print(f"dish reachable  ->  {di.get('hardware_version', '?')} "
              f"fw {di.get('software_version', '?')} "
              f"latency {st.get('pop_ping_latency_ms', 0):.1f} ms")
    except Exception as e:
        print(f"dish NOT reachable at {a.dish}: {type(e).__name__}: {e}")
        print("  (the app still works for internet probes and ping)")
    print("\nCtrl-C to stop.\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
