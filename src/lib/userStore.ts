import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes, createHash } from 'crypto';
import { resolve } from 'path';

export interface User {
  username: string;
  passwordHash: string;
  salt: string;
  role: 'admin' | 'viewer';
  createdAt: string;
  createdBy: string;
}

const STORE_PATH = resolve(process.cwd(), 'users.json');

function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(password + salt).digest('hex');
}

function loadUsers(): User[] {
  if (!existsSync(STORE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function saveUsers(users: User[]): void {
  writeFileSync(STORE_PATH, JSON.stringify(users, null, 2));
}

export class UserStore {
  private adminUser: string;
  private adminPass: string;

  constructor(adminUser: string, adminPass: string) {
    this.adminUser = adminUser;
    this.adminPass = adminPass;
  }

  authenticate(username: string, password: string): { ok: boolean; role: 'admin' | 'viewer' } {
    // Check env admin first
    if (username === this.adminUser && password === this.adminPass) {
      return { ok: true, role: 'admin' };
    }
    const users = loadUsers();
    const user = users.find(u => u.username === username);
    if (!user) return { ok: false, role: 'viewer' };
    const hash = hashPassword(password, user.salt);
    if (hash !== user.passwordHash) return { ok: false, role: 'viewer' };
    return { ok: true, role: user.role };
  }

  listUsers(): Omit<User, 'passwordHash' | 'salt'>[] {
    const users = loadUsers();
    return users.map(({ username, role, createdAt, createdBy }) => ({
      username, role, createdAt, createdBy,
    }));
  }

  createUser(username: string, password: string, role: 'admin' | 'viewer', createdBy: string): { ok: boolean; error?: string } {
    if (!username || username.length < 2) return { ok: false, error: 'Username must be at least 2 characters' };
    if (!password || password.length < 4) return { ok: false, error: 'Password must be at least 4 characters' };
    if (username === this.adminUser) return { ok: false, error: 'Cannot create user with admin username' };
    const users = loadUsers();
    if (users.find(u => u.username === username)) return { ok: false, error: 'Username already exists' };
    const salt = randomBytes(16).toString('hex');
    users.push({
      username,
      passwordHash: hashPassword(password, salt),
      salt,
      role,
      createdAt: new Date().toISOString(),
      createdBy,
    });
    saveUsers(users);
    return { ok: true };
  }

  deleteUser(username: string): { ok: boolean; error?: string } {
    if (username === this.adminUser) return { ok: false, error: 'Cannot delete the admin user' };
    const users = loadUsers();
    const filtered = users.filter(u => u.username !== username);
    if (filtered.length === users.length) return { ok: false, error: 'User not found' };
    saveUsers(filtered);
    return { ok: true };
  }

  resetPassword(username: string, newPassword: string): { ok: boolean; error?: string } {
    if (!newPassword || newPassword.length < 4) return { ok: false, error: 'Password must be at least 4 characters' };
    if (username === this.adminUser) return { ok: false, error: 'Admin password is managed via environment variables' };
    const users = loadUsers();
    const user = users.find(u => u.username === username);
    if (!user) return { ok: false, error: 'User not found' };
    user.salt = randomBytes(16).toString('hex');
    user.passwordHash = hashPassword(newPassword, user.salt);
    saveUsers(users);
    return { ok: true };
  }
}
