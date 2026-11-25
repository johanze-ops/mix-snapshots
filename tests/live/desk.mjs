// Desk test against a running LUNA: node tests/live/desk.mjs [--session snaptest]
// Captures the mix, changes things the way a client would, recalls, checks nothing differs,
// then undoes once and checks the client's changes are back. Refuses any other session name.
import { Luna } from '@uaudio/luna-builder-sdk';
globalThis.Luna = Luna;
await import('../../logic.js');
const M = globalThis.MixLogic;
const want = process.argv.includes('--session') ? process.argv[process.argv.indexOf('--session') + 1] : 'snaptest';
const ALL = { levels: true, pans: true, mutes: true, sends: true, plugins: true, automation: true };
const luna = await Luna.connect(); const s = await luna.session();
if (s.name.value !== want) { console.log(`session is “${s.name.value}”, not “${want}”: stopping`); process.exit(1); }
const undoId = M.undoReader(luna, s);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
await luna.errors.watch().ready;
const notices0 = luna.errors.sorted.length; // LUNA's own error notices: none may appear
const selTracks = async () => (await luna.raw.get(`${s.path}/contexts/main`, { propfilter: ['selection_tracks'] })).properties.selection_tracks.value ?? [];

let t = Date.now();
const { data: mine, handles } = await M.capture(s, { name: 'My mix' });
const nCtl = Object.values(mine.channels).reduce((n, c) => n + Object.keys(c.c).length, 0);
const nLane = Object.values(mine.channels).reduce((n, c) => n + Object.keys(c.a).length, 0);
console.log(`capture: ${Object.keys(mine.channels).length} channels, ${nCtl} controls, ${nLane} lanes in ${Date.now() - t} ms`);

// the client's changes (each its own undo step, as a person would make them)
const byName = (n) => [...handles.values()].find((h) => h.ch.name.value === n);
const A = byName('086bpmTIGHTwet'), B = byName('089bpmSHAPEwet1'), C = byName('091bpmSHADESfull2');
const ctl = (h, k) => h.entries.get(k);
await ctl(A, 'gain').control.real.set(-15);
await ctl(A, 'mute').control.real.set(true);
await ctl(A, 'pan.0').control.normalized.set(0.2);
await ctl(C, 'send.send_0.gain').control.real.set(-6);
const knobKey = [...C.entries.keys()].find((k) => k.startsWith('fx.console.') && !k.endsWith('@in') && !/Filter/.test(k) && !C.entries.get(k).control.discrete.value);
await ctl(C, knobKey).control.normalized.set(0.9);
await ctl(C, 'fx.console.@in').effect.setIn(false);
await ctl(B, 'gain').control.automation.clear(0, Luna.WHOLE_NOTE * 1000);
await ctl(B, 'gain').control.automation.insert([{ tick: 0, value: -30 }]);
await B.ch.setAutomationMode('off');
await pause(400);
const { data: client } = await M.capture(s, { name: 'Client' });
const before = M.plan(mine, client, ALL);
console.log(`client changed: ${before.writes.map((w) => w.key).join(', ')} | lanes ${before.lanes.map((l) => l.key)} | modes ${before.modes.length}`);

// recall with 086 and the SD3 track selected: LUNA's selection grouping would carry 086's fader
// moves over to the SD3 track (measured 2026-11-25), which shows up below as left over
const G = byName('INSTRUMENT');
const sel = [A.ch.id, G.ch.id];
await s.selectTimeline({ tracks: sel }); await pause(300);
const u0 = await undoId();
t = Date.now();
const plan = await M.recall(s, mine, ALL, { name: 'Recall “My mix”' });
console.log(`recall: ${plan.writes.length} values, ${plan.lanes.length} lanes, ${plan.modes.length} modes in ${Date.now() - t} ms; missing: ${plan.missing.map((m) => JSON.stringify(m)).join(', ') || 'none'}`);
await pause(600);
const { data: after } = await M.capture(s);
const left = M.plan(mine, after, ALL);
console.log(`left over after recall: ${M.size(left)}`, left.writes.map((w) => `${after.channels[w.ch].name} ${w.key} ${w.value} vs ${after.channels[w.ch].c[w.key]}`), left.lanes.map((l) => l.key), left.modes);
console.log('selection (086 + SD3) back after recall:', JSON.stringify(await selTracks()) === JSON.stringify(sel));

await s.undo(1); await pause(800);
const { data: undone } = await M.capture(s);
const back = M.plan(client, undone, ALL);
console.log(`one undo → back to the client's mix: ${M.size(back) === 0 ? 'yes' : 'NO, ' + M.size(back) + ' differ'}; undo id back: ${(await undoId()) === u0}`);
if (M.size(back)) console.log(back.writes.map((w) => w.key), back.lanes.map((l) => l.key), back.modes);

// leave the session as it started
await M.recall(s, mine, ALL, { name: 'Desk test: restore' });
await pause(500);
console.log('restored the starting mix:', M.size(M.plan(mine, (await M.capture(s)).data, ALL)) === 0);
await pause(300);
const notices = luna.errors.sorted.slice(notices0);
console.log('LUNA raised no errors:', notices.length ? `NO: ${notices.map((e) => e.title.value).join(', ')}` : true);
process.exit(0);
