/**
 * TREE CHARGE — OCPP 1.6J central system
 * ─────────────────────────────────────────────────────────────────────────────
 * Chargers connect here over WebSocket:      ws://<server>:9000/ocpp/<ChargePointID>
 * The Apps Script web app talks to it over HTTP (same port, needs the API key):
 *   POST /remote-start  { cpid, connector, idTag, session }   → RemoteStartTransaction
 *   POST /remote-stop   { cpid, connector, txId }             → RemoteStopTransaction
 *   GET  /chargers                                            → who is connected, last values
 *   POST /command       { cpid, action, payload }             → any OCPP call (Reset, ChangeConfiguration…)
 *   GET  /health                                              → "ok" (no key needed)
 * Everything the chargers report is forwarded to the Apps Script doPost (kind: 'ocpp'):
 *   status · start · meter · stop      (see ocppHook in Integrations.gs)
 *
 * Settings come from environment variables (on the VPS: /etc/treecharge-ocpp.env):
 *   PORT=9000  API_KEY=<long random>  HOOK_URL=<Apps Script /exec link>  HOOK_KEY=<hookKey from the Config tab>
 *   DATA_DIR=/var/lib/treecharge-ocpp   CP_IDS=TCTEST01,TCA01   (optional: only these chargers may connect)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 9000);
const API_KEY = process.env.API_KEY || '';
const HOOK_URL = process.env.HOOK_URL || '';
const HOOK_KEY = process.env.HOOK_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ALLOW = (process.env.CP_IDS || '').split(',').map(x => x.trim()).filter(Boolean);   // optional: only these Charge Point IDs may connect
const CALL_TIMEOUT = 20000;
const METER_EVERY = 20000;        // forward meter values to Apps Script at most every 20 s per gun
const STATUS_REFRESH = 4 * 60000; // re-send each gun's status every 4 min (Apps Script marks a gun offline after 10 min of silence)

if (!API_KEY || API_KEY.length < 16) console.warn('[warn] API_KEY is missing or short — set a long random value');
if (!HOOK_URL || !HOOK_KEY) console.warn('[warn] HOOK_URL / HOOK_KEY not set — events will not reach the app');

/* ---------- small state file: transaction numbers survive a restart ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let state = { nextTx: 1000, tx: {} };       // tx[txId] = { cpid, connector, session, meterStart, t }
try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) {}
function saveState() {
  const ids = Object.keys(state.tx);       // keep the last 2000 transactions
  if (ids.length > 2000) ids.slice(0, ids.length - 2000).forEach(k => delete state.tx[k]);
  fs.writeFile(STATE_FILE + '.tmp', JSON.stringify(state), e => { if (!e) fs.rename(STATE_FILE + '.tmp', STATE_FILE, () => {}); });
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- chargers ---------- */
const CP = new Map();   // cpid → { ws, boot, guns: Map(n → gun), calls: Map(id → {resolve,timer}), pendingStart: Map(n → session), lastBeat }
function gun(cp, n) {
  if (!cp.guns.has(n)) cp.guns.set(n, { status: 'Unknown', txId: null, meterWh: 0, soc: null, kw: null, lastSent: 0, lastStatusSent: 0 });
  return cp.guns.get(n);
}

/** Send an OCPP CALL to a charger and wait for its answer. */
function call(cpid, action, payload) {
  const cp = CP.get(cpid);
  if (!cp || cp.ws.readyState !== 1) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cp.calls.delete(id); reject(Object.assign(new Error('timeout'), { code: 'timeout' })); }, CALL_TIMEOUT);
    cp.calls.set(id, { resolve, reject, timer, action });
    cp.ws.send(JSON.stringify([2, id, action, payload || {}]));
    log('→', cpid, action, JSON.stringify(payload || {}));
  });
}

/* ---------- forward events to the Apps Script web app (in order, with retries) ---------- */
let queue = Promise.resolve();
function forward(ev) {
  if (!HOOK_URL || !HOOK_KEY) return;
  const body = JSON.stringify(Object.assign({ key: HOOK_KEY, kind: 'ocpp' }, ev));
  queue = queue.then(async () => {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(HOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'follow', signal: AbortSignal.timeout(30000) });
        const txt = await r.text();
        let j = null; try { j = JSON.parse(txt); } catch (e) {}
        if (j && j.ok) { if (j.result && j.result.ignored) log('↗ app ignored', ev.type, ev.cpid, j.result.ignored); return; }
        log('↗ app said', ev.type, r.status, txt.slice(0, 160));
        if (j && j.err === 'forbidden') return;   // wrong HOOK_KEY: retrying will not help
      } catch (e) { log('↗ app unreachable', ev.type, e.message); }
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  });
}
function sendStatus(cpid, n, g, force) {
  if (!force && Date.now() - g.lastStatusSent < STATUS_REFRESH) return;
  g.lastStatusSent = Date.now();
  forward({ type: 'status', cpid, connector: n, status: g.status, meterWh: g.meterWh });
}

