// LinkPower Free — web Bluetooth monitor/control for PeakDo Link-Power hardware.
// Protocol extracted from PeakDo's own public Web Bluetooth app; see PROTOCOL.md.

// --------------------------------------------------------------------------
// Protocol constants
// --------------------------------------------------------------------------
const SVC_LINKPOWER = 0x5301;   // 00005301-0000-1000-8000-00805f9b34fb
const CHR_OTA       = 0x4301;
const CHR_LINKPOWER = 0x4302;   // command in, response out
const CHR_EXT_BAT   = 0x4303;   // notify
const CHR_DC_PORT   = 0x4304;   // notify
const CHR_TYPEC     = 0x4305;   // notify
const CHR_FACTORY   = 0x4310;

const CMD = Object.freeze({
  DC_CONTROL:0x01, TYPEC_POWER_LIMIT:0x02, BARRIER_FREE_MODE:0x03, BLE_PIN:0x04,
  SCHEDULED_ON_OFF:0x06, DEVICE_ID:0x10, RESTART:0x11, TYPEC_CONTROL:0x13,
  DC_BYPASS_CONTROL:0x14, DC_BYPASS_THRESHOLD:0x15, GET_USB_FW_VERSION:0x17,
  LCD_BRIGHTNESS_CTL:0x19, BLUETOOTH_CTL:0x20, RUNNING_MODE_CONTROL:0xE0,
  TEST:0xF0, FEATURES:0xFE
});
const ACT = Object.freeze({ GET:0x00, SET:0x01, DEL:0x02 });

const SAMPLE_MS = 1000;
const POLL_MS = 2000;          // this firmware notifies on change, not on a timer
const CHART_POINTS = 120;

// --------------------------------------------------------------------------
// "BLE float16": 12-bit signed mantissa x 10^(4-bit signed exponent), LE.
// --------------------------------------------------------------------------
function parseBLEFloat16(raw) {
  const mRaw = raw & 0x0FFF;
  const eRaw = raw >> 12;
  const mantissa = (mRaw & 0x0800) ? mRaw - 0x1000 : mRaw;
  const exponent = (eRaw & 0x08) ? eRaw - 0x10 : eRaw;
  return mantissa * Math.pow(10, exponent);
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
const S = {
  device: null, server: null, chars: {}, demo: false, model: null,
  connectedAt: null, lastSampleAt: null, energyWh: 0, peakW: 0, samples: 0,
  samplesData: [],          // { t, dc, bat, level }
  wakeLock: null, alerted: false, autoOffFired: false,
  dc:  { enabled:null, status:null, voltage:null, current:null, power:null, bypass:null },
  bat: { enabled:null, status:null, isFull:null, level:null, voltage:null, current:null,
         power:null, remain:null, capacity:null, maxCapacity:null },
  tc:  { enabled:null, status:null, voltage:null, current:null, power:null, temperature:null }
};

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------
function log(msg, obj) {
  const el = $('log');
  const t = new Date().toLocaleTimeString([], { hour12:false });
  let line = t + '  ' + msg;
  if (obj !== undefined) {
    try { line += '\n         ' + JSON.stringify(obj); } catch (e) { line += '\n         [unserializable]'; }
  }
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
  $('logCount').textContent = el.textContent.split('\n').length - 1;
}

function banner(kind, text) {
  const b = $('banner');
  if (!text) { b.className = 'hidden'; b.textContent = ''; return; }
  b.className = kind;
  b.textContent = text;
}

const toHex = (dv) => Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))
  .map((b) => b.toString(16).padStart(2, '0')).join(' ');

function fmt(v, digits, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--' + (unit ? ' ' + unit : '');
  return v.toFixed(digits).replace(/\.?0+$/, '') + (unit ? ' ' + unit : '');
}

function fmtDuration(minutes) {
  if (!minutes || minutes <= 0 || Number.isNaN(minutes)) return '--';
  const h = Math.floor(minutes / 60), m = Math.round(minutes % 60);
  return h + 'h ' + String(m).padStart(2, '0') + 'm';
}

