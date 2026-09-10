import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { hashPassword, validatePasswordStrength } from '../src/lib/auth/password';

/**
 * `pnpm admin:password -- <email> <new password>` - set a user's password from the server.
 *
 * Passwords are otherwise changed from Settings by an admin; this is the way back in when the
 * only admin has lost theirs. It works for any account, revokes that account's sessions, and
 * prints nothing but the outcome. Nothing else changes.
 */
async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('usage: pnpm admin:password -- <email> <new password>');
    process.exit(2);
  }
  const weak = validatePasswordStrength(password);
  if (weak) {
    console.error(weak);
    process.exit(2);
  }
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) {
    console.error(`no account with the email ${email}`);
    process.exit(1);
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password), active: true } }),
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
