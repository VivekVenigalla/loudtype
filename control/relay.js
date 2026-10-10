// Sends caption events to the overlay over localhost and keeps an in-memory
// recording (for offline replay and export). Nothing is written to disk
// unless the creator clicks Save or Export.
export class Relay {
  constructor() {
    this.ws = null;
    this.recording = [];
    this.t0 = performance.now();
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(`ws://${location.host}/relay`);
    this.ws.onclose = () => setTimeout(() => this.connect(), 1000);
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

  send(msg, { record = true } = {}) {
    if (record) this.recording.push({ t: Math.round(performance.now() - this.t0), msg });
    if (this.connected) this.ws.send(JSON.stringify(msg));
  }

  resetRecording() {
    this.recording = [];
    this.t0 = performance.now();
  }

  /** Re-emits recorded events with their original timing. Returns a stop fn. */
  play(events, onDone) {
    const timers = events.map(({ t, msg }) => setTimeout(() => this.send(msg, { record: false }), t));
    const end = Math.max(0, ...events.map((e) => e.t)) + 100;
    timers.push(setTimeout(() => onDone?.(), end));
    return () => timers.forEach(clearTimeout);
  }
}
