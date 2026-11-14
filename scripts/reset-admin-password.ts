import 'dotenv/config';
import { createInterface } from 'node:readline';
import { prisma } from '../src/lib/db';
import { hashPassword, validatePasswordStrength } from '../src/lib/auth/password';

/**
 * `pnpm admin:password -- <email>` - set a user's password from the server.
 *
 * Passwords are otherwise changed from Settings by an admin; this is the way back in when the
 * only admin has lost theirs. It works for any account, revokes that account's sessions, and
 * prints nothing but the outcome. Nothing else changes - a removed account stays removed.
 *
 * T53: the new password is read from the first line of standard input, so it lands in neither the
 * shell history nor the process list. A second argument is still accepted, for scripts.
 */
async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('New password: ');
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    return line.trim();
  }
  return '';
}

async function main() {
  const [email, given] = process.argv.slice(2);
  const password = email ? given ?? (await readPassword()) : '';
  if (!email || !password) {
    console.error('usage: pnpm admin:password -- <email>   (then type the new password and press Enter)');
    process.exit(2);
  }
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) {
    console.error(`no account with the email ${email}`);
    process.exit(1);
  }
  const weak = validatePasswordStrength(password, { admin: user.role === 'ADMIN' });
  if (weak) {
    console.error(weak);
    process.exit(2);
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
  ]);
  console.log(`password set for ${user.email}; their sessions were signed out`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
