import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/session-store.js';

test('create/get round-trips user and credentials', () => {
  const store = new SessionStore(60_000);
  const session = store.create('infodba', { username: 'infodba', password: 'secret' });
  const loaded = store.get(session.id);
  assert.equal(loaded.userId, 'infodba');
  assert.equal(loaded.credentials.password, 'secret');
  assert.ok(loaded.csrf);
  assert.notEqual(loaded.csrf, session.id);
});

test('sessions slide their expiry on access and expire when idle', async () => {
  const store = new SessionStore(50);
  const session = store.create('user', { username: 'user', password: 'p' });
  const firstExpiry = store.get(session.id).expiresAt;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const secondExpiry = store.get(session.id).expiresAt;
  assert.ok(secondExpiry > firstExpiry, 'sliding expiry must move forward');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(store.get(session.id), null);
});

test('delete removes the session immediately', () => {
  const store = new SessionStore(60_000);
  const session = store.create('user', { username: 'user', password: 'p' });
  store.delete(session.id);
  assert.equal(store.get(session.id), null);
  store.delete(undefined); // must not throw
});