// protocol maps status -1 -> 2, so: 0 idle, 1 charging, 2 discharging
const flowInfo = (s) => (s === 1 ? ['chg','▲ charging'] : s === 2 ? ['dis','▼ discharging'] : ['','idle']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Render a thrown value with as much detail as the platform gives us —
 *  DOMException name matters: SecurityError means pairing/PIN, not a bad frame. */
function describeError(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  const bits = [];
  if (e.name) bits.push(e.name);
  if (e.message) bits.push(e.message);
  if (e.code !== undefined && e.code !== null) bits.push('code=' + e.code);
  return bits.length ? bits.join(': ') : String(e);
}

function isAuthError(e) {
  const t = (e && (e.name || '') + ' ' + (e.message || '')) + ' ' + String(e);
  return /security|auth|pin|not.?permitted|insufficient|encrypt/i.test(t);
}

/** Characteristics this model doesn't implement (the Pack has no pack-gauge
 *  or USB-C telemetry — only the DC port). */
const MISSING = new Set();

function markMissing(uuid) { MISSING.add(uuid); render(); }

// --------------------------------------------------------------------------
// GATT plumbing
// --------------------------------------------------------------------------
async function getChar(uuid) {
  if (S.chars[uuid]) return S.chars[uuid];
  const svc = await S.server.getPrimaryService(SVC_LINKPOWER);
  const c = await svc.getCharacteristic(uuid);
  S.chars[uuid] = c;
  return c;
}

/** Write a command frame to 0x4302 and read the response back. */
async function send(bytes, readBack = true) {
  const c = await getChar(CHR_LINKPOWER);
  const payload = new Uint8Array(bytes);
  log('→ write 0x4302', toHex(new DataView(payload.buffer)));
  try {
    await c.writeValueWithoutResponse(payload);
  } catch (e) {
    try {
      await c.writeValueWithResponse(payload);
    } catch (e2) {
      if (/security|auth|pin|not.?permitted|insufficient/i.test(e2.message || '')) {
        banner('warn', 'This action needs pairing. Enter the device PIN 020555 when your OS asks, then try again.');
      }
      throw e2;
    }
  }
  if (!readBack) return null;
  // Observed ACK: 01 81 00  ->  [opcode, 0x80|SET, status]   (status 0 = OK)
  // The firmware needs a beat between write and read; retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(attempt === 0 ? 90 : 250);
    try {
      const v = await c.readValue();
      log('← read  0x4302', toHex(v));
      return v;
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
}

async function readChar(uuid, quiet = false) {
  const c = await getChar(uuid);
  const v = await c.readValue();
  if (!quiet) log('← read  0x' + uuid.toString(16), toHex(v));
  return v;
}

async function subscribe(uuid, handler) {
  const c = await getChar(uuid);
  await c.startNotifications();
  c.addEventListener('characteristicvaluechanged', (e) => handler(e.target.value));
  handler(await c.readValue());
}

// --------------------------------------------------------------------------
// Telemetry frame parsers
// --------------------------------------------------------------------------
function parseExtBatteryInfo(dv) {
  if (dv.byteLength < 16) return;
  S.bat.enabled = dv.getInt8(0);
  const st = dv.getInt8(1);
  S.bat.status = st === -1 ? 2 : st;
  S.bat.isFull = dv.getUint8(2) === 1;
  S.bat.maxCapacity = parseBLEFloat16(dv.getUint16(3, true));
  S.bat.capacity    = parseBLEFloat16(dv.getUint16(5, true));
  S.bat.level       = dv.getUint8(7);
  S.bat.voltage     = parseBLEFloat16(dv.getUint16(8, true));
  S.bat.current     = parseBLEFloat16(dv.getUint16(10, true));
  S.bat.power       = parseBLEFloat16(dv.getUint16(12, true));
  S.bat.remain      = dv.getUint16(14, true);
  render();
}

function parseDcPortStatus(dv) {
  if (dv.byteLength < 8) return;
  S.dc.enabled = dv.getUint8(0) === 1;
  const st = dv.getInt8(1);
  S.dc.status  = st === -1 ? 2 : st;
  S.dc.voltage = parseBLEFloat16(dv.getUint16(2, true));
  S.dc.current = parseBLEFloat16(dv.getUint16(4, true));
  S.dc.power   = parseBLEFloat16(dv.getUint16(6, true));
  S.dc.bypass  = dv.byteLength >= 9 ? !!dv.getUint8(8) : null;
  render();
  sample();
}

function parseTypeCPortStatus(dv) {
  if (dv.byteLength < 10) return;
  S.tc.enabled = dv.getUint8(0);
  const st = dv.getInt8(1);
  S.tc.status = st === -1 ? 2 : st;
  S.tc.voltage     = parseBLEFloat16(dv.getUint16(2, true));
  S.tc.current     = parseBLEFloat16(dv.getUint16(4, true));
  S.tc.power       = parseBLEFloat16(dv.getUint16(6, true));
  S.tc.temperature = parseBLEFloat16(dv.getUint16(8, true));
  render();
}

// --------------------------------------------------------------------------
// Sampling, energy and chart
// --------------------------------------------------------------------------
function sample() {
  const now = Date.now();
  // Rate-limit: notifications can burst, and the 1s UI tick also samples.
  if (now - (S.lastSampleAt || 0) < 500) return;
  const w = Math.abs(S.dc.power || 0);
  if (S.lastSampleAt) {
    const dtH = (now - S.lastSampleAt) / 3600000;
    if (dtH > 0 && dtH < 0.05) S.energyWh += w * dtH;
  }
  S.lastSampleAt = now;
  S.peakW = Math.max(S.peakW, w);
  S.samples++;
  S.samplesData.push({ t: now, dc: w, bat: Math.abs(S.bat.power || 0), level: S.bat.level });
  if (S.samplesData.length > CHART_POINTS) S.samplesData.shift();
}

function drawChart() {
  const cv = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 120;
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr; cv.height = h * dpr;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const data = S.samplesData;
  const maxW = Math.max(40, ...data.map((d) => d.dc)) * 1.15;
  const pad = 4;

  // gridlines
  ctx.strokeStyle = '#202b36'; ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const y = Math.round(pad + ((h - pad * 2) * i) / 2) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.fillStyle = '#6b7d90'; ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.fillText(maxW.toFixed(0) + ' W', 4, 12);

  if (data.length < 2) return;

  const xFor = (i) => (i / (CHART_POINTS - 1)) * w;
  const yFor = (v) => h - pad - (v / maxW) * (h - pad * 2);

  // filled area
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(56,189,248,.35)');
  grad.addColorStop(1, 'rgba(56,189,248,0)');
  ctx.beginPath();
  ctx.moveTo(xFor(0), h);
  data.forEach((d, i) => ctx.lineTo(xFor(i), yFor(d.dc)));
  ctx.lineTo(xFor(data.length - 1), h);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // line
  ctx.beginPath();
  data.forEach((d, i) => (i ? ctx.lineTo(xFor(i), yFor(d.dc)) : ctx.moveTo(xFor(i), yFor(d.dc))));
  ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
  ctx.lineJoin = 'round'; ctx.stroke();

  // battery level trace (violet, 0-100%)
  if (data.some((d) => d.level !== null && d.level !== undefined)) {
    ctx.beginPath();
    let started = false;
    data.forEach((d, i) => {
      if (d.level === null || d.level === undefined) return;
      const y = h - pad - (d.level / 100) * (h - pad * 2);
      if (!started) { ctx.moveTo(xFor(i), y); started = true; } else { ctx.lineTo(xFor(i), y); }
    });
    ctx.strokeStyle = 'rgba(167,139,250,.65)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.stroke(); ctx.setLineDash([]);
  }
}

// --------------------------------------------------------------------------
// Render
// --------------------------------------------------------------------------
function render() {
  $('dcPower').textContent = S.dc.power === null ? '--' : Math.abs(S.dc.power).toFixed(1);
  $('dcVolt').textContent  = fmt(S.dc.voltage, 2, 'V');
  $('dcAmp').textContent   = fmt(S.dc.current, 2, 'A');

  const stEl = $('dcState');
  if (S.dc.enabled === null) { stEl.className = 'pill'; stEl.textContent = 'unknown'; }
  else {
    stEl.className = 'pill ' + (S.dc.enabled ? 'on' : '');
    stEl.textContent = S.dc.enabled ? 'output on' : 'output off';
  }
  const f = flowInfo(S.dc.status);
  $('dcFlow').className = 'pill ' + f[0];
  $('dcFlow').textContent = f[1];
  $('dcBypass').classList.toggle('hidden', !S.dc.bypass);

  $('batPower').textContent = S.bat.power === null ? '--' : Math.abs(S.bat.power).toFixed(1);
  $('batLevel').textContent = S.bat.level === null || S.bat.level === undefined ? '-- %' : S.bat.level + ' %';
  $('batVolt').textContent  = fmt(S.bat.voltage, 2, 'V');
  $('batAmp').textContent   = fmt(S.bat.current, 2, 'A');
  $('batRemain').textContent = fmtDuration(S.bat.remain);
  $('batCap').textContent = (S.bat.capacity === null)
    ? '--'
    : Math.round(S.bat.capacity) + (S.bat.maxCapacity ? ' / ' + Math.round(S.bat.maxCapacity) : '') + ' Wh';
  $('batFlow').textContent = S.bat.isFull ? 'full' : flowInfo(S.bat.status)[1];

  $('tcPower').textContent = S.tc.power === null ? '--' : Math.abs(S.tc.power).toFixed(1);
  $('tcVolt').textContent  = fmt(S.tc.voltage, 2, 'V');
  $('tcAmp').textContent   = fmt(S.tc.current, 2, 'A');
  $('tcTemp').textContent  = fmt(S.tc.temperature, 1, '°C');
  $('tcFlow').textContent  = S.tc.enabled === 0 ? 'off' : flowInfo(S.tc.status)[1];

  $('energy').textContent = S.energyWh.toFixed(2) + ' Wh';
  $('peak').textContent   = S.peakW ? S.peakW.toFixed(1) + ' W' : '-- W';
  $('samples').textContent = String(S.samples);
  if (S.dc.power !== null) {
    $('chartInfo').textContent = new Date().toLocaleTimeString([], { hour12:false });
  }

  $('badgeBat').classList.toggle('hidden', !MISSING.has(CHR_EXT_BAT));
  $('badgeTc').classList.toggle('hidden', !MISSING.has(CHR_TYPEC));
  $('badgeDc').classList.toggle('hidden', !MISSING.has(CHR_DC_PORT));

  const live = S.demo || !!S.device;
  $('btnDcOn').disabled = !live;
  $('btnDcOff').disabled = !live;

  drawChart();
}

function renderDevice(info) {
  $('devInfo').innerHTML = Object.entries(info)
    .map(([k, v]) => '<div class="k">' + k + '</div><div class="v">' + (v ?? '—') + '</div>')
    .join('');
  $('deviceCard').classList.remove('hidden');
}

// --------------------------------------------------------------------------
// Device information + GATT dump
// --------------------------------------------------------------------------
async function loadDeviceInfo() {
  const out = {};
  const fields = [
    ['Model', 'model_number_string'], ['Firmware', 'firmware_revision_string'],
    ['Hardware', 'hardware_revision_string'], ['Software', 'software_revision_string'],
    ['Manufacturer', 'manufacturer_name_string']
  ];
  try {
    const svc = await S.server.getPrimaryService('device_information');
    for (const [label, uuid] of fields) {
      try {
        const c = await svc.getCharacteristic(uuid);
        out[label] = new TextDecoder().decode(await c.readValue()).replace(/\0/g, '').trim() || '—';
      } catch (e) { out[label] = '—'; }
    }
  } catch (e) {
    log('device_information unavailable: ' + e.message);
    out['Model'] = '—';
  }
  S.model = out['Model'];
  renderDevice(out);
  log('device info', out);
}

async function dumpGatt() {
  if (!S.server) return;
  log('--- GATT tree ---');
  try {
    const services = await S.server.getPrimaryServices();
    for (const svc of services) {
      log('service ' + svc.uuid);
      try {
        const chars = await svc.getCharacteristics();
        for (const ch of chars) {
          const props = [];
          if (ch.properties.read) props.push('read');
          if (ch.properties.write) props.push('write');
          if (ch.properties.writeWithoutResponse) props.push('writeNR');
          if (ch.properties.notify) props.push('notify');
          if (ch.properties.indicate) props.push('indicate');
          log('   char ' + ch.uuid + '  [' + props.join(',') + ']');
        }
      } catch (e) { log('   (characteristics unavailable: ' + e.message + ')'); }
    }
  } catch (e) { log('GATT dump failed: ' + e.message); }
  banner('info', 'GATT tree written to the log.');
}

// --------------------------------------------------------------------------
// Connect / disconnect
// --------------------------------------------------------------------------
async function connect() {
  if (!navigator.bluetooth) {
    banner('bad', 'This browser has no Web Bluetooth. Use desktop Chrome/Edge, Android Chrome, or Bluefy on iPhone.');
    return;
  }
  banner(null, null);
  const all = $('chkAll').checked;
  const optional = [
    0x5301, CHR_OTA, CHR_LINKPOWER, CHR_EXT_BAT, CHR_DC_PORT, CHR_TYPEC, CHR_FACTORY,
    'device_information', 'battery_service', 'current_time'
  ];
  try {
    $('status').textContent = 'scanning…';
    const opts = all
      ? { acceptAllDevices: true, optionalServices: optional }
      : { filters: [
            { services:[SVC_LINKPOWER] },
            { namePrefix:'Link' },        // "Link-Power" (LP1/2/3) and "Link Power Pack" (dock)
            { namePrefix:'LinkPower' },
            { namePrefix:'BP4SL3' }
          ],
          optionalServices: optional };
    const device = await navigator.bluetooth.requestDevice(opts);
    await attach(device);
  } catch (e) {
    if (String(e.name) === 'NotFoundError') { $('status').textContent = 'cancelled'; return; }
    log('connect failed: ' + e.message);
    banner('warn', 'Connection failed: ' + e.message);
    $('status').className = 'pill err';
    $('status').textContent = 'error';
  }
}

async function reconnect() {
  try {
    if (!navigator.bluetooth.getDevices) {
      log('getDevices() unsupported here — falling back to a scan');
      connect(); return;
    }
    const devices = await navigator.bluetooth.getDevices();
    log('previously permitted devices: ' + devices.length);
    if (!devices.length) {
      banner('info', 'No previously-permitted device on this browser. Falling back to a scan — '
                   + 'if the list is empty, the pack is still held by another client or its '
                   + 'Bluetooth is off (triple-press the power button).');
      connect(); return;
    }
    await attach(devices[0]);
  } catch (e) {
    log('reconnect failed -> ' + describeError(e));
    connect();
  }
}

/** A BLE peripheral that is already connected to this Mac stops advertising, so
 *  no scan can ever find it. getDevices() can still hand it back. */
async function checkKnownDevices() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  try {
    const devices = await navigator.bluetooth.getDevices();
    if (devices.length) {
      log('found previously-permitted device(s): ' + devices.map((d) => d.name || d.id).join(', '));
      banner('info', 'This browser already has permission for '
                   + (devices[0].name || 'a LinkPower device')
                   + '. Click "Reconnect (no scan)" — a connected device never advertises, '
                   + 'so scanning will not find it.');
    }
  } catch (e) { /* getDevices is best-effort */ }
}

async function attach(device) {
  S.device = device;
  S.chars = {};
  device.addEventListener('gattserverdisconnected', onDisconnected);

  $('status').textContent = 'connecting…';
  S.server = device.gatt;
  if (!S.server.connected) await S.server.connect();

  S.connectedAt = Date.now();
  S.lastSampleAt = null;
  $('status').className = 'pill on';
  $('status').textContent = device.name || 'connected';
  $('btnDisconnect').classList.remove('hidden');
  $('btnReconnect').classList.add('hidden');
  log('connected', { name: device.name, id: device.id });
  banner('ok', 'Connected' + (device.name ? ' to ' + device.name : '') + '.');

  await loadDeviceInfo();
  await startTelemetry();
  startPolling();
  await requestWakeLock();
}

async function startTelemetry() {
  const subs = [ [CHR_EXT_BAT, parseExtBatteryInfo], [CHR_DC_PORT, parseDcPortStatus],
                 [CHR_TYPEC, parseTypeCPortStatus] ];
  for (const [uuid, fn] of subs) {
    let ok = false;
    try { await readChar(uuid); ok = true; }
    catch (e) { log('read 0x' + uuid.toString(16) + ' failed -> ' + describeError(e)); }
    try { await subscribe(uuid, fn); log('subscribed 0x' + uuid.toString(16)); ok = true; }
    catch (e) { log('subscribe 0x' + uuid.toString(16) + ' failed -> ' + describeError(e)); }
    if (!ok) { markMissing(uuid); log('0x' + uuid.toString(16) + ' not implemented on this model'); }
  }
  try { await readChar(CHR_LINKPOWER, true); } catch (e) {}
  render();
}

function onDisconnected() {
  log('disconnected');
  S.server = null; S.chars = {};
  $('status').className = 'pill';
  $('status').textContent = 'disconnected';
  $('btnDisconnect').classList.add('hidden');
  stopPolling();
  $('btnReconnect').classList.remove('hidden');
  releaseWakeLock();
  render();
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------
let busy = false;
async function setDc(on) {
  if (S.demo) { S.dc.enabled = on; S.dc.status = on ? 2 : 0; render(); return; }
  if (busy) return;
  busy = true;
  try {
    await send([CMD.DC_CONTROL, ACT.SET, on ? 1 : 0]);
    S.autoOffFired = !on ? S.autoOffFired : false;
    await sleep(150);
    try { await readChar(CHR_DC_PORT); } catch (e) { log('post-toggle read failed -> ' + describeError(e)); }
    // Authoritative re-read of telemetry after a state change.
    if (S.dc.enabled !== on) {
      await sleep(250);
      try { await readChar(CHR_DC_PORT); } catch (e) { log('confirm read failed -> ' + describeError(e)); }
      if (S.dc.enabled !== on) {
        log('WARNING: DC state did not change after SET (requested ' + (on ? 'ON' : 'OFF') + ')');
        banner('warn', 'The command was accepted but the DC state did not change — the pack may need '
                     + 'pairing (PIN 020555) or may refuse this while another mode is active.');
      }
    }
    banner('ok', 'DC output commanded ' + (on ? 'ON' : 'OFF') + '.');
  } catch (e) {
    log('setDc failed -> ' + describeError(e));
    const msg = describeError(e);
    if (isAuthError(e)) {
      banner('warn', 'macOS is asking to pair for this action — enter PIN 020555, then press Power ON/OFF again.');
    } else {
      banner('warn', 'DC control failed: ' + msg);
    }
  } finally {
    busy = false;
  }
}

/** Query the device capability bitmask (0xFE GET). */
async function queryFeatures() {
  if (S.demo) { log('demo: features query'); return; }
  try {
    const v = await send([CMD.FEATURES, ACT.GET]);
    if (v && v.byteLength >= 7) {
      const flags = v.getUint32(3, true);
      log('features bitmask = 0x' + flags.toString(16));
      banner('info', 'Device capabilities: 0x' + flags.toString(16));
    } else if (v) {
      log('features response too short: ' + v.byteLength + ' bytes');
    }
  } catch (e) { banner('warn', 'Features query failed: ' + describeError(e)); }
}

/** 0x20 SET 1 switches the pack's own Bluetooth radio off. Useful to release
 *  the device from another client — but you must triple-press to get it back. */
async function turnOffDeviceBluetooth() {
  if (!confirm('Switch OFF the pack\'s Bluetooth radio?\n\nThis frees it from another client, '
             + 'but you will need to press the power button 3x again to reconnect.')) return;
  if (S.demo) { log('demo: bluetooth off'); return; }
  try {
    await send([CMD.BLUETOOTH_CTL, ACT.SET, 1], false);
    banner('warn', 'Bluetooth-off command sent. Triple-press the power button to bring it back.');
  } catch (e) { banner('warn', 'Bluetooth-off failed: ' + describeError(e)); }
}

async function restartDevice() {
  if (!confirm('Restart the pack?')) return;
  if (S.demo) { log('demo: restart'); return; }
  try {
    await send([CMD.RESTART, ACT.SET], false);
    banner('warn', 'Restart command sent.');
  } catch (e) { banner('warn', 'Restart failed: ' + describeError(e)); }
}

async function copyLog() {
  const text = $('log').textContent;
  try {
    await navigator.clipboard.writeText(text);
    banner('ok', 'Log copied to clipboard (' + text.split('\n').length + ' lines).');
  } catch (e) {
    const r = document.createRange();
    r.selectNodeContents($('log'));
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    banner('info', 'Clipboard blocked — log selected, press Cmd+C to copy.');
  }
}

async function sendRaw() {
  const raw = $('rawCmd').value.trim();
  if (!raw) return;
  const bytes = raw.split(/[\s,]+/).map((h) => parseInt(h, 16));
  if (bytes.some((b) => Number.isNaN(b) || b < 0 || b > 255)) { banner('warn', 'Invalid hex.'); return; }
  if (S.demo) { log('demo: would write', bytes); return; }
  try { await send(bytes); } catch (e) { banner('warn', 'Write failed: ' + describeError(e)); }
}

async function readAllTelemetry(quiet = false) {
  if (S.demo) { render(); return; }
  for (const uuid of [CHR_EXT_BAT, CHR_DC_PORT, CHR_TYPEC]) {
    if (MISSING.has(uuid)) continue;
    try { await readChar(uuid, quiet); }
    catch (e) {
      log('poll read 0x' + uuid.toString(16) + ' failed -> ' + describeError(e));
      markMissing(uuid);
    }
    await sleep(60);
  }
  render();
}

/** Evidence from real hardware: the DC-port characteristic carries no periodic
 *  notification, so polling is required for a live readout. */
let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (S.demo || !(S.device && S.server && S.server.connected) || busy) return;
    readAllTelemetry(true).catch((e) => log('poll failed -> ' + describeError(e)));
  }, POLL_MS);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// --------------------------------------------------------------------------
