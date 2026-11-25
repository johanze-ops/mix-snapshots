// Mix Snapshots: capture a session's mix and recall it. No DOM here, so the tests can run it
// against Luna.MockEngine.
//
// A snapshot holds, for every channel (tracks, aux buses, the master; not the cue buses):
//   - the value of every fader, mute, pan, send level and send mute, every plug-in parameter,
//     and whether each plug-in is in;
//   - the automation lane of each of those controls, when it has points;
//   - the track's automation mode.
// A recall compares the snapshot with a fresh capture and writes only what differs, all in one
// batch transaction, so it is one undo step (measured on LUNA 3.1.2: values, lanes and modes
// all come back with one undo).
//
// Stored in session storage, context com.ranrun.mix_snapshots: one record per snapshot, one
// field per channel ('ch.<channel id>') plus 'meta' ({name, at, chs}), written last, so a
// half-written snapshot never lists. A field is kept small this way (LUNA refused a 255 KB one).

const CONTEXT = 'com.ranrun.mix_snapshots';
const CATEGORIES = ['levels', 'pans', 'mutes', 'sends', 'plugins'];

/** Which recall tick a control belongs to. */
function categoryOf(key) {
  if (key === 'gain') return 'levels';
  if (key === 'mute') return 'mutes';
  if (key.startsWith('pan.')) return 'pans';
  if (key.startsWith('send.')) return 'sends';
  return 'plugins';
}

/** The plug-in slot a 'fx.<slot>.<param>' key belongs to, or null. */
function slotOf(key) {
  if (!key.startsWith('fx.')) return null;
  return key.slice(3, key.indexOf('.', 3));
}

function differs(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a));
  return a !== b;
}

/** Two lanes as flat [tick, value, tick, value...] arrays (or null). */
function sameLane(a, b) {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (differs(x[i], y[i])) return false;
  return true;
}

