/**
 * Encrypted store for LittleSkin credentials.
 *
 * Why passwords are kept at all: Yggdrasil can bind a character to a fresh token
 * but can never rebind an existing one, and an unbound token is refused by the
 * session-join endpoint. Switching characters therefore requires a *new* token,
 * which only the authenticate call (`账号 + 密码`) can issue. Without the password
 * the launcher would have to interrupt the user every time they switch — so the
 * password is stored, exactly like other mainstream launchers do.
 *
 * Security posture:
 *   - Encrypted with Electron's `safeStorage`, which is DPAPI on Windows. The
 *     ciphertext is bound to the OS user account: another user on the same machine
 *     cannot decrypt it, and neither can the file alone if copied elsewhere.
 *   - Only the password is stored; the file lives under `userData/secure/`.
 *   - `remember: false` deletes any previously stored entry.
 *   - When OS encryption is unavailable the value is not written at all — a
 *     plaintext fallback would silently weaken the guarantee.
 */
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface StoredCredential {
  /** Login identifier exactly as the user typed it (an email). */
  loginName: string;
  /** base64 of the DPAPI-encrypted password. */
  secret: string;
}

interface CredentialFile {
  entries: StoredCredential[];
}

/** Normalised key so the same account matches regardless of case/whitespace. */
function keyOf(loginName: string): string {
  return loginName.trim().toLowerCase();
}

function storePath(): string {
  const dir = join(app.getPath('userData'), 'secure');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'littleskin.json');
}

function readFileSafe(): CredentialFile {
  const file = storePath();
  if (!existsSync(file)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CredentialFile;
    return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function writeFileSafe(data: CredentialFile): void {
  writeFileSync(storePath(), JSON.stringify(data), 'utf8');
}

/** True when the OS can encrypt secrets (DPAPI on Windows). */
export function canRememberCredentials(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Store (or replace) the password for an account. Returns false if unsupported. */
export function rememberCredential(loginName: string, password: string): boolean {
  const id = loginName.trim();
  if (!id || !password) return false;
  if (!canRememberCredentials()) return false;
  try {
    const secret = safeStorage.encryptString(password).toString('base64');
    const data = readFileSafe();
    data.entries = data.entries.filter((e) => keyOf(e.loginName) !== keyOf(id));
    data.entries.push({ loginName: id, secret });
    writeFileSafe(data);
    return true;
  } catch {
    return false;
  }
}

/** Remove a stored password. */
export function forgetCredential(loginName: string): void {
  const data = readFileSafe();
  const next = data.entries.filter((e) => keyOf(e.loginName) !== keyOf(loginName));
  if (next.length !== data.entries.length) {
    data.entries = next;
    writeFileSafe(data);
  }
}

/** Decrypt the password for an account, or null when nothing usable is stored. */
export function recallCredential(loginName: string): string | null {
  if (!loginName.trim() || !canRememberCredentials()) return null;
  const entry = readFileSafe().entries.find((e) => keyOf(e.loginName) === keyOf(loginName));
  if (!entry) return null;
  try {
    return safeStorage.decryptString(Buffer.from(entry.secret, 'base64'));
  } catch {
    // Corrupt or encrypted by a different OS user — drop it so it cannot linger.
    forgetCredential(loginName);
    return null;
  }
}

/** Identifier list for prefilling the login form (never includes passwords). */
export function listRemembered(): string[] {
  return readFileSafe().entries.map((e) => e.loginName);
}
