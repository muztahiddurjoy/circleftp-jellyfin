/**
 * Account and administration tests.
 *
 * The lock-out rules are the point of this file. There is no email recovery and
 * no console on this app, so an admin who demotes the last admin has locked
 * everyone out until someone hand-edits SQLite.
 */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import '../test/setup.js';
import { createApp } from '../app.js';
import { prisma } from '../lib/db.js';
import { createUser } from './users.js';

const app = createApp();
const CSRF = ['X-Requested-With', 'circleftp-jellyfin'] as const;

const ADMIN = { email: 'admin@example.com', password: 'admin-password-here', name: 'Admin' };
const MEMBER = { email: 'member@example.com', password: 'member-password-here', name: 'Member' };

beforeEach(async () => {
  await prisma.passwordReset.deleteMany();
  await prisma.session.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.downloadFile.deleteMany();
  await prisma.download.deleteMany();
  await prisma.user.deleteMany();

  await createUser({ ...ADMIN, role: 'ADMIN' });
  await createUser({ ...MEMBER, role: 'USER' });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Sign in and return an agent that carries the session cookie. */
async function signIn(who: { email: string; password: string }) {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/auth/login')
    .set(...CSRF)
    .send({ email: who.email, password: who.password });
  expect(response.status).toBe(200);
  return agent;
}

async function userId(email: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return user.id;
}

describe('admin access control', () => {
  it('refuses admin endpoints to a signed-out caller', async () => {
    await request(app).get('/api/admin/users').expect(401);
  });

  it('refuses admin endpoints to a non-admin', async () => {
    const agent = await signIn(MEMBER);
    const response = await agent.get('/api/admin/users');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('lists users for an admin, flagging their own row', async () => {
    const agent = await signIn(ADMIN);
    const response = await agent.get('/api/admin/users').expect(200);

    const users = response.body.users as { email: string; isSelf: boolean; role: string }[];
    expect(users).toHaveLength(2);
    expect(users.find((u) => u.email === ADMIN.email)?.isSelf).toBe(true);
    expect(users.find((u) => u.email === MEMBER.email)?.isSelf).toBe(false);
    expect(users.find((u) => u.email === MEMBER.email)?.role).toBe('USER');
  });
});

describe('lock-out protection', () => {
  it('refuses to demote the only admin', async () => {
    const agent = await signIn(ADMIN);
    const response = await agent
      .patch(`/api/admin/users/${await userId(ADMIN.email)}`)
      .set(...CSRF)
      .send({ role: 'USER' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('last_admin');

    // And the change really did not happen.
    const still = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN.email } });
    expect(still.role).toBe('ADMIN');
  });

  it('allows demoting an admin once another one exists', async () => {
    const agent = await signIn(ADMIN);
    const memberId = await userId(MEMBER.email);

    await agent.patch(`/api/admin/users/${memberId}`).set(...CSRF).send({ role: 'ADMIN' }).expect(200);
    await agent
      .patch(`/api/admin/users/${await userId(ADMIN.email)}`)
      .set(...CSRF)
      .send({ role: 'USER' })
      .expect(200);

    const demoted = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN.email } });
    expect(demoted.role).toBe('USER');
  });

  it('does not count a disabled admin as cover for demoting the active one', async () => {
    const agent = await signIn(ADMIN);
    const memberId = await userId(MEMBER.email);

    // A disabled admin cannot sign in, so it is not a way back into the app.
    await agent.patch(`/api/admin/users/${memberId}`).set(...CSRF).send({ role: 'ADMIN' }).expect(200);
    await agent.patch(`/api/admin/users/${memberId}`).set(...CSRF).send({ disabled: true }).expect(200);

    const response = await agent
      .patch(`/api/admin/users/${await userId(ADMIN.email)}`)
      .set(...CSRF)
      .send({ role: 'USER' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('last_admin');
  });

  it('refuses to disable or delete your own account', async () => {
    const agent = await signIn(ADMIN);
    const id = await userId(ADMIN.email);

    await agent.patch(`/api/admin/users/${id}`).set(...CSRF).send({ disabled: true }).expect(400);
    await agent.delete(`/api/admin/users/${id}`).set(...CSRF).expect(400);
  });

  it('refuses to delete the only admin', async () => {
    const agent = await signIn(ADMIN);
    // Promote the member, sign in as them, then try to delete the original.
    await agent
      .patch(`/api/admin/users/${await userId(MEMBER.email)}`)
      .set(...CSRF)
      .send({ role: 'ADMIN' })
      .expect(200);

    const second = await signIn(MEMBER);
    // Two admins now, so this one is allowed.
    await second.delete(`/api/admin/users/${await userId(ADMIN.email)}`).set(...CSRF).expect(200);

    // ...and now they are the last one, so they cannot be demoted.
    const response = await second
      .patch(`/api/admin/users/${await userId(MEMBER.email)}`)
      .set(...CSRF)
      .send({ role: 'USER' });
    expect(response.status).toBe(409);
  });
});

describe('disabling a user', () => {
  it('signs them out immediately', async () => {
    const member = await signIn(MEMBER);
    await member.get('/api/auth/me').expect(200);

    const admin = await signIn(ADMIN);
    await admin
      .patch(`/api/admin/users/${await userId(MEMBER.email)}`)
      .set(...CSRF)
      .send({ disabled: true })
      .expect(200);

    // An already-open tab must stop working, not keep its session.
    await member.get('/api/auth/me').expect(401);
  });

  it('refuses their login', async () => {
    const admin = await signIn(ADMIN);
    await admin
      .patch(`/api/admin/users/${await userId(MEMBER.email)}`)
      .set(...CSRF)
      .send({ disabled: true })
      .expect(200);

    const response = await request(app)
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email: MEMBER.email, password: MEMBER.password });

    expect(response.status).toBe(403);
  });
});