// Screen wake lock
// --------------------------------------------------------------------------
async function requestWakeLock() {
  if (!$('chkWake').checked) return;
  if (!('wakeLock' in navigator)) { log('screen wake lock not supported here'); return; }
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    $('wakePill').classList.remove('hidden');
    S.wakeLock.addEventListener('release', () => { $('wakePill').classList.add('hidden'); });
    log('screen wake lock acquired');
  } catch (e) { log('wake lock failed: ' + e.message); }
}

function releaseWakeLock() {
  try { if (S.wakeLock) { S.wakeLock.release(); S.wakeLock = null; } } catch (e) {}
  $('wakePill').classList.add('hidden');
}

// --------------------------------------------------------------------------
// Automation
// --------------------------------------------------------------------------
function checkAutomation() {
  const level = S.bat.level;
  if (level === null || level === undefined) return;

  if ($('chkAlert').checked && !S.alerted && level <= Number($('alertPct').value)) {
    S.alerted = true;
    banner('warn', 'Battery at ' + level + '% — below your ' + $('alertPct').value + '% alert threshold.');
    log('LOW BATTERY alert at ' + level + '%');
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.05;
      o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 220);
    } catch (e) {}
  }
  if (level > Number($('alertPct').value) + 2) S.alerted = false;

  if ($('chkAutoOff').checked && !S.autoOffFired && S.dc.enabled &&
      level <= Number($('autoOffPct').value)) {
    S.autoOffFired = true;
    log('AUTO-OFF: battery at ' + level + '%, cutting DC output');
    banner('warn', 'Auto power-off: battery reached ' + level + '%. Cutting DC output.');
    setDc(false);
  }
}

