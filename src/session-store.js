import crypto from 'node:crypto';

export class SessionStore {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  // credentials are the logged-in user's Server Manager credentials. They stay
  // in this in-memory map only — never written to disk, config, or logs — and
  // die with the process or on logout.
  create(userId, credentials) {
    const id = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const session = { id, csrf, userId, credentials, expiresAt: Date.now() + this.ttlMs };
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    const session = id ? this.sessions.get(id) : null;
    if (!session || session.expiresAt <= Date.now()) {
      if (id) this.sessions.delete(id);
      return null;
    }
    session.expiresAt = Date.now() + this.ttlMs;
    return session;
  }

  delete(id) {
    if (id) this.sessions.delete(id);
  }
}