/** Run `fn` over `items`, `width` at a time. */
async function pool(items, width, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

const fieldFor = (channelId) => `ch.${String(channelId).replace(/\//g, '_')}`;

const MixLogic = {
  CONTEXT,
  CATEGORIES,
  categoryOf,
  sameLane,

  /** The channels a mix lives on: tracks in LUNA's order, aux buses, then the master. */
  channels(session) {
    const out = [];
    const seen = new Set();
    const add = (ch) => {
      if (!ch || seen.has(ch.id)) return;
      const type = ch.busType?.value;
      if (typeof type === 'string' && type.startsWith('cue')) return;
      seen.add(ch.id);
      out.push(ch);
    };
    for (const t of session.visibleTracks) add(t);
    for (const b of session.buses?.items ?? []) if (b.busType?.value !== 'master') add(b);
    add(session.master);
    return out;
  },

  /** A channel's mix controls as [{key, control}] (or {key, effect} for a plug-in's in/out). */
  async controlsOf(ch) {
    const list = [];
    const fx = {};
    try { await ch.loadStrip?.(); } catch { /* a channel without a strip */ }
    if (ch.gain) list.push({ key: 'gain', control: ch.gain });
    if (ch.mute) list.push({ key: 'mute', control: ch.mute });
    (ch.main?.pans ?? []).forEach((p, i) => list.push({ key: `pan.${i}`, control: p }));
    try {
      await ch.outputs.load();
      for (const o of ch.outputs.items) {
        if (!o.isSend || !o.assigned) continue;
        list.push({ key: `send.${o.id}.gain`, control: o.gain });
        if (o.mute) list.push({ key: `send.${o.id}.mute`, control: o.mute });
      }
    } catch { /* no sends */ }
    try {
      await ch.effects.load();
      for (const e of ch.effects.items) {
        const pluginId = e.pluginId?.value;
        const params = e.params ?? [];
        if (!pluginId || !params.length) continue; // empty slots and shortcuts (alias.console)
        fx[e.id] = pluginId;
        list.push({ key: `fx.${e.id}.@in`, effect: e });
        const count = {};
        for (const p of params) {
          const n = p.name.value ?? p.id;
          count[n] = (count[n] ?? 0) + 1;
          list.push({ key: `fx.${e.id}.${count[n] > 1 ? `${n}#${count[n]}` : n}`, control: p });
        }
      }
    } catch { /* no plug-ins */ }
    return { list, fx };
  },

  /**
   * The mix as it is now. Returns {data, handles}: `data` is plain JSON (what a snapshot
   * stores), `handles` maps channel id -> {ch, entries: Map(key -> {control | effect})}.
   */
  async capture(session, { name = '' } = {}) {
    const data = { name, at: Date.now(), channels: {} };
    const handles = new Map();
    for (const ch of MixLogic.channels(session)) {
      const { list, fx } = await MixLogic.controlsOf(ch);
      handles.set(ch.id, { ch, entries: new Map(list.map((x) => [x.key, x])) });
      const c = {};
      // Values as LUNA's 0..1 position: the view every control (faders, switches, plug-in
      // parameters) takes a write in. Lanes keep LUNA's native values.
      for (const x of list) c[x.key] = x.effect ? x.effect.in.value !== false : x.control.normalized.value;
      data.channels[ch.id] = { id: ch.id, name: ch.name.value ?? ch.id, mode: ch.automationMode?.value ?? null, fx, c, a: {} };
    }
    const lanes = [];
    for (const [id, h] of handles) for (const x of h.entries.values()) if (x.control && x.control.automatable?.value !== false) lanes.push([id, x]);
    await pool(lanes, 32, async ([id, x]) => {
      try {
        await x.control.automation.load();
        const points = x.control.automation.breakpoints;
        if (points.length) data.channels[id].a[x.key] = points.flatMap((p) => [p.tick, p.value]);
      } catch { /* a control without a lane */ }
    });
    return { data, handles };
  },

  /** Find the channel a snapshot's channel is now: same id, else the only one with its name. */
  match(current, saved) {
    if (current.channels[saved.id]) return current.channels[saved.id];
    const named = Object.values(current.channels).filter((c) => c.name === saved.name);
    return named.length === 1 ? named[0] : null;
  },

  /**
   * What a recall of `snap` changes in `current` (both capture data). `scope` has a boolean per
   * category plus `automation` (lanes and modes, for the ticked categories). Returns
   * {writes: [{ch, key, value}], lanes: [{ch, key, points, had}], modes: [{ch, mode}],
   *  missing: [text]} where `missing` says what couldn't be found (a deleted track, a plug-in
   * that was swapped or removed).
   */
  plan(snap, current, scope) {
    const writes = [];
    const lanes = [];
    const modes = [];
    const missing = [];
    for (const saved of Object.values(snap.channels)) {
      const now = MixLogic.match(current, saved);
      if (!now) { missing.push({ kind: 'track', name: saved.name }); continue; }
      const goneSlots = new Set();
      if (scope.plugins) {
        for (const [slot, pluginId] of Object.entries(saved.fx ?? {})) {
          if (now.fx?.[slot] !== pluginId) { goneSlots.add(slot); missing.push({ kind: 'plugin', track: saved.name }); }
        }
      }
      for (const [key, value] of Object.entries(saved.c)) {
        if (!scope[categoryOf(key)]) continue;
        const slot = slotOf(key);
        if (slot && goneSlots.has(slot)) continue;
        if (!(key in now.c)) continue; // e.g. a send that's no longer assigned
        // A control with a lane, on a track that reads automation, takes its value from the
        // lane at the playhead: the stored value means nothing there.
        const laneRules = (scope.automation ? saved.a?.[key] && saved.mode !== 'off' : now.a?.[key] && now.mode !== 'off');
        if (!laneRules && differs(value, now.c[key])) writes.push({ ch: now.id, key, value });
        if (scope.automation && !key.endsWith('.@in')) {
          const was = saved.a?.[key] ?? null;
          const is = now.a?.[key] ?? null;
          if (!sameLane(was, is)) lanes.push({ ch: now.id, key, points: was, had: is });
        }
      }
      if (scope.automation && saved.mode && now.mode && saved.mode !== now.mode) modes.push({ ch: now.id, mode: saved.mode });
    }
    return { writes, lanes, modes, missing: MixLogic.unique(missing) };
  },

  /** Items without repeats ({kind: 'track', name} and the like, compared by content). */
  unique(items) {
    return [...new Map(items.map((x) => [JSON.stringify(x), x])).values()];
  },

  /** How many things a plan changes. */
  size(plan) {
    return plan.writes.length + plan.lanes.length + plan.modes.length;
  },

  /**
   * Runs `fn` with no tracks selected, then selects the same tracks again (also when `fn` fails).
   * LUNA's selection grouping applies a change on one of several selected tracks to all of them,
   * SDK writes included (measured 2026-11-25, LUNA 3.1.2: a fader write on one of two selected
   * tracks moved both; playlist copies and renames spread the same way). Selection writes aren't
   * undo steps.
   */
  async withoutSelection(session, fn) {
    const c = session.context;
    const selected = Array.isArray(c?.selectionTracks?.value) ? [...c.selectionTracks.value] : [];
    if (!selected.length) return fn();
    const saved = c.snapshot();
    await c.select({ trackUids: [], playlistUids: [] });
    try {
      return await fn();
    } finally {
      // The same selection, naming the playlists the tracks play now: `fn` may have switched
      // them, and a selection naming a playlist its track no longer plays makes LUNA assert.
      const { ids, playlists } = await MixLogic.playing(session, selected);
      await c.restore({ ...saved, selection_tracks: ids, selection_playlists: playlists }).catch(() => {});
    }
  },

  /**
   * The tracks of `ids` that still exist, and the playlist each plays, read from LUNA. The SDK's
   * own copy lags inside a batch transaction (LUNA holds its pushes until the commit).
   */
  async playing(session, ids) {
    const tracks = ids.map((id) => session.tracks.items.find((t) => t.id === id)).filter(Boolean);
    await Promise.all(tracks.map((t) => t.reload({ propfilter: ['playlist_uid'], children: false, commands: false }).catch(() => {})));
    const live = tracks.filter((t) => t.playlistUid?.value);
    return { ids: live.map((t) => t.id), playlists: live.map((t) => t.playlistUid.value) };
  },

  /** Carry out a plan as one undo step named `name`, with no tracks selected (see withoutSelection). */
  async apply(session, plan, handles, { name = 'Recall mix snapshot' } = {}) {
    if (!MixLogic.size(plan)) return;
    const entry = (ch, key) => handles.get(ch)?.entries.get(key);
    await MixLogic.withoutSelection(session, () => session.transaction(name, async () => {
      // Lanes first: a value written under a lane in Read would be read straight back from it.
      for (const l of plan.lanes) {
        const ctl = entry(l.ch, l.key)?.control;
        if (!ctl) continue;
        if (l.had?.length) await ctl.automation.clear(l.had[0], l.had[l.had.length - 2]);
        const points = [];
        for (let i = 0; i < (l.points?.length ?? 0); i += 2) points.push({ tick: l.points[i], value: l.points[i + 1] });
        for (let i = 0; i < points.length; i += 250) await ctl.automation.insert(points.slice(i, i + 250));
      }
      await pool(plan.writes, 16, async (w) => {
        const x = entry(w.ch, w.key);
        if (x?.effect) await x.effect.setIn(!!w.value);
        else if (x?.control) await x.control.normalized.set(w.value);
      });
      for (const m of plan.modes) {
        const ch = handles.get(m.ch)?.ch;
        if (typeof ch?.setAutomationMode === 'function') await ch.setAutomationMode(m.mode);
      }
    }));
  },

  /** Capture, plan and apply in one go. Returns the plan (with `missing`). */
  async recall(session, snap, scope, options) {
    const { data, handles } = await MixLogic.capture(session);
    const plan = MixLogic.plan(snap, data, scope);
    await MixLogic.apply(session, plan, handles, options);
    return plan;
  },

  // ------------------------------------------------------------ storage
  async store(session) {
    const store = session.storage.context(CONTEXT);
    await store.load();
    return store;
  },

  /** The snapshots in this session, oldest first: [{id, name, at}]. */
  async list(session) {
    const store = await MixLogic.store(session);
    return (store.records.value ?? [])
      .map((id) => ({ id, ...(store.value(id, 'meta').value ?? {}) }))
      .filter((s) => s.name)
      .sort((a, b) => a.at - b.at)
      .map(({ id, name, at }) => ({ id, name, at }));
  },

  /**
   * Save capture data as a new snapshot and return its id. With `replace`, the snapshot with
   * that id is removed once the new one is written (re-adding a record LUNA is removing can
   * lose it, so an update gets a new id). Not an undo step.
   */
  async save(session, data, { replace } = {}) {
    const store = await MixLogic.store(session);
    const id = `s${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
    const ids = Object.keys(data.channels);
    await Promise.all(ids.map((cid) => store.add(id, fieldFor(cid), data.channels[cid])));
    await store.add(id, 'meta', { name: data.name, at: data.at, chs: ids });
    if (replace && replace !== id) await MixLogic.remove(session, replace);
    return id;
  },

  /** A saved snapshot as capture data, or null. */
  async load(session, id) {
    const store = await MixLogic.store(session);
    const meta = store.value(id, 'meta').value;
    if (!meta) return null;
    const channels = {};
    for (const cid of meta.chs ?? []) {
      const ch = store.value(id, fieldFor(cid)).value;
      if (ch) channels[cid] = ch;
    }
    return { name: meta.name, at: meta.at, channels };
  },

  async rename(session, id, name) {
    const store = await MixLogic.store(session);
    const meta = store.value(id, 'meta').value;
    if (meta) await store.set(id, 'meta', { ...meta, name });
  },

  async remove(session, id) {
    const store = await MixLogic.store(session);
    if ((store.records.value ?? []).includes(id)) await store.remove(id);
  },

  /** Reads the session's newest undo entry id (changes with every command, goes back on undo). */
  undoReader(luna, session) {
    return async () => {
      const r = await luna.raw.get(session.path, { children: false, commands: false, flatvalue: true, propfilter: ['undo_uid'] });
      return (r?.properties ?? r)?.undo_uid;
    };
  },
};

globalThis.MixLogic = MixLogic;
