#!/usr/bin/env node
/**
 * Admin CLI — the only way to create the first account.
 *
 * There is no public sign-up route by design, so bootstrapping happens here:
 *   npm run user:create -- --email you@example.com --name You --admin
 *   npm run invite:create -- --role USER --days 14
 *   npm run user:passwd  -- --email you@example.com
 *   npm run user:list
 */
import { randomBytes } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import readline from 'node:readline/promises';

import { emailSchema, passwordSchema, type UserRole } from '@cfj/shared';

import { createInvite, createUser, setPassword } from '../auth/users.js';
import { configureSqlite, disconnect, prisma } from '../lib/db.js';

interface Flags {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      (flags._ as string[]).push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function str(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

/**
 * Typed passwords would echo to the terminal, and masking them portably is
 * fiddly. Generating is both safer and the common case for a seeded account, so
 * an explicit `--password` is the only way to choose one by hand.
 */
async function resolvePassword(flags: Flags): Promise<{ password: string; generated: boolean }> {
  const provided = str(flags, 'password');
  if (provided) {
    const check = passwordSchema.safeParse(provided);
    if (!check.success) fail(check.error.issues[0]?.message ?? 'Invalid password');
    return { password: provided, generated: false };
  }
  // 24 URL-safe characters, comfortably past the 10-character minimum.
  return { password: randomBytes(18).toString('base64url'), generated: true };
}

function reportPassword(password: string, generated: boolean): void {
  if (!generated) {
    console.log('');
    return;
  }
  console.log(`\n  password: ${password}`);
  console.log('  Save it now — only a bcrypt hash is stored.\n');
}

async function cmdUserCreate(flags: Flags): Promise<void> {
  const rawEmail = str(flags, 'email') ?? (stdin.isTTY ? await prompt('Email: ') : undefined);
  if (!rawEmail) fail('--email is required');

  const parsedEmail = emailSchema.safeParse(rawEmail);
  if (!parsedEmail.success) fail('That is not a valid email address');
  const email = parsedEmail.data;

  const name = str(flags, 'name') ?? email.split('@')[0]!;
  const role: UserRole = flags.admin === true || str(flags, 'role') === 'ADMIN' ? 'ADMIN' : 'USER';
  const { password, generated } = await resolvePassword(flags);

  const user = await createUser({ email, name, password, role });

  console.log('\n✓ Account created');
  console.log(`  email : ${user.email}`);
  console.log(`  name  : ${user.name}`);
  console.log(`  role  : ${user.role}`);
  reportPassword(password, generated);
}

async function cmdUserPasswd(flags: Flags): Promise<void> {
  const rawEmail = str(flags, 'email') ?? (stdin.isTTY ? await prompt('Email: ') : undefined);
  if (!rawEmail) fail('--email is required');
  const email = String(rawEmail).trim().toLowerCase();

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) fail(`No account found for ${email}`);

  const { password, generated } = await resolvePassword(flags);
  await setPassword(user.id, password);
  // A password reset must not leave old cookies working.
  const { count } = await prisma.session.deleteMany({ where: { userId: user.id } });

  console.log(`\n✓ Password updated for ${email} (${count} session(s) signed out)`);
  reportPassword(password, generated);
}

async function cmdUserList(): Promise<void> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { downloads: true } } },
  });
  if (users.length === 0) {
    console.log('\nNo accounts yet. Create one with:');
    console.log('  npm run user:create -- --email you@example.com --admin\n');
    return;
  }
  console.log('');
  for (const user of users) {
    const badge = user.disabled ? ' [disabled]' : '';
    const downloads = String(user._count.downloads).padStart(4);
    console.log(
      `  ${user.role.padEnd(5)}  ${user.email.padEnd(32)} ${downloads} downloads  ${user.name}${badge}`,
    );
  }
  console.log('');
}

async function cmdInviteCreate(flags: Flags): Promise<void> {
  const role: UserRole = flags.admin === true || str(flags, 'role') === 'ADMIN' ? 'ADMIN' : 'USER';
  const days = Number(str(flags, 'days') ?? 14);
  if (!Number.isFinite(days) || days < 1) fail('--days must be a positive number');

  const note = str(flags, 'note');
  const invite = await createInvite({
    role,
    expiresInDays: days,
    ...(note ? { note } : {}),
  });

  console.log('\n✓ Invite created');
  console.log(`  code    : ${invite.code}`);
  console.log(`  role    : ${invite.role}`);
  console.log(`  expires : ${invite.expiresAt.toISOString()}`);
  console.log('\n  Redeem it at /invite on the site.\n');
}

const COMMANDS: Record<string, (flags: Flags) => Promise<void>> = {
  'user:create': cmdUserCreate,
  'user:passwd': cmdUserPasswd,
  'user:list': cmdUserList,
  'invite:create': cmdInviteCreate,
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const handler = command ? COMMANDS[command] : undefined;

  if (!handler) {
    console.log('\nUsage: npm run <command> -- [options]\n');
    console.log('  user:create    --email <e> [--name <n>] [--admin] [--password <p>]');
    console.log('  user:passwd    --email <e> [--password <p>]');
    console.log('  user:list');
    console.log('  invite:create  [--admin|--role USER] [--days 14] [--note "..."]\n');
    console.log('  Omitting --password generates a strong one and prints it once.\n');
    process.exitCode = command ? 1 : 0;
    return;
  }

  await configureSqlite();
  await handler(parseFlags(rest));
}

main()
  .catch((error: unknown) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnect();
  });