// --------------------------------------------------------------------------
// CSV export
// --------------------------------------------------------------------------
function exportCsv() {
  const rows = [['iso_time','dc_watts','pack_watts','level_pct','dc_volts','dc_amps','pack_volts','runtime_min']];
  const now = Date.now();
  S.samplesData.forEach((d, i) => {
    rows.push([ new Date(d.t).toISOString(), d.dc.toFixed(2), d.bat.toFixed(2),
                d.level ?? '', S.dc.voltage ?? '', S.dc.current ?? '',
                S.bat.voltage ?? '', S.bat.remain ?? '' ]);
  });
  const csv = rows.map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'linkpower-session-' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.csv';
  a.click();
  log('exported ' + S.samplesData.length + ' samples to CSV');
}

// --------------------------------------------------------------------------
// Demo mode
// --------------------------------------------------------------------------
let demoTimer = null;
function startDemo() {
  if (demoTimer) clearTimeout(demoTimer);
  S.demo = true;
  S.device = null;
  renderDevice({ Model:'BP4SL3V1 (demo)', Firmware:'demo 1.1.3', Hardware:'demo',
                 Software:'demo', Manufacturer:'PeakDo' });
  $('status').className = 'pill on';
  $('status').textContent = 'demo';
  banner('warn', 'Demo mode — simulated data. Nothing is connected.');
  let t = 0;
  const tick = () => {
    if (!S.demo) return;
    t += 0.02;
    const on = S.dc.enabled !== false;
    S.dc.voltage = 12.9 - t * 0.3;
    S.dc.current = on ? 2.4 + Math.sin(t * 3) * 0.15 : 0;
    S.dc.power = S.dc.voltage * S.dc.current;
    S.dc.status = on ? 2 : 0;
    S.dc.bypass = false;
    S.bat.voltage = 13.0 - t * 0.4;
    S.bat.current = S.dc.current;
    S.bat.power = S.bat.voltage * S.bat.current;
    S.bat.level = Math.max(0, Math.round(88 - t * 4));
    S.bat.remain = Math.max(0, Math.round((S.bat.level / 100) * 240));
    S.bat.capacity = Math.round(99 * (S.bat.level / 100));
    S.bat.maxCapacity = 99;
    S.bat.status = on ? 2 : 0;
    S.tc.voltage = 20.1; S.tc.current = 3.1; S.tc.power = 62.3;
    S.tc.temperature = 34.6; S.tc.status = 1; S.tc.enabled = 1;
    sample();
    render();
    demoTimer = setTimeout(tick, SAMPLE_MS);
  };
  tick();
}

