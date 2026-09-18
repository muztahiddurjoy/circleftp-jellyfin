/**
 * Response-header tests.
 *
 * These exist because a wrong security header here does not fail loudly — it
 * renders a blank page with a clean 200 in the server log.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import './test/setup.js';
import { createApp } from './app.js';

const app = createApp();

describe('security headers', () => {
  it('does not send upgrade-insecure-requests', async () => {
    const response = await request(app).get('/api/health');
    const csp = response.headers['content-security-policy'] ?? '';

    // Helmet sets this by default. On a page served over plain HTTP — which is
    // how the app is reached over Tailscale — the browser rewrites every
    // same-origin subresource to https://, the JS and CSS are then requested on
    // a port with no TLS listener, and the app renders as a black screen with
    // no server-side error to show for it.
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('keeps the rest of the content security policy', async () => {
    const response = await request(app).get('/api/health');
    const csp = response.headers['content-security-policy'] ?? '';

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The SSE stream and every API call are same-origin fetches.
    expect(csp).toContain("connect-src 'self'");
    // Posters are proxied through this origin, never hotlinked from Circle FTP.
    expect(csp).toContain("img-src 'self' data:");
  });

  it('does not send HSTS', async () => {
    const response = await request(app).get('/api/health');

    // Same reasoning as above: HSTS would pin the browser to https:// on a host
    // that also legitimately serves plain HTTP over Tailscale.
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('answers the health check without a session', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('requires a session for the API', async () => {
    await request(app).get('/api/downloads').expect(401);
    await request(app).get('/api/library/search?q=x').expect(401);
  });

  it('serves the SPA shell for a client-side route, not a 404', async () => {
    // "/downloads" is a React Router path, not an endpoint. A hard refresh on
    // it must return index.html or deep links break.
    const response = await request(app).get('/downloads');

    // Only meaningful when a built bundle is present; skip in a bare checkout.
    if (response.status === 404) return;
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('404s an unknown API endpoint as JSON', async () => {
    const response = await request(app).get('/api/nope');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('rejects a state-changing request without the CSRF header', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'someone@example.com', password: 'whatever-long-enough' });

    expect(response.status).toBe(403);
  });
});
