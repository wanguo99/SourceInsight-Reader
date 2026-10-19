'use strict';
class Observable {
  constructor() { this.listeners = new Set(); this.disposed = false; }
  subscribe(listener) { if (!this.disposed) this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
  emit(value) { if (!this.disposed) for (const listener of this.listeners) listener(value); }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
module.exports = { Observable };