describe('deleting a user', () => {
  it('keeps their downloads, detached from the account', async () => {
    const memberId = await userId(MEMBER.email);
    await prisma.download.create({
      data: { postId: 1, title: 'Kept', folderName: 'Kept', kind: 'movie', userId: memberId },
    });

    const admin = await signIn(ADMIN);
    await admin.delete(`/api/admin/users/${memberId}`).set(...CSRF).expect(200);

    // The record of what was fetched should outlive the account.
    const download = await prisma.download.findFirstOrThrow({ where: { title: 'Kept' } });
    expect(download.userId).toBeNull();
  });
});

describe('changing your own password', () => {
  it('requires the current password', async () => {
    const agent = await signIn(MEMBER);
    const response = await agent
      .post('/api/account/password')
      .set(...CSRF)
      .send({ currentPassword: 'not-the-password', newPassword: 'brand-new-password' });

    expect(response.status).toBe(400);
    expect(response.body.error.details.currentPassword).toBeDefined();
  });

  it('rejects reusing the same password', async () => {
    const agent = await signIn(MEMBER);
    const response = await agent
      .post('/api/account/password')
      .set(...CSRF)
      .send({ currentPassword: MEMBER.password, newPassword: MEMBER.password });

    expect(response.status).toBe(400);
  });

  it('changes it, keeps this session, and drops the others', async () => {
    const first = await signIn(MEMBER);
    const second = await signIn(MEMBER);

    await first
      .post('/api/account/password')
      .set(...CSRF)
      .send({ currentPassword: MEMBER.password, newPassword: 'a-brand-new-password' })
      .expect(200);

    // The device that made the change stays signed in...
    await first.get('/api/auth/me').expect(200);
    // ...every other one does not.
    await second.get('/api/auth/me').expect(401);

    await request(app)
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email: MEMBER.email, password: 'a-brand-new-password' })
      .expect(200);
  });
});

describe('password reset links', () => {
  it('lets an admin issue one and the user redeem it', async () => {
    const admin = await signIn(ADMIN);
    const memberId = await userId(MEMBER.email);

    const issued = await admin
      .post(`/api/admin/users/${memberId}/reset-link`)
      .set(...CSRF)
      .send({ expiresInHours: 24 })
      .expect(201);

    const token = new URL(`http://x${issued.body.url}`).searchParams.get('token')!;
    expect(token.length).toBeGreaterThan(20);

    // The link can be inspected before the form is shown.
    const check = await request(app)
      .get(`/api/account/reset/check?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(check.body.valid).toBe(true);
    expect(check.body.userEmail).toBe(MEMBER.email);

    await request(app)
      .post('/api/account/reset')
      .set(...CSRF)
      .send({ token, newPassword: 'reset-to-this-password' })
      .expect(200);

    await request(app)
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email: MEMBER.email, password: 'reset-to-this-password' })
      .expect(200);
  });

  it('is single use', async () => {
    const admin = await signIn(ADMIN);
    const issued = await admin
      .post(`/api/admin/users/${await userId(MEMBER.email)}/reset-link`)
      .set(...CSRF)
      .send({})
      .expect(201);
    const token = new URL(`http://x${issued.body.url}`).searchParams.get('token')!;

    await request(app)
      .post('/api/account/reset')
      .set(...CSRF)
      .send({ token, newPassword: 'first-use-password' })
      .expect(200);

    const second = await request(app)
      .post('/api/account/reset')
      .set(...CSRF)
      .send({ token, newPassword: 'second-use-password' });
    expect(second.status).toBe(400);
  });

  it('invalidates the previous link when a new one is issued', async () => {
    const admin = await signIn(ADMIN);
    const memberId = await userId(MEMBER.email);

    const first = await admin
      .post(`/api/admin/users/${memberId}/reset-link`).set(...CSRF).send({}).expect(201);
    const firstToken = new URL(`http://x${first.body.url}`).searchParams.get('token')!;

    await admin.post(`/api/admin/users/${memberId}/reset-link`).set(...CSRF).send({}).expect(201);

    // Clicking "reset" twice must not leave two working links in the wild.
    const check = await request(app)
      .get(`/api/account/reset/check?token=${encodeURIComponent(firstToken)}`)
      .expect(200);
    expect(check.body.valid).toBe(false);
  });

  it('signs every device out when redeemed', async () => {
    const member = await signIn(MEMBER);
    const admin = await signIn(ADMIN);

    const issued = await admin
      .post(`/api/admin/users/${await userId(MEMBER.email)}/reset-link`)
      .set(...CSRF)
      .send({})
      .expect(201);
    const token = new URL(`http://x${issued.body.url}`).searchParams.get('token')!;

    await request(app)
      .post('/api/account/reset')
      .set(...CSRF)
      .send({ token, newPassword: 'after-the-reset-pw' })
      .expect(200);

    await member.get('/api/auth/me').expect(401);
  });

  it('rejects a token that was never issued', async () => {
    const check = await request(app)
      .get('/api/account/reset/check?token=completely-made-up-token')
      .expect(200);
    expect(check.body.valid).toBe(false);
  });
});

describe('admin user creation', () => {
  it('generates a password and returns it exactly once', async () => {
    const admin = await signIn(ADMIN);
    const response = await admin
      .post('/api/admin/users')
      .set(...CSRF)
      .send({ name: 'Newcomer', email: 'new@example.com', role: 'USER' })
      .expect(201);

    expect(response.body.generatedPassword).toMatch(/^\S{20,}$/);
    expect(response.body.user.email).toBe('new@example.com');

    await request(app)
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email: 'new@example.com', password: response.body.generatedPassword })
      .expect(200);

    // It is not retrievable afterwards.
    const list = await admin.get('/api/admin/users').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(response.body.generatedPassword);
  });

  it('rejects a duplicate email', async () => {
    const admin = await signIn(ADMIN);
    const response = await admin
      .post('/api/admin/users')
      .set(...CSRF)
      .send({ name: 'Clash', email: MEMBER.email });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('email_taken');
  });
});