/* ---------- OCPP messages from a charger ---------- */
function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
/** MeterValues → { wh, kw, soc } ; handles Wh/kWh, W/kW, per-phase power (summed). */
function readMeter(meterValue) {
  const out = { wh: null, kw: null, soc: null };
  let phaseKw = 0, phaseSeen = false;
  (meterValue || []).forEach(mv => (mv.sampledValue || []).forEach(sv => {
    const m = sv.measurand || 'Energy.Active.Import.Register', unit = (sv.unit || '').toLowerCase(), v = num(sv.value);
    if (v === null) return;
    if (m === 'Energy.Active.Import.Register' && !sv.phase) out.wh = unit === 'kwh' ? v * 1000 : v;
    else if (m === 'Power.Active.Import') { const kw = unit === 'kw' ? v : v / 1000; if (sv.phase) { phaseKw += kw; phaseSeen = true; } else out.kw = kw; }
    else if (m === 'SoC') out.soc = v;
  }));
  if (out.kw === null && phaseSeen) out.kw = phaseKw;
  return out;
}

const HANDLERS = {
  BootNotification(cpid, cp, p) {
    cp.boot = p;
    setTimeout(() => {   // ask for energy + power + battery % every 30 s (ignored by chargers that do not support it)
      call(cpid, 'ChangeConfiguration', { key: 'MeterValueSampleInterval', value: '30' }).catch(() => {});
      call(cpid, 'ChangeConfiguration', { key: 'MeterValuesSampledData', value: 'Energy.Active.Import.Register,Power.Active.Import,SoC' }).catch(() => {});
      call(cpid, 'TriggerMessage', { requestedMessage: 'StatusNotification' }).catch(() => {});
    }, 3000);
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 60 };
  },
  Heartbeat(cpid, cp) {
    cp.lastBeat = Date.now();
    cp.guns.forEach((g, n) => sendStatus(cpid, n, g, false));
    return { currentTime: new Date().toISOString() };
  },
  StatusNotification(cpid, cp, p) {
    const n = Number(p.connectorId) || 0;
    if (n === 0) return {};   // the whole charger; each gun reports its own
    const g = gun(cp, n);
    g.status = p.status; g.error = p.errorCode;
    sendStatus(cpid, n, g, true);
    return {};
  },
  Authorize() { return { idTagInfo: { status: 'Accepted' } }; },
  StartTransaction(cpid, cp, p) {
    const n = Number(p.connectorId) || 1, g = gun(cp, n);
    const txId = state.nextTx++;
    const session = cp.pendingStart.get(n) || null;
    cp.pendingStart.delete(n);
    state.tx[txId] = { cpid, connector: n, session, meterStart: num(p.meterStart) || 0, t: Date.now() };
    saveState();
    g.txId = txId; g.meterWh = num(p.meterStart) || 0;
    forward({ type: 'start', cpid, connector: n, session, txId, meterWh: g.meterWh, idTag: p.idTag });
    return { transactionId: txId, idTagInfo: { status: 'Accepted' } };
  },
  MeterValues(cpid, cp, p) {
    const n = Number(p.connectorId) || 1, g = gun(cp, n), m = readMeter(p.meterValue);
    if (m.wh !== null) g.meterWh = m.wh;
    if (m.kw !== null) g.kw = m.kw;
    if (m.soc !== null) g.soc = m.soc;
    const txId = p.transactionId != null ? p.transactionId : g.txId;
    if (txId != null && Date.now() - g.lastSent >= METER_EVERY) {
      g.lastSent = Date.now();
      const t = state.tx[txId] || {};
      forward({ type: 'meter', cpid, connector: n, txId, session: t.session || null, meterWh: g.meterWh, kw: g.kw, soc: g.soc });
    }
    return {};
  },
  StopTransaction(cpid, cp, p) {
    const t = state.tx[p.transactionId] || {};
    const n = t.connector || [...cp.guns.entries()].filter(([, g]) => g.txId === p.transactionId).map(([k]) => k)[0] || 1;
    const g = gun(cp, n), m = readMeter(p.transactionData);
    if (num(p.meterStop) !== null) g.meterWh = num(p.meterStop);
    if (m.soc !== null) g.soc = m.soc;
    g.txId = null; g.kw = 0;
    forward({ type: 'stop', cpid, connector: n, txId: p.transactionId, session: t.session || null, meterWh: g.meterWh, soc: g.soc, reason: p.reason || 'Local' });
    return { idTagInfo: { status: 'Accepted' } };
  },
  DataTransfer() { return { status: 'Accepted' }; },
  DiagnosticsStatusNotification() { return {}; },
  FirmwareStatusNotification() { return {}; }
};

