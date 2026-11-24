// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const M = globalThis.MixLogic;

const ALL = { levels: true, pans: true, mutes: true, sends: true, plugins: true, automation: true };

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass', 'Drums'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  return { engine, luna, session };
}

const track = (session, name) => session.visibleTracks.find((t) => t.name.value === name);

// ---------------------------------------------------------------- plan (plain data)
const ch = (id, name, c, extra = {}) => ({ id, name, mode: 'read', fx: {}, c, a: {}, ...extra });
const mix = (...channels) => ({ channels: Object.fromEntries(channels.map((c) => [c.id, c])) });

describe('plan', () => {
  it('writes only what differs', () => {
    const snap = mix(ch('t1', 'Vocal', { gain: -6, mute: 0, 'pan.0': 0.5 }));
    const now = mix(ch('t1', 'Vocal', { gain: 0, mute: 0, 'pan.0': 0.5 }));
    expect(M.plan(snap, now, ALL).writes).toEqual([{ ch: 't1', key: 'gain', value: -6 }]);
  });

  it('ignores float noise', () => {
    const snap = mix(ch('t1', 'Vocal', { gain: -5.6 }));
    const now = mix(ch('t1', 'Vocal', { gain: -5.599999904632568 }));
    expect(M.size(M.plan(snap, now, ALL))).toBe(0);
  });

  it('recalls only the ticked categories', () => {
    const snap = mix(ch('t1', 'Vocal', { gain: -6, mute: 1, 'pan.0': 0.2, 'send.send_0.gain': -10, 'fx.effect_0.Ratio': 4 }, { fx: { effect_0: 'comp' } }));
    const now = mix(ch('t1', 'Vocal', { gain: 0, mute: 0, 'pan.0': 0.5, 'send.send_0.gain': 0, 'fx.effect_0.Ratio': 2 }, { fx: { effect_0: 'comp' } }));
    const keys = (scope) => M.plan(snap, now, scope).writes.map((w) => w.key);
    expect(keys({ levels: true })).toEqual(['gain']);
    expect(keys({ pans: true, sends: true })).toEqual(['pan.0', 'send.send_0.gain']);
    expect(keys({ mutes: true, plugins: true })).toEqual(['mute', 'fx.effect_0.Ratio']);
  });

  it('replaces a lane that changed, and clears one that is new', () => {
    const snap = mix(ch('t1', 'Vocal', { gain: 0, mute: 0 }, { a: { gain: [0, -10, 100, -3] } }));
    const now = mix(ch('t1', 'Vocal', { gain: 0, mute: 0 }, { a: { gain: [0, -10, 100, -6], mute: [0, 1] } }));
    const p = M.plan(snap, now, ALL);
    expect(p.lanes).toEqual([
      { ch: 't1', key: 'gain', points: [0, -10, 100, -3], had: [0, -10, 100, -6] },
      { ch: 't1', key: 'mute', points: null, had: [0, 1] },
    ]);
    expect(M.plan(snap, now, { ...ALL, automation: false }).lanes).toEqual([]);
    expect(M.plan(snap, now, { ...ALL, mutes: false }).lanes.map((l) => l.key)).toEqual(['gain']);
  });

  it("doesn't write a value its lane decides", () => {
    const snap = mix(ch('t1', 'Vocal', { gain: 0.5 }, { a: { gain: [0, -10] } }));
    const now = mix(ch('t1', 'Vocal', { gain: 0.4 }, { a: { gain: [0, -10] } }));
    expect(M.size(M.plan(snap, now, ALL))).toBe(0);
    // without automation the current lane still decides it, so nothing is written either
    expect(M.plan(snap, now, { ...ALL, automation: false }).writes).toHaveLength(0);
    const noLane = mix(ch('t1', 'Vocal', { gain: 0.4 }));
    expect(M.plan(snap, noLane, { ...ALL, automation: false }).writes).toHaveLength(1);
    // with the track's automation off, the value counts
    const off = mix(ch('t1', 'Vocal', { gain: 0.5 }, { mode: 'off', a: { gain: [0, -10] } }));
    expect(M.plan(off, now, ALL).writes).toHaveLength(1);
  });

  it('restores automation modes with automation ticked', () => {
    const snap = mix(ch('t1', 'Vocal', {}, { mode: 'read' }));
    const now = mix(ch('t1', 'Vocal', {}, { mode: 'off' }));
    expect(M.plan(snap, now, ALL).modes).toEqual([{ ch: 't1', mode: 'read' }]);
    expect(M.plan(snap, now, { ...ALL, automation: false }).modes).toEqual([]);
  });

  it('finds a track by name when its id changed, and reports one that is gone', () => {
    const snap = mix(ch('old', 'Vocal', { gain: -6 }), ch('t9', 'Gone', { gain: -1 }));
    const now = mix(ch('new', 'Vocal', { gain: 0 }));
    const p = M.plan(snap, now, ALL);
    expect(p.writes).toEqual([{ ch: 'new', key: 'gain', value: -6 }]);
    expect(p.missing).toEqual(['track “Gone”']);
  });

  it('skips a plug-in that was swapped, and says so', () => {
    const snap = mix(ch('t1', 'Vocal', { gain: -6, 'fx.effect_0.Ratio': 4 }, { fx: { effect_0: 'comp' } }));
    const now = mix(ch('t1', 'Vocal', { gain: 0, 'fx.effect_0.Ratio': 2 }, { fx: { effect_0: 'eq' } }));
    const p = M.plan(snap, now, ALL);
    expect(p.writes.map((w) => w.key)).toEqual(['gain']);
    expect(p.missing).toEqual(['a plug-in on “Vocal”']);
  });
});

