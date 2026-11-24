// Mix Snapshots: DOM wiring. Follows the focused session, lists its snapshots, and saves,
// recalls and A/B-flips them through MixLogic. The recall ticks are kept for all sessions in
// this page's localStorage; the A/B assignment is kept in the session (session storage).

const BUILD = 'b3';
const $ = (id) => document.getElementById(id);
const SCOPE_KEY = `${MixLogic.CONTEXT}.scope`;
const UI_RECORD = 'ui';

let luna;
let session;
let readUndo;
let snaps = []; // [{id, name, at}]
let ab = { a: null, b: null };
let abOn = null; // 'a' | 'b' while an A/B recall is the current state
let abMark = null; // the undo entry our last A/B recall left: flipping replaces it
let lastId = null; // the snapshot last saved or recalled
let busy = false;
let releases = [];
const keep = (u) => releases.push(u);

// ---------------------------------------------------------------- small helpers
function message(text, kind = '') {
  $('message').textContent = text;
  $('message').className = kind;
}

function scope() {
  const s = {};
  for (const box of document.querySelectorAll('#ticks input')) s[box.dataset.k] = box.checked;
  return s;
}

function loadScope() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SCOPE_KEY) ?? '{}'); } catch { /* fresh */ }
  for (const box of document.querySelectorAll('#ticks input')) {
    box.checked = saved[box.dataset.k] !== false;
    box.onchange = () => localStorage.setItem(SCOPE_KEY, JSON.stringify(scope()));
  }
}

function when(at) {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const nameOf = (id) => snaps.find((s) => s.id === id)?.name;

/** Run one action at a time, with the buttons off while it runs. */
async function run(fn) {
  if (busy || !session) return;
  busy = true;
  paint();
  try { await fn(); } catch (e) { message(`Something went wrong: ${e.code ?? e.message}`, 'warn'); } finally { busy = false; paint(); }
}

function report(plan, name) {
  const n = MixLogic.size(plan);
  const parts = [];
  if (plan.writes.length) parts.push(`${plan.writes.length} setting${plan.writes.length === 1 ? '' : 's'}`);
  if (plan.lanes.length) parts.push(`${plan.lanes.length} automation lane${plan.lanes.length === 1 ? '' : 's'}`);
  if (plan.modes.length) parts.push(`${plan.modes.length} automation mode${plan.modes.length === 1 ? '' : 's'}`);
  let text = n ? `Recalled “${name}”: ${parts.join(', ')} (one undo).` : `“${name}”: the mix already matches.`;
  if (plan.missing.length) text += ` Not found: ${plan.missing.join(', ')}.`;
  message(text, plan.missing.length ? 'warn' : 'ok');
}

// ---------------------------------------------------------------- storage of the A/B pair
async function loadAB() {
  const store = await MixLogic.store(session);
  const v = store.value(UI_RECORD, 'ab').value ?? {};
  const ids = new Set(snaps.map((s) => s.id));
  ab = { a: ids.has(v.a) ? v.a : null, b: ids.has(v.b) ? v.b : null };
}

async function saveAB() {
  const store = await MixLogic.store(session);
  if (store.value(UI_RECORD, 'ab').value === undefined) await store.add(UI_RECORD, 'ab', ab);
  else await store.set(UI_RECORD, 'ab', ab);
}

// ---------------------------------------------------------------- actions
async function refresh() {
  snaps = await MixLogic.list(session);
  await loadAB();
  render();
}

function save() {
  return run(async () => {
    const name = $('name').value.trim() || `Snapshot ${snaps.length + 1}`;
    const { data } = await MixLogic.capture(session, { name });
    lastId = await MixLogic.save(session, data);
    $('name').value = '';
    await refresh();
    const lanes = Object.values(data.channels).reduce((n, c) => n + Object.keys(c.a).length, 0);
    message(`Saved “${name}”: ${Object.keys(data.channels).length} channels${lanes ? `, ${lanes} automation lane${lanes === 1 ? '' : 's'}` : ''}.`, 'ok');
  });
}

/** Recall a snapshot. From the A/B buttons, a flip replaces the previous A/B recall in the undo list. */
function recall(id, { side = null } = {}) {
  return run(async () => {
    const snap = await MixLogic.load(session, id);
    if (!snap) { message('That snapshot is gone.', 'warn'); return refresh(); }
    const sc = scope();
    if (!MixLogic.CATEGORIES.some((k) => sc[k])) { message('Tick something to recall first.', 'warn'); return; }
    if (side && abMark && (await readUndo()) === abMark) await session.undo(1);
    const plan = await MixLogic.recall(session, snap, sc, { name: `Recall “${snap.name}”` });
    abMark = side && MixLogic.size(plan) ? await readUndo() : null;
    abOn = side ?? (id === ab.a ? 'a' : id === ab.b ? 'b' : null);
    lastId = id;
    report(plan, snap.name);
  });
}

function recallSide(side) {
  if (!ab[side]) { message(`Set ${side.toUpperCase()} with the ${side.toUpperCase()} chip on a snapshot.`, 'warn'); return; }
  return recall(ab[side], { side });
}

function flip() {
  if (!ab.a || !ab.b) { message('Set both A and B first.', 'warn'); return; }
  return recallSide(abOn === 'a' ? 'b' : 'a');
}

function update(id) {
  return run(async () => {
    const old = snaps.find((s) => s.id === id);
    if (!old) return;
    const { data } = await MixLogic.capture(session, { name: old.name });
    data.at = old.at; // keep its place in the list
    const fresh = await MixLogic.save(session, data, { replace: id });
    for (const side of ['a', 'b']) if (ab[side] === id) ab[side] = fresh;
    if (lastId === id) lastId = fresh;
    await saveAB();
    await refresh();
    message(`Updated “${old.name}” to the mix as it is now.`, 'ok');
  });
}

function remove(id) {
  return run(async () => {
    const name = nameOf(id);
    await MixLogic.remove(session, id);
    for (const side of ['a', 'b']) if (ab[side] === id) ab[side] = null;
    await saveAB();
    await refresh();
    message(`Deleted “${name}”.`);
  });
}

function setSide(side, id) {
  return run(async () => {
    ab[side] = ab[side] === id ? null : id;
    if (ab[side] && ab[side] === ab[side === 'a' ? 'b' : 'a']) ab[side === 'a' ? 'b' : 'a'] = null;
    abMark = null;
    await saveAB();
    render();
  });
}

function rename(id, row) {
  const old = nameOf(id);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = old;
  input.maxLength = 60;
  const name = row.querySelector('.name');
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (!ok || !v || v === old) return render();
    run(async () => { await MixLogic.rename(session, id, v); await refresh(); });
  };
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    ev.stopPropagation();
  };
  input.onblur = () => finish(true);
}

