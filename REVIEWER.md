# Notes for the LUNA Add On reviewer

**What it does:** saves a session's whole mix as named snapshots and recalls them, all or by
category (levels, pans, mutes, sends, plug-ins, with or without their automation), and A/B
flips between two. Each recall is one undo step.

**How it uses LUNA** (documented SDK APIs, plus one raw read; no helper, no network):

- **Capture:** for each track, aux bus and the master (cue buses skipped): `loadStrip()`, the
  main output's gain/mute/pans, assigned sends' gain/mute (`outputs`), and every loaded
  effect's `params` and `in` (`effects`). Values are stored as each control's `normalized`
  value. Each control's `automation` lane is loaded and its breakpoints kept, with the
  channel's `automationMode`.
- **Recall:** a fresh capture is compared with the snapshot and only differences are written,
  inside one batch `session.transaction()`: `automation.clear()` + `automation.insert()` for
  changed lanes, then `normalized.set()` / `effect.setIn()` for values, then
  `setAutomationMode()`. Values of controls whose lane decides them (lane present, mode not
  off) are not written.
- **A/B flip:** reads the session's `undo_uid` with `luna.raw.get` (propfilter) after a flip;
  on the next flip, if it's unchanged (nothing else happened), it `undo(1)`s its own recall
  before recalling the other side, so flipping doesn't fill the undo list.
- **Storage:** session storage context `com.ranrun.mix_snapshots`: one record per snapshot,
  one field per channel plus a `meta` field written last; writes are not undoable. The
  recall ticks are in the page's `localStorage`, keyed by the Add On id.

**Tested on** LUNA 3.1.2.4693, macOS 15.6 (Apple Silicon): a test session with API Vision on a
track, ATR-102 and 2500 on the master, a Pure Plate aux with a send, and volume, send and plug-in
parameter automation. A scripted round trip (save, change fader/mute/pan/send/plug-in knob,
plug-in in/out, a volume lane and an automation mode, recall) leaves nothing different, and
one Undo gives the changed mix back exactly. Capture of LUNA's demo session (31 channels,
1,941 controls) takes about 0.2 s; a recall about 0.3 s. Not tested on Windows.

**Quick test:** open a session, Add Ons > Windows > Mix Snapshots, Save, move a few faders and
a plug-in knob, Recall, then Undo once.