// ---------------------------------------------------------------- against the mock engine
describe('capture and recall', () => {
  it('captures every track and the master, with values', async () => {
    const { session } = await connected();
    const { data } = await M.capture(session, { name: 'Mine' });
    const names = Object.values(data.channels).map((c) => c.name);
    expect(names.slice(0, 3)).toEqual(['Vocal', 'Bass', 'Drums']);
    const vocal = Object.values(data.channels).find((c) => c.name === 'Vocal');
    expect(vocal.c).toHaveProperty('gain');
    expect(vocal.c).toHaveProperty('mute');
  });

  it("recalls the master's automation mode, not only the tracks'", async () => {
    // SDK 3.1.2 Update 1 moved setAutomationMode from Track to Channel, so buses and the
    // master take it too (before, recall skipped them).
    const { engine, session } = await connected();
    const master = session.master;
    await master.setAutomationMode('touch');
    await engine.settled();
    const { data: saved } = await M.capture(session, { name: 'Mine' });
    expect(saved.channels[master.id].mode).toBe('touch');

    await master.setAutomationMode('latch');
    await engine.settled();
    await M.recall(session, saved, ALL);
    await engine.settled();
    expect(master.automationMode.value).toBe('touch');
  });

  it('recalls levels, mutes and an automation lane as one undo step', async () => {
    const { engine, session } = await connected();
    const vocal = track(session, 'Vocal');
    await vocal.loadStrip();
    await vocal.gain.automation.insert([{ tick: 0, value: -12 }, { tick: Luna.WHOLE_NOTE, value: -3 }]);
    await engine.settled();
    const { data: saved } = await M.capture(session, { name: 'Mine' });

    // the client's changes
    await vocal.gain.real.set(-20);
    await vocal.mute.real.set(true);
    await vocal.gain.automation.clear(0, Luna.WHOLE_NOTE);
    await vocal.gain.automation.insert([{ tick: 0, value: -1 }]);
    await engine.settled();

    engine.transactions.length = 0;
    const plan = await M.recall(session, saved, ALL);
    await engine.settled();
    expect(plan.writes.map((w) => w.key)).toEqual(['mute']); // the fader has a lane: the lane decides it
    expect(plan.lanes.map((l) => l.key)).toEqual(['gain']);
    expect(engine.transactions).toEqual(['begin', 'commit']);

    const { data: now } = await M.capture(session);
    const v = (d) => Object.values(d.channels).find((c) => c.name === 'Vocal');
    expect(v(now).c.mute).toBe(v(saved).c.mute);
    expect(v(now).a.gain).toEqual(v(saved).a.gain);
    expect(M.size(M.plan(saved, now, ALL))).toBe(0);
  });

  it('does nothing when the mix already matches', async () => {
    const { engine, session } = await connected();
    const { data } = await M.capture(session);
    engine.transactions.length = 0;
    const plan = await M.recall(session, data, ALL);
    expect(M.size(plan)).toBe(0);
    expect(engine.transactions).toEqual([]);
  });

  it('leaves the categories that are not ticked', async () => {
    const { engine, session } = await connected();
    const bass = track(session, 'Bass');
    await bass.loadStrip();
    const { data: saved } = await M.capture(session);
    await bass.gain.real.set(-9);
    await bass.mute.real.set(true);
    await engine.settled();
    await M.recall(session, saved, { mutes: true });
    await engine.settled();
    expect(bass.mute.on).toBe(false);
    expect(bass.gain.real.value).toBeCloseTo(-9);
  });
});

describe('storage', () => {
  it('saves, lists, loads, renames and removes snapshots', async () => {
    const { session } = await connected();
    const { data } = await M.capture(session, { name: 'My mix' });
    const id = await M.save(session, data);
    expect(await M.list(session)).toEqual([{ id, name: 'My mix', at: data.at }]);
    expect(await M.load(session, id)).toEqual({ name: 'My mix', at: data.at, channels: data.channels });

    await M.rename(session, id, 'Client mix');
    expect((await M.list(session))[0].name).toBe('Client mix');

    // an update replaces it, keeping its place (its `at`)
    const id2 = await M.save(session, { ...data, name: 'Client mix' }, { replace: id });
    expect(id2).not.toBe(id);
    expect(await M.list(session)).toEqual([{ id: id2, name: 'Client mix', at: data.at }]);

    await M.remove(session, id2);
    expect(await M.list(session)).toEqual([]);
  });
});
