#!/usr/bin/env node
/**
 * Create or promote an administrator from the command line.
 *
 *   npm run seed:admin -- --username tomo --password "a long password"
 *
 * Useful when registration is closed, or to recover access.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  USERNAME_RE,
  MIN_PASSWORD_LENGTH,
  createUser,
  findByUsername,
  setPassword,
  setRole,
} from '../services/users.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) args.set(arg.slice(2), process.argv[i + 1]);
}

const rl = createInterface({ input: stdin, output: stdout });

const username = (args.get('username') || (await rl.question('Username: '))).trim();
const password = args.get('password') || (await rl.question('Password: '));
rl.close();

if (!USERNAME_RE.test(username)) {
  console.error('Username must be 3-24 characters: letters, numbers, underscore or hyphen.');
  process.exit(1);
}
if (!password || password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}

const existing = findByUsername(username);

if (existing) {
  await setPassword(existing.id, password);
  setRole(existing.id, 'admin');
  console.log(`Updated "${username}": password reset and role set to admin.`);
} else {
  const user = await createUser({ username, password, role: 'admin' });
  console.log(`Created administrator "${user.username}" (id ${user.id}).`);
}

process.exit(0);
