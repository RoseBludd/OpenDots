import { describe, expect, it } from 'vitest';
import { AuthStore } from '../src/server/auth-store.js';
import { authRoutes } from '../src/server/auth-routes.js';

describe('family auth store', () => {
  it('registers first guardian and verifies login', () => {
    const auth = new AuthStore(':memory:', 'x'.repeat(32));
    expect(auth.userCount()).toBe(0);
    const user = auth.createUser(
      'Alex',
      'alex@family.test',
      'password123',
      'guardian',
    );
    expect(user.role).toBe('guardian');
    expect(auth.verifyLogin('alex@family.test', 'password123')?.id).toBe(
      user.id,
    );
    expect(auth.verifyLogin('alex@family.test', 'wrong')).toBeUndefined();
    auth.close();
  });

  it('session cookie roundtrip via routes', async () => {
    const auth = new AuthStore(':memory:', 'y'.repeat(32));
    const app = authRoutes(auth, 'http://127.0.0.1:3430');
    const reg = await app.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Guardian',
        email: 'g@family.test',
        password: 'longpassword',
      }),
    });
    expect(reg.status).toBe(201);
    const cookie = reg.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('family_session=');
    const me = await app.request('/me', {
      headers: { cookie: cookie.split(';')[0] },
    });
    expect(me.status).toBe(200);
    const logout = await app.request('/logout', {
      method: 'POST',
      headers: { cookie: cookie.split(';')[0] },
    });
    expect(logout.status).toBe(200);
    const meAfter = await app.request('/me', {
      headers: { cookie: cookie.split(';')[0] },
    });
    expect(meAfter.status).toBe(401);
    auth.close();
  });
});
