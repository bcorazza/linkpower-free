// Starlink Test — connection reliability monitor.
// Two modes:
//   agent  — served by tools/starlink-agent.py: adds real dish telemetry and ICMP ping
//   web    — served from anywhere (e.g. GitHub Pages): internet probes only
// A hosted HTTPS page cannot talk to the dish (mixed content, and the dish
// answers OPTIONS with 405 so no CORS preflight can pass). Hence the agent.

const $ = (id) => document.getElementById(id);

const PROBE_TARGETS = [
  { name: 'Cloudflare', url: 'https://cloudflare.com/cdn-cgi/trace',       color: '#38bdf8' },
  { name: 'Google',     url: 'https://www.google.com/generate_204',        color: '#a78bfa' },
  { name: 'Apple',      url: 'https://www.apple.com/library/test/success.html', color: '#34d399' },
];
const MAX_POINTS = 150;
const DISH_POLL_MS = 5000;

const S = {
  mode: 'web',            // 'agent' | 'web'
  running: false,
  timer: null,
  dishTimer: null,
  samples: [],            // { t, per: { name: ms|null } }
  logs: [],               // { t, type, detail }
  lastDish: null,
  dishOk: false,
  outages: 0,
};

// ---------------------------------------------------------------- utilities
function fmtMs(v, d = 1) { return (v === null || v === undefined || Number.isNaN(v)) ? '--' : v.toFixed(d); }
function fmtBps(v) {
  if (!v && v !== 0) return '--';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + ' Mbps';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + ' kbps';
  return v.toFixed(0) + ' bps';
}
function fmtUptime(s) {
  if (!s && s !== 0) return '--';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
const clock = (t = Date.now()) => new Date(t).toLocaleTimeString([], { hour12: false });

function banner(kind, text) {
  const b = $('banner');
  if (!text) { b.className = 'hidden'; b.textContent = ''; return; }
  b.className = kind; b.textContent = text;
}

function addLog(type, detail) {
  S.logs.push({ t: Date.now(), type, detail });
  if (S.logs.length > 500) S.logs.shift();
  renderLog();
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

// ---------------------------------------------------------------- agent
/** The agent only ever runs on plain http on a loopback or private address.
 *  Checking first avoids a pointless 404 (and a console error) when the app is
 *  hosted on HTTPS. */
function looksLocal() {
  const h = location.hostname;
  if (location.protocol !== 'http:') return false;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' ||
         h.endsWith('.local') ||
         /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

async function detectAgent() {
  if (!looksLocal()) { showBrowserOnly('no local agent on this origin'); return null; }
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    if (!r.ok) throw new Error('no agent');
    const j = await r.json();
    if (!j.agent) throw new Error('not an agent');
    S.mode = 'agent';
    $('modePill').className = 'pill on';
    $('modePill').textContent = 'agent connected';
    $('pingPill').classList.add('hidden');
    $('btnPing').disabled = false;
    $('btnPingDish').disabled = false;
    if (!j.dish_reachable) {
      banner('warn', 'Agent running, but the dish is not reachable at ' + j.dish_host +
        (j.dish_error ? ' — ' + j.dish_error : '') +
        '. Internet probes and ping still work; connect this machine to the Starlink WiFi for dish telemetry.');
    }
    return j;
  } catch (e) {
    showBrowserOnly(e.message);
    return null;
  }
}

function showBrowserOnly(why) {
  S.mode = 'web';
  $('modePill').className = 'pill info';
  $('modePill').textContent = 'browser-only mode';
  $('pingPill').classList.remove('hidden');
  $('cardDish').classList.add('hidden');
  $('dishPill').classList.add('hidden');
  $('btnPing').disabled = true;
  $('btnPingDish').disabled = true;
  banner('info', 'Browser-only mode (' + why + '): internet probes work here, but dish telemetry and ' +
    'real ICMP ping need the local agent. On your Mac run: python3 tools/starlink-agent.py — ' +
    'then open http://localhost:8790/');
}

// ---------------------------------------------------------------- probing
async function probeOne(target) {
  const url = target.url + (target.url.includes('?') ? '&' : '?') + '_cb=' + Math.random().toString(36).slice(2);
  const t0 = performance.now();
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', redirect: 'follow' });
    return performance.now() - t0;
  } catch (e) {
    return null;   // network-level failure -> counts as loss
  }
}

async function probeRound(warm = false) {
  const per = {};
  await Promise.all(PROBE_TARGETS.map(async (tg) => { per[tg.name] = await probeOne(tg); }));
  if (warm) return per;

  S.samples.push({ t: Date.now(), per });
  if (S.samples.length > MAX_POINTS) S.samples.shift();

  const failed = PROBE_TARGETS.filter((tg) => per[tg.name] === null);
  if (failed.length) {
    S.outages++;
    addLog('loss', `${failed.length}/${PROBE_TARGETS.length} probes failed (${failed.map((f) => f.name).join(', ')})`);
  }
  render();
}

function startMonitoring() {
  if (S.running) return;
  S.running = true;
  $('btnToggle').textContent = 'Stop monitoring';
  $('runPill').className = 'pill on';
  $('runPill').textContent = 'monitoring';
  addLog('info', 'monitoring started');
  // Warm the connections and WAIT for them, so the first sample isn't dominated
  // by DNS + TCP + TLS setup (which otherwise shows up as a huge outlier).
  const tick = async () => {
    if (!S.running) return;
    await probeRound(false).catch(() => {});
    const ms = Math.max(1, Number($('interval').value) || 3) * 1000;
    S.timer = setTimeout(tick, ms);
  };
  Promise.all(PROBE_TARGETS.map((tg) => probeOne(tg))).then(() => setTimeout(tick, 400));
}

function stopMonitoring() {
  S.running = false;
  clearTimeout(S.timer); S.timer = null;
  $('btnToggle').textContent = 'Start monitoring';
  $('runPill').className = 'pill';
  $('runPill').textContent = 'stopped';
  addLog('info', 'monitoring stopped');
}

// ---------------------------------------------------------------- dish
async function pollDish() {
  if (S.mode !== 'agent') return;
  try {
    const r = await fetch('api/status', { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'dish error');
    S.lastDish = { ...j, at: Date.now() };
    S.dishOk = true;
  } catch (e) {
    if (S.dishOk) addLog('dish', 'lost dish telemetry: ' + e.message);
    S.dishOk = false;
    S.lastDish = null;
  }
  renderDish();
}

// ---------------------------------------------------------------- render
function renderDish() {
  const d = S.lastDish;
  const pill = $('dishPill');
  pill.classList.remove('hidden');
  if (!d) {
    pill.className = 'pill bad'; pill.textContent = 'dish unreachable';
    $('dishLatency').textContent = '--';
    ['dishDrop', 'dishObstr', 'dishDown', 'dishUp', 'dishUptime', 'dishSignal'].forEach((i) => { $(i).textContent = '--'; });
    $('dishNote').textContent = 'No dish telemetry. Make sure this machine is on the Starlink WiFi.';
    return;
  }
  pill.className = 'pill on'; pill.textContent = 'dish online';
  const lat = d.pop_ping_latency_ms;
  $('dishLatency').textContent = fmtMs(lat, 1);
  $('dishDrop').textContent = d.pop_ping_drop_rate !== undefined
    ? (d.pop_ping_drop_rate * 100).toFixed(2) + ' %' : '0.00 %';
  const ob = d.obstruction_stats || {};
  $('dishObstr').textContent = (ob.fraction_obstructed !== undefined)
    ? (ob.fraction_obstructed * 100).toFixed(1) + ' %' : '--';
  $('dishDown').textContent = fmtBps(d.downlink_throughput_bps);
  $('dishUp').textContent = fmtBps(d.uplink_throughput_bps);
  $('dishUptime').textContent = fmtUptime((d.device_state || {}).uptime_s);
  $('dishSignal').textContent = d.is_snr_persistently_low ? 'low SNR' : (d.is_snr_above_noise_floor ? 'nominal' : '--');
  $('dishAge').textContent = clock(d.at);

  const di = d.device_info || {};
  $('dishDev').textContent = [di.hardware_version, di.software_version, di.country_code].filter(Boolean).join(' · ') || '—';

  const notes = [];
  if (ob.currently_obstructed) notes.push('currently obstructed');
  if (ob.avg_prolonged_obstruction_duration_s) {
    notes.push(`prolonged obstruction: ${ob.avg_prolonged_obstruction_duration_s.toFixed(1)}s avg every `
      + `${Math.round(ob.avg_prolonged_obstruction_interval_s || 0)}s`);
  }
  if (d.pop_ping_drop_rate > 0.01) notes.push('elevated drop rate');
  $('dishNote').textContent = notes.length ? '⚠ ' + notes.join('; ') : '';
}

function render() {
  // aggregate stats across every successful probe in the session
  const all = [];
  S.samples.forEach((s) => PROBE_TARGETS.forEach((tg) => {
    const v = s.per[tg.name];
    if (v !== null && v !== undefined) all.push(v);
  }));
  const sorted = [...all].sort((a, b) => a - b);
  const sent = S.samples.length * PROBE_TARGETS.length;
  const loss = sent ? ((sent - all.length) / sent) * 100 : 0;

  // Jitter must come from the time-ordered series, not the sorted one:
  // the mean gap between neighbouring *sorted* values is just spacing, not jitter.
  let jitSum = 0, jitN = 0;
  PROBE_TARGETS.forEach((tg) => {
    let prev = null;
    S.samples.forEach((s) => {
      const v = s.per[tg.name];
      if (v === null || v === undefined) { prev = null; return; }
      if (prev !== null) { jitSum += Math.abs(v - prev); jitN++; }
      prev = v;
    });
  });
  const jitter = jitN ? jitSum / jitN : null;

  const cur = S.samples.length
    ? PROBE_TARGETS.map((tg) => S.samples[S.samples.length - 1].per[tg.name]).filter((v) => v !== null)
    : [];
  const curAvg = cur.length ? cur.reduce((a, b) => a + b, 0) / cur.length : null;

  $('probeLatency').textContent = fmtMs(curAvg, 0);
  $('probeLoss').textContent = S.samples.length ? loss.toFixed(1) + ' %' : '--';
  $('probeJitter').textContent = jitter === null ? '--' : fmtMs(jitter, 1) + ' ms';
  $('probeP95').textContent = sorted.length ? fmtMs(percentile(sorted, 95), 0) + ' ms' : '--';
  $('probeMin').textContent = sorted.length ? fmtMs(sorted[0], 0) + ' ms' : '--';
  $('probeMax').textContent = sorted.length ? fmtMs(sorted[sorted.length - 1], 0) + ' ms' : '--';
  $('probeCount').textContent = String(all.length);
  $('outageCount').textContent = String(S.outages);
  if (S.samples.length) $('probeAge').textContent = clock(S.samples[S.samples.length - 1].t);

  const lossEl = $('probeLoss');
  lossEl.parentElement.parentElement.classList.remove('hidden');
  lossEl.style.color = loss > 5 ? 'var(--red)' : loss > 1 ? 'var(--orange)' : '';
  const latEl = $('probeLatency');
  latEl.style.color = curAvg > 150 ? 'var(--orange)' : '';

  drawChart();
  renderLegend();
}

function renderLog() {
  const body = $('logBody');
  $('logCount').textContent = S.logs.length ? `(${S.logs.length})` : '';
  if (!S.logs.length) { body.innerHTML = '<tr><td colspan="3" class="muted">nothing yet</td></tr>'; return; }
  body.innerHTML = S.logs.slice(-60).reverse().map((l) => {
    const cls = (l.type === 'loss' || l.type === 'dish') ? 'fail' : '';
    return `<tr><td>${clock(l.t)}</td><td class="${cls}">${l.type}</td><td>${l.detail}</td></tr>`;
  }).join('');
}

function drawChart() {
  const cv = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 150;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const data = S.samples;
  const vals = [];
  data.forEach((s) => PROBE_TARGETS.forEach((tg) => { const v = s.per[tg.name]; if (v !== null && v !== undefined) vals.push(v); }));
  const maxV = Math.max(50, ...vals) * 1.15;
  const pad = 6;

  ctx.strokeStyle = '#202b36'; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = Math.round(pad + ((h - pad * 2) * i) / 3) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    if (i < 3) {
      const v = maxV * (1 - i / 3);
      ctx.fillStyle = '#6b7d90'; ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillText(v.toFixed(0) + ' ms', 4, y - 3);
    }
  }
  if (data.length < 2) return;

  const xFor = (i) => (i / (MAX_POINTS - 1)) * w;
  const yFor = (v) => h - pad - (v / maxV) * (h - pad * 2);

  PROBE_TARGETS.forEach((tg) => {
    ctx.beginPath();
    let started = false;
    data.forEach((s, i) => {
      const v = s.per[tg.name];
      if (v === null || v === undefined) { started = false; return; }
      if (!started) { ctx.moveTo(xFor(i), yFor(v)); started = true; } else { ctx.lineTo(xFor(i), yFor(v)); }
    });
    ctx.strokeStyle = tg.color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
  });

  // failure ticks along the baseline
  data.forEach((s, i) => {
    const fails = PROBE_TARGETS.filter((tg) => s.per[tg.name] === null).length;
    if (fails) {
      ctx.fillStyle = 'rgba(248,113,113,.9)';
      ctx.fillRect(xFor(i) - 1.5, h - 12, 3, 12);
    }
  });
  $('scaleNote').textContent = `0–${maxV.toFixed(0)} ms`;
}

function renderLegend() {
  $('legend').innerHTML = PROBE_TARGETS.map((tg) => {
    const last = S.samples.length ? S.samples[S.samples.length - 1].per[tg.name] : undefined;
    const txt = (last === null || last === undefined) ? 'lost' : last.toFixed(0) + ' ms';
    return `<span><i style="background:${tg.color}"></i>${tg.name} <span class="mono">${txt}</span></span>`;
  }).join('') + '<span><i style="background:#f87171"></i>failed probe</span>';
}

// ---------------------------------------------------------------- ping
async function runPing(host, count) {
  if (S.mode !== 'agent') { banner('warn', 'ICMP ping needs the local agent.'); return; }
  $('pingNote').textContent = `pinging ${host}…`;
  try {
    const r = await fetch(`api/ping?host=${encodeURIComponent(host)}&count=${count}`, { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok && j.avg_ms === null) {
      $('pingAvg').textContent = '--'; $('pingMinMax').textContent = '--';
      $('pingJitter').textContent = '--';
      $('pingLoss').textContent = j.loss_pct !== null && j.loss_pct !== undefined ? j.loss_pct + ' %' : '100 %';
      $('pingRecv').textContent = `${j.received ?? 0}/${j.transmitted ?? count}`;
      $('pingTime').textContent = j.elapsed_s + 's';
      $('pingNote').textContent = '⚠ ' + (j.error || 'no reply');
      addLog('loss', `ping ${host} failed: ${j.error || 'no reply'}`);
      return;
    }
    const f = (v, d = 1) => (v === null || v === undefined ? '--' : v.toFixed(d));
    $('pingAvg').textContent = f(j.avg_ms) + ' ms';
    $('pingMinMax').textContent = `${f(j.min_ms, 0)} / ${f(j.max_ms, 0)}`;
    $('pingJitter').textContent = f(j.jitter_ms) + ' ms';
    $('pingLoss').textContent = f(j.loss_pct, 1) + ' %';
    $('pingLoss').style.color = j.loss_pct > 5 ? 'var(--red)' : j.loss_pct > 0 ? 'var(--orange)' : '';
    $('pingRecv').textContent = `${j.received}/${j.transmitted}`;
    $('pingTime').textContent = j.elapsed_s + 's';
    $('pingNote').textContent = `${j.transmitted} ICMP packets to ${host}`;
    addLog('info', `ping ${host}: avg ${f(j.avg_ms)} ms, loss ${f(j.loss_pct, 1)}%`);
    if (j.loss_pct > 0) addLog('loss', `ping ${host} lost ${j.loss_pct}% of packets`);
  } catch (e) {
    $('pingNote').textContent = '⚠ ' + e.message;
  }
}

// ---------------------------------------------------------------- throughput
async function downloadTest() {
  const bytes = 10 * 1024 * 1024;
  $('tput').textContent = '…';
  try {
    const t0 = performance.now();
    let got = 0;
    const r = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`, { cache: 'no-store' });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
    }
    const secs = (performance.now() - t0) / 1000;
    const mbps = (got * 8) / secs / 1e6;
    $('tput').textContent = mbps.toFixed(1) + ' Mbps';
    addLog('info', `download test: ${mbps.toFixed(1)} Mbps (${(got / 1048576).toFixed(1)} MiB in ${secs.toFixed(1)}s)`);
  } catch (e) {
    $('tput').textContent = 'failed';
    addLog('loss', 'download test failed: ' + e.message);
  }
}

// ---------------------------------------------------------------- export
function exportCsv() {
  const rows = [['iso_time', 'kind', 'target', 'latency_ms', 'ok']];
  S.samples.forEach((s) => PROBE_TARGETS.forEach((tg) => {
    const v = s.per[tg.name];
    rows.push([new Date(s.t).toISOString(), 'probe', tg.name, v === null ? '' : v.toFixed(2), v === null ? 0 : 1]);
  }));
  (S.lastDish ? [S.lastDish] : []).forEach((d) => {
    rows.push([new Date(d.at).toISOString(), 'dish', 'dish', (d.pop_ping_latency_ms ?? '').toString(), 1]);
  });
  const csv = rows.map((r) => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'starlink-test-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
  a.click();
}

// ---------------------------------------------------------------- wiring
$('btnToggle').addEventListener('click', () => (S.running ? stopMonitoring() : startMonitoring()));
$('btnPing').addEventListener('click', () => runPing($('pingHost').value.trim() || '1.1.1.1', Number($('pingCount').value) || 10));
$('btnPingDish').addEventListener('click', () => runPing('192.168.100.1', Number($('pingCount').value) || 10));
$('btnThroughput').addEventListener('click', downloadTest);
$('btnCsv').addEventListener('click', exportCsv);
$('btnClear').addEventListener('click', () => {
  S.samples = []; S.logs = []; S.outages = 0;
  render(); renderLog(); renderLegend();
});
window.addEventListener('resize', drawChart);

$('howto').innerHTML = `
  <strong>How to use this:</strong> on your Mac run
  <code>python3 tools/starlink-agent.py</code> then open <code>http://localhost:8790/</code>.
  That gives dish telemetry and real ICMP ping. Add <code>--lan</code> to also reach it from your phone
  on the same WiFi. Hosted on GitHub Pages it still runs internet probes, but not dish or ICMP.
`;

(async () => {
  await detectAgent();
  renderLegend();
  render();
  if (S.mode === 'agent') {
    await pollDish();
    S.dishTimer = setInterval(pollDish, DISH_POLL_MS);
  }
  // Sampling only starts on an explicit click, so we never burn data unasked.
  if (S.mode === 'agent' && S.dishOk) banner('info', 'Dish online — press Start monitoring to begin latency and loss testing.');
})();
