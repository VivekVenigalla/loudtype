// Sends caption events to the overlay over localhost and keeps an in-memory
// recording (for offline replay). Nothing is written to disk unless the
// creator clicks Save or Export.

// Replay keeps the last 10 minutes, so a long stream can't grow memory without
// bound (every partial re-sends its whole line). Export doesn't use this: each
// session keeps its own finished lines.
const KEEP_MS = 10 * 60 * 1000;

export class Recording {
  constructor(clock = () => performance.now()) {
    this.clock = clock;
    this.reset();
  }

  reset() {
    this.events = [];
    this.t0 = this.clock();
  }

  add(msg) {
    const t = Math.round(this.clock() - this.t0);
    this.events.push({ t, msg });
    if (this.events[0].t < t - KEEP_MS) this.events.splice(0, this.events.findIndex((e) => e.t >= t - KEEP_MS));
  }
}

export class Relay {
  constructor() {
    this.ws = null;
    this.rec = new Recording();
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(`ws://${location.host}/relay`);
    this.ws.onclose = () => setTimeout(() => this.connect(), 1000);
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
  get recording() { return this.rec.events; }

  send(msg, { record = true } = {}) {
    if (record) this.rec.add(msg);
    if (this.connected) this.ws.send(JSON.stringify(msg));
  }

  resetRecording() {
    this.rec.reset();
  }

  /** Re-emits recorded events with their original spacing. Returns a stop fn. */
  play(events, onDone) {
    // A trimmed recording starts minutes in; start playing at its first event.
    const first = events.reduce((m, e) => Math.min(m, e.t), Infinity);
    const offset = Number.isFinite(first) ? first : 0;
    const timers = events.map(({ t, msg }) => setTimeout(() => this.send(msg, { record: false }), t - offset));
    const end = events.reduce((m, e) => Math.max(m, e.t - offset), 0) + 100;
    timers.push(setTimeout(() => onDone?.(), end));
    return () => timers.forEach(clearTimeout);
  }
}
