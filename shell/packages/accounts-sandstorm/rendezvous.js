export class LoginRendezvous {
  constructor({ maxPending, timeoutMs, makeError }) {
    this.maxPending = maxPending;
    this.timeoutMs = timeoutMs;
    this.makeError = makeError;
    this.pending = new Map();
  }

  wait(token) {
    if (this.pending.size >= this.maxPending) {
      throw this.makeError(503, "Too many Sandstorm logins are pending.");
    }

    if (this.pending.has(token)) {
      throw this.makeError(409, "Duplicate Sandstorm login token.");
    }

    let resolveLogin;
    let rejectLogin;
    const promise = new Promise((resolve, reject) => {
      resolveLogin = resolve;
      rejectLogin = reject;
    });
    const entry = { resolve: resolveLogin, consumed: false };
    this.pending.set(token, entry);
    const timeout = setTimeout(() => {
      rejectLogin(this.makeError("timeout", "Gave up waiting for login request."));
    }, this.timeoutMs);

    return promise.finally(() => {
      clearTimeout(timeout);
      if (this.pending.get(token) === entry) this.pending.delete(token);
    });
  }

  resolve(token, value) {
    const entry = this.pending.get(token);
    if (!entry || entry.consumed) return false;
    entry.consumed = true;
    entry.resolve(value);
    return true;
  }

  get size() {
    return this.pending.size;
  }
}
