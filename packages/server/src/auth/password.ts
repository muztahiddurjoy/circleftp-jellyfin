/**
 * Password hashing.
 *
 * bcryptjs rather than argon2 or native bcrypt: it is pure JavaScript, so a
 * Node upgrade can never leave the app unable to verify a password because a
 * native addon failed to rebuild. Cost 12 is ~250ms here, which is the right
 * trade for a login endpoint that is also rate limited.
 */
import bcrypt from 'bcryptjs';

const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    // A malformed hash in the database must read as "wrong password", never
    // as a 500 that tells an attacker the account is special.
    return false;
  }
}

/**
 * Burn roughly the same time as a real comparison when the account does not
 * exist, so response timing does not disclose which emails are registered.
 */
export async function fakeVerify(): Promise<void> {
  await bcrypt.compare(
    'timing-equaliser',
    '$2a$12$C6UzMDM.H6dfI/f/IKcEe.fuLCLpTiFjMrUKGkSQ0nPjEuHB2Dvem',
  );
}