/* ---------- HTTP API (for the Apps Script web app and for you) ---------- */
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function authed(req) {
  const h = req.headers.authorization || '';
  const got = Buffer.from(h.replace(/^Bearer\s+/i, '')), want = Buffer.from(API_KEY);
  return API_KEY && got.length === want.length && crypto.timingSafeEqual(got, want);
}
function readBody(req) {
  return new Promise(resolve => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } }); });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return json(res, 200, { ok: true, chargers: CP.size });
  if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
  try {
    if (req.method === 'GET' && url.pathname === '/chargers') {
      return json(res, 200, [...CP.entries()].map(([id, cp]) => ({ cpid: id, online: cp.ws.readyState === 1, boot: cp.boot, lastBeat: cp.lastBeat ? new Date(cp.lastBeat).toISOString() : null,
        guns: [...cp.guns.entries()].map(([n, g]) => ({ n, status: g.status, error: g.error, txId: g.txId, meterWh: g.meterWh, kw: g.kw, soc: g.soc })) })));
    }
    const b = await readBody(req);
    if (req.method === 'POST' && url.pathname === '/remote-start') {
      const cp = CP.get(b.cpid); if (!cp) return json(res, 503, { error: 'offline' });
      const n = Number(b.connector) || 1;
      cp.pendingStart.set(n, b.session || null);
      const r = await call(b.cpid, 'RemoteStartTransaction', { connectorId: n, idTag: String(b.idTag || 'TREECHARGE').slice(0, 20) });
      if (r.status !== 'Accepted') { cp.pendingStart.delete(n); return json(res, 409, { error: 'rejected', status: r.status }); }
      return json(res, 200, { status: r.status });
    }
    if (req.method === 'POST' && url.pathname === '/remote-stop') {
      const cp = CP.get(b.cpid); if (!cp) return json(res, 503, { error: 'offline' });
      const txId = b.txId != null && b.txId !== '' ? Number(b.txId) : (gun(cp, Number(b.connector) || 1).txId);
      if (txId == null) return json(res, 404, { error: 'no_transaction' });
      const r = await call(b.cpid, 'RemoteStopTransaction', { transactionId: txId });
      return json(res, r.status === 'Accepted' ? 200 : 409, { status: r.status });
    }
    if (req.method === 'POST' && url.pathname === '/command') {
      const r = await call(b.cpid, String(b.action), b.payload || {});
      return json(res, 200, r);
    }
    json(res, 404, { error: 'not_found' });
  } catch (e) { json(res, e.code === 'offline' ? 503 : 504, { error: e.code || e.message }); }
});

/* ---------- WebSocket: ws://host:PORT/ocpp/<ChargePointID>  (also /<ChargePointID>) ---------- */
const wss = new WebSocketServer({ noServer: true, handleProtocols: protos => (protos.has('ocpp1.6') ? 'ocpp1.6' : false) });
server.on('upgrade', (req, socket, head) => {
  const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
  const cpid = decodeURIComponent(parts[parts.length - 1] || '');
  if (!cpid || cpid === 'ocpp') { socket.destroy(); return; }
  if (ALLOW.length && !ALLOW.includes(cpid)) { log('! refused unknown charger', cpid, req.socket.remoteAddress); socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, cpid));
});
wss.on('connection', (ws, req, cpid) => {
  const old = CP.get(cpid);
  if (old) { try { old.ws.terminate(); } catch (e) {} }
  const cp = { ws, boot: old ? old.boot : null, guns: old ? old.guns : new Map(), calls: new Map(), pendingStart: new Map(), lastBeat: Date.now() };
  CP.set(cpid, cp);
  log('+ connected', cpid, 'from', req.socket.remoteAddress, 'protocol', ws.protocol || '(none)');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { log('! bad json from', cpid); return; }
    const [type, id] = msg;
    if (type === 2) {                       // CALL from the charger
      const [, , action, payload] = msg;
      log('←', cpid, action, JSON.stringify(payload).slice(0, 300));
      const h = HANDLERS[action];
      if (!h) { ws.send(JSON.stringify([4, id, 'NotImplemented', 'Unknown action ' + action, {}])); return; }
      try { ws.send(JSON.stringify([3, id, h(cpid, cp, payload || {}) || {}])); }
      catch (e) { log('! handler', action, e.message); ws.send(JSON.stringify([4, id, 'InternalError', e.message, {}])); }
    } else if (type === 3 || type === 4) {  // answer to one of our calls
      const c = cp.calls.get(id); if (!c) return;
      cp.calls.delete(id); clearTimeout(c.timer);
      log('↩', cpid, c.action, type === 3 ? JSON.stringify(msg[2]) : 'ERROR ' + msg[2] + ' ' + msg[3]);
      if (type === 3) c.resolve(msg[2] || {}); else c.reject(Object.assign(new Error(msg[3] || msg[2]), { code: msg[2] }));
    }
  });
  ws.on('close', () => {
    log('- disconnected', cpid);
    if (CP.get(cpid) !== cp) return;      // a newer connection replaced this one
    cp.calls.forEach(c => { clearTimeout(c.timer); c.reject(Object.assign(new Error('offline'), { code: 'offline' })); });
    cp.guns.forEach((g, n) => { g.status = 'Unavailable'; sendStatus(cpid, n, g, true); });
  });
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} }), 30000);

server.listen(PORT, () => log('TREE CHARGE OCPP 1.6J server on port', PORT, '· chargers connect to ws://<this-server>:' + PORT + '/ocpp/<ChargePointID>'));
