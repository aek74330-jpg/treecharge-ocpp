/**
 * A pretend charger (OCPP 1.6J) for testing without real hardware.
 *   node tools/sim.js ws://<server>:9000/ocpp/TCTEST01  [kW=120] [guns=2] [speed=30]
 * It boots, reports both guns Available, answers RemoteStart/RemoteStop, and while charging
 * sends MeterValues (energy, power, battery %) — two guns at once share the power equally.
 * speed: how many times faster than real time the battery fills (30 = 1 real minute ≈ 30 minutes).
 */
'use strict';
const WebSocket = require('../node_modules/ws');
const [url, kwArg, gunsArg, speedArg] = process.argv.slice(2);
if (!url) { console.log('usage: node tools/sim.js ws://host:9000/ocpp/<ChargePointID> [kW] [guns] [speed]'); process.exit(1); }
const MAX_KW = Number(kwArg || 120), GUNS = Number(gunsArg || 2), SPEED = Number(speedArg || 30), BATT = 60;
let meterWh = 1000000, msgId = 0;
const guns = {}; for (let n = 1; n <= GUNS; n++) guns[n] = { status: 'Available', tx: null, soc: 0 };
const pending = new Map();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function connect() {
  const ws = new WebSocket(url, 'ocpp1.6');
  const send = (action, payload) => new Promise(res => { const id = 'sim' + (++msgId); pending.set(id, res); ws.send(JSON.stringify([2, id, action, payload])); log('→', action, JSON.stringify(payload)); });
  const status = (n, s) => { guns[n].status = s; return send('StatusNotification', { connectorId: n, errorCode: 'NoError', status: s, timestamp: new Date().toISOString() }); };
  ws.on('open', async () => {
    log('connected', url);
    await send('BootNotification', { chargePointVendor: 'TREE-SIM', chargePointModel: 'SIM-' + MAX_KW + 'kW' });
    for (let n = 1; n <= GUNS; n++) await status(n, 'Available');
  });
  ws.on('message', async raw => {
    const m = JSON.parse(raw.toString());
    if (m[0] === 3 || m[0] === 4) { const r = pending.get(m[1]); if (r) { pending.delete(m[1]); r(m[2]); } return; }
    const [, id, action, p] = m;
    log('←', action, JSON.stringify(p));
    if (action === 'RemoteStartTransaction') {
      const n = p.connectorId || 1, g = guns[n];
      if (g.status !== 'Available') { ws.send(JSON.stringify([3, id, { status: 'Rejected' }])); return; }
      ws.send(JSON.stringify([3, id, { status: 'Accepted' }]));
      await status(n, 'Preparing');
      g.soc = 20 + Math.floor(Math.random() * 30);
      const r = await send('StartTransaction', { connectorId: n, idTag: p.idTag, meterStart: Math.round(meterWh), timestamp: new Date().toISOString() });
      g.tx = r.transactionId; g.started = meterWh;
      await status(n, 'Charging');
    } else if (action === 'RemoteStopTransaction') {
      const n = Object.keys(guns).find(k => guns[k].tx === p.transactionId);
      ws.send(JSON.stringify([3, id, { status: n ? 'Accepted' : 'Rejected' }]));
      if (n) stop(Number(n), 'Remote');
    } else if (action === 'ChangeConfiguration') ws.send(JSON.stringify([3, id, { status: 'Accepted' }]));
    else if (action === 'TriggerMessage') { ws.send(JSON.stringify([3, id, { status: 'Accepted' }])); for (let n = 1; n <= GUNS; n++) status(n, guns[n].status); }
    else ws.send(JSON.stringify([3, id, {}]));
  });
  async function stop(n, reason) {
    const g = guns[n]; if (!g.tx) return;
    const tx = g.tx; g.tx = null;
    await status(n, 'Finishing');
    await send('StopTransaction', { transactionId: tx, meterStop: Math.round(meterWh), timestamp: new Date().toISOString(), reason,
      transactionData: [{ timestamp: new Date().toISOString(), sampledValue: [{ measurand: 'SoC', unit: 'Percent', value: String(Math.round(g.soc)) }] }] });
    await status(n, 'Available');
  }
  // every 10 s: charge the batteries, send MeterValues; 2 guns at once share the power equally
  const tick = setInterval(() => {
    const active = Object.keys(guns).filter(n => guns[n].tx);
    if (!active.length || ws.readyState !== 1) return;
    const kw = MAX_KW / active.length * (0.9 + Math.random() * 0.1);
    active.forEach(n => {
      const g = guns[n], addKwh = kw * 10 / 3600 * SPEED;
      const taper = g.soc > 80 ? 0.4 : 1;   // slower near full, like a real car
      meterWh += addKwh * 1000 * taper; g.soc = Math.min(100, g.soc + addKwh * taper / BATT * 100);
      send('MeterValues', { connectorId: Number(n), transactionId: g.tx, meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [
        { measurand: 'Energy.Active.Import.Register', unit: 'Wh', value: String(Math.round(meterWh)) },
        { measurand: 'Power.Active.Import', unit: 'kW', value: (kw * taper).toFixed(1) },
        { measurand: 'SoC', unit: 'Percent', value: String(Math.round(g.soc)) }] }] });
      if (g.soc >= 100) stop(Number(n), 'EVDisconnected');
    });
  }, 10000);
  const beat = setInterval(() => { if (ws.readyState === 1) send('Heartbeat', {}); }, 60000);
  ws.on('close', () => { log('disconnected — retry in 5 s'); clearInterval(tick); clearInterval(beat); setTimeout(connect, 5000); });
  ws.on('error', e => log('error', e.message));
}
connect();