// --------------------------------------------------------------------------
// Wiring
// --------------------------------------------------------------------------
$('btnConnect').addEventListener('click', connect);
$('btnReconnect').addEventListener('click', reconnect);
$('btnDisconnect').addEventListener('click', () => { if (S.device && S.device.gatt) S.device.gatt.disconnect(); });
$('btnDcOn').addEventListener('click', () => setDc(true));
$('btnDcOff').addEventListener('click', () => setDc(false));
$('btnRaw').addEventListener('click', sendRaw);
$('btnDump').addEventListener('click', dumpGatt);
$('btnFeatures').addEventListener('click', queryFeatures);
$('btnBtOff').addEventListener('click', turnOffDeviceBluetooth);
$('btnRestart').addEventListener('click', restartDevice);
$('btnCopyLog').addEventListener('click', copyLog);
$('btnReadAll').addEventListener('click', readAllTelemetry);
$('btnCsv').addEventListener('click', exportCsv);
$('btnDemo').addEventListener('click', startDemo);
$('chkWake').addEventListener('change', (e) => { if (e.target.checked) requestWakeLock(); else releaseWakeLock(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.device && S.server && S.server.connected) {
    requestWakeLock();
    readAllTelemetry();
  }
});

setInterval(() => {
  const live = S.demo || (S.device && S.server && S.server.connected);
  if (live) {
    if (S.samples > 0 || S.dc.power !== null) sample();
    checkAutomation();
    render();
  }
}, SAMPLE_MS);

window.addEventListener('resize', drawChart);

if (!navigator.bluetooth) {
  banner('warn', 'No Web Bluetooth in this browser. Use desktop Chrome or Edge, Android Chrome, or Bluefy on iPhone. Demo mode still works.');
}
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((e) => log('SW registration failed: ' + e.message));
}
log('ready');
render();
checkKnownDevices();