describe('invites', () => {
  it('creates, lists and revokes', async () => {
    const admin = await signIn(ADMIN);

    const created = await admin
      .post('/api/admin/invites')
      .set(...CSRF)
      .send({ role: 'USER', expiresInDays: 7, note: 'for a friend' })
      .expect(201);

    expect(created.body.invite.status).toBe('pending');
    expect(created.body.invite.code).toMatch(/^[A-Z0-9]{10,}$/);

    const listed = await admin.get('/api/admin/invites').expect(200);
    expect(listed.body.invites).toHaveLength(1);
    expect(listed.body.invites[0].createdByName).toBe(ADMIN.name);

    await admin.delete(`/api/admin/invites/${created.body.invite.id}`).set(...CSRF).expect(200);
    expect((await admin.get('/api/admin/invites')).body.invites).toHaveLength(0);
  });

  it('shows a redeemed invite as used and refuses to revoke it', async () => {
    const admin = await signIn(ADMIN);
    const created = await admin
      .post('/api/admin/invites').set(...CSRF).send({ role: 'USER' }).expect(201);

    await request(app)
      .post('/api/auth/redeem')
      .set(...CSRF)
      .send({
        code: created.body.invite.code,
        name: 'Invited',
        email: 'invited@example.com',
        password: 'invited-user-password',
      })
      .expect(201);

    const listed = await admin.get('/api/admin/invites').expect(200);
    expect(listed.body.invites[0].status).toBe('used');
    expect(listed.body.invites[0].usedByName).toBe('Invited');

    // Deleting it would erase the record of how that account came to exist.
    await admin.delete(`/api/admin/invites/${created.body.invite.id}`).set(...CSRF).expect(409);
  });

  it('refuses invite management to a non-admin', async () => {
    const member = await signIn(MEMBER);
    await member.get('/api/admin/invites').expect(403);
    await member.post('/api/admin/invites').set(...CSRF).send({}).expect(403);
  });
});

describe('session management', () => {
  it('lets a user end their other sessions', async () => {
    const first = await signIn(MEMBER);
    const second = await signIn(MEMBER);

    const response = await first.post('/api/account/sessions/revoke-others').set(...CSRF).expect(200);
    expect(response.body.endedCount).toBe(1);

    await first.get('/api/auth/me').expect(200);
    await second.get('/api/auth/me').expect(401);
  });

  it('lets an admin revoke someone else’s sessions', async () => {
    const member = await signIn(MEMBER);
    const admin = await signIn(ADMIN);

    await admin
      .post(`/api/admin/users/${await userId(MEMBER.email)}/revoke-sessions`)
      .set(...CSRF)
      .expect(200);

    await member.get('/api/auth/me').expect(401);
    // Their password is untouched, so they can simply sign in again.
    await request(app)
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email: MEMBER.email, password: MEMBER.password })
      .expect(200);
  });
});