/** A button that asks "Sure?" on the first click and acts on the second. */
function confirmButton(label, title, act) {
  const b = document.createElement('button');
  b.className = 'icon';
  b.textContent = label;
  b.title = title;
  let armed = null;
  b.onclick = () => {
    if (armed) { clearTimeout(armed); armed = null; act(); return; }
    b.textContent = 'Sure?';
    b.style.width = 'auto';
    armed = setTimeout(() => { armed = null; b.textContent = label; b.style.width = ''; }, 2500);
  };
  return b;
}

// ---------------------------------------------------------------- paint
function render() {
  const root = $('list');
  root.innerHTML = '';
  $('count').textContent = snaps.length ? `${snaps.length}` : '';
  if (!session) {
    root.innerHTML = '<div class="empty">Open a session in LUNA.</div>';
  } else if (!snaps.length) {
    root.innerHTML = '<div class="empty">No snapshots in this session yet. Save one: every fader, pan, mute, send and plug-in setting, with their automation.</div>';
  }
  for (const s of [...snaps].reverse()) {
    const row = document.createElement('div');
    row.className = `snap${s.id === lastId ? ' last' : ''}`;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    name.title = 'Double-click to rename';
    name.ondblclick = () => rename(s.id, row);
    const at = document.createElement('span');
    at.className = 'when';
    at.textContent = when(s.at);
    const chip = (side) => {
      const b = document.createElement('button');
      b.className = `chip ${side}${ab[side] === s.id ? ' on' : ''}`;
      b.textContent = side.toUpperCase();
      b.title = ab[side] === s.id ? `Clear ${side.toUpperCase()}` : `Make this ${side.toUpperCase()}`;
      b.onclick = () => setSide(side, s.id);
      return b;
    };
    const go = document.createElement('button');
    go.textContent = 'Recall';
    go.title = 'Recall this snapshot (what is ticked below), as one undo step';
    go.onclick = () => recall(s.id);
    row.append(name, at, chip('a'), chip('b'), go,
      confirmButton('↻', 'Update: replace this snapshot with the mix as it is now', () => update(s.id)),
      confirmButton('×', 'Delete this snapshot', () => remove(s.id)));
    root.appendChild(row);
  }
  paint();
}

function paint() {
  for (const side of ['a', 'b']) {
    const el = $(side === 'a' ? 'sideA' : 'sideB');
    el.querySelector('span').textContent = nameOf(ab[side]) ?? 'not set';
    el.classList.toggle('on', abOn === side);
    el.disabled = busy || !session;
  }
  $('flip').disabled = busy || !session || !ab.a || !ab.b;
  $('save').disabled = busy || !session;
  for (const b of document.querySelectorAll('#list button')) b.disabled = busy;
}

// ---------------------------------------------------------------- session
async function bindSession() {
  for (const u of releases) u();
  releases = [];
  session = luna.sessions.current();
  snaps = [];
  ab = { a: null, b: null };
  abOn = null;
  abMark = null;
  lastId = null;
  message('');
  if (!session) {
    $('status').textContent = 'no session open';
    render();
    return;
  }
  await session.ready();
  $('status').textContent = session.name.value ?? '';
  keep(session.name.onChange(() => { $('status').textContent = session.name.value ?? ''; }));
  readUndo = MixLogic.undoReader(luna, session);
  try { await refresh(); } catch (e) { message(`Couldn't read the snapshots: ${e.code ?? e.message}`, 'warn'); }
}

// ---------------------------------------------------------------- start
$('build').textContent = BUILD;
$('title').ondblclick = () => location.reload();
$('save').onclick = save;
$('name').onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } };
$('sideA').onclick = () => recallSide('a');
$('sideB').onclick = () => recallSide('b');
$('flip').onclick = flip;
document.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement && ev.target.type === 'text') return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k === 'a' || k === 'b') { ev.preventDefault(); recallSide(k); }
  if (ev.key === 'Tab') { ev.preventDefault(); flip(); }
});
loadScope();
render();

(async function connect() {
  for (;;) {
    try { luna = await Luna.connect(); break; } catch (e) {
      $('status').textContent = e instanceof Luna.NotRunning ? 'waiting for LUNA...' : e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  luna.status.onChange(() => { if (luna.status.value === 'disconnected') $('status').textContent = 'reconnecting...'; });
  await bindSession();
})();
