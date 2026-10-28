/**
 * SLATT team-site (slatt.cn) SSO integration.
 *
 * Scope: this is a **team-members-only** feature. Accounts on slatt.cn can only be
 * created by SLATT team members, so a successful login implies membership; the
 * `group_id` is still kept to distinguish member / admin / owner in the UI.
 *
 * Endpoints (see 对接包 SLATT启动器SSO与皮肤API说明.md):
 *
 *   POST /api/sso/launcher/login    account+password -> access_token + user
 *   GET  /api/sso/launcher/profile  Bearer -> user (restore session / refresh)
 *   GET  /api/sso/launcher/skin     Bearer -> that member's own skin PNG
 *   POST /api/sso/launcher/logout   Bearer -> revoke this launcher session
 *   GET  /api/skins                 public  -> the whole team skin library
 *
 * Notes that are easy to get wrong:
 *   - The library (`/api/skins`) is NOT documented in the integration package; it
 *     was discovered by probing. It is public and returns every approved skin.
 *   - `skin_file` is a site-relative path like `/uploads/skins/x.png` that 404s at
 *     the domain root. The real asset host is `https://slatt.cn/api` + that path.
 *   - `uploader_contact` (an email address) is returned by the library API. It is
 *     deliberately never forwarded to the renderer.
 *   - The token has no refresh endpoint: expiry means re-entering the password.
 */
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { SlattApplyResult, SlattRole, SlattSession, SlattSkin, SlattUser } from '@shared/types';
import { isUploadableSkinSize, pngDimensions, setLocalSkin, uploadSkin } from '../auth';
import { getSettings } from '../settings/store';
import { userAgent } from '../ua';

/** The public site. Kept in one place so it is trivial to point at a staging host. */
const SITE = 'https://slatt.cn';
const API = `${SITE}/api/sso/launcher`;

/** Library responses are cached briefly: the list changes rarely and is large. */
const LIBRARY_TTL_MS = 60_000;

/**
 * Role labels, keyed by the site's `group_id`.
 *
 * `captain` is the group the site actually returns for the team lead account
 * (e.g. the project author), so it must be mapped explicitly — otherwise the
 * badge silently degrades to the default "团队成员".
 */
const ROLE_LABEL: Record<SlattRole, string> = {
  member: '团队成员',
  captain: '团队主管',
  admin: '团队管理员',
  owner: '团队主管',
  unknown: '团队成员',
};

function roleOf(groupId: string | null | undefined): SlattRole {
  switch ((groupId ?? '').toLowerCase()) {
    case 'member':
      return 'member';
    case 'captain':
      return 'captain';
    case 'admin':
      return 'admin';
    case 'owner':
      return 'owner';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Local state: device id + encrypted token
// ---------------------------------------------------------------------------

function stateDir(): string {
  const dir = join(app.getPath('userData'), 'slatt');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A stable per-install id. The site uses it to tell launcher sessions apart, so it
 * must survive restarts — but it is not a secret, hence a plain file.
 */
function deviceId(): string {
  const file = join(stateDir(), 'device.txt');
  try {
    if (existsSync(file)) {
      const id = readFileSync(file, 'utf8').trim();
      if (id) return id;
    }
  } catch {
    /* fall through and regenerate */
  }
  const id = randomUUID();
  writeFileSync(file, id, 'utf8');
  return id;
}

interface StoredToken {
  token: string;
  expiresAt: number | null;
}

function tokenFile(): string {
  return join(stateDir(), 'session.bin');
}

/**
 * Persist the token with OS-level encryption (DPAPI on Windows). The integration
 * doc explicitly asks not to keep the token in plain text.
 */
function saveToken(token: string, expiresInSeconds: number | null): number | null {
  const expiresAt = expiresInSeconds && expiresInSeconds > 0 ? Date.now() + expiresInSeconds * 1000 : null;
  const payload = JSON.stringify({ token, expiresAt } satisfies StoredToken);
  try {
    const file = tokenFile();
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(file, safeStorage.encryptString(payload));
    } else {
      // Extremely unlikely on Windows; better than failing the whole login.
      writeFileSync(file, Buffer.from(payload, 'utf8'));
    }
  } catch {
    /* a failed write only costs a re-login next time */
  }
  return expiresAt;
}

function loadToken(): StoredToken | null {
  const file = tokenFile();
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file);
    // Encrypted payloads are not UTF-8 JSON; try decryption first.
    let text: string | null = null;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        text = safeStorage.decryptString(raw);
      } catch {
        text = null;
      }
    }
    if (text === null) text = raw.toString('utf8');
    const parsed = JSON.parse(text) as StoredToken;
    if (!parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearToken(): void {
  rmSync(tokenFile(), { force: true });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface ApiResponse {
  success?: boolean;
  error?: string;
}

/** Map the documented status codes onto messages the user can act on. */
function messageForStatus(status: number, fallback: string): string {
  switch (status) {
    case 401:
      return '用户名或密码错误';
    case 403:
      return '该账号已被禁用，请联系团队管理员';
    case 429:
      return '失败次数过多，请等待约 15 分钟后再试';
    case 500:
      return '官网服务异常，请稍后再试';
    case 502:
      return '官网暂时无法读取皮肤文件，请稍后再试';
    default:
      return fallback;
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiResponse;
    if (body?.error) return body.error;
  } catch {
    /* not JSON */
  }
  return messageForStatus(res.status, `官网请求失败（HTTP ${res.status}）`);
}

/** Section of the site payload we actually consume. */
interface RawUser {
  uid?: string;
  username?: string;
  email?: string;
  avatar?: string;
  group_id?: string;
  skin?: { download_url?: string; model?: string } | null;
}

interface RawLoginResponse extends ApiResponse {
  access_token?: string;
  expires_in?: number;
  user?: RawUser;
}

interface RawProfileResponse extends ApiResponse {
  user?: RawUser;
}

interface RawSkin {
  id?: number;
  name?: string;
  skin_file?: string;
  preview_file?: string;
  uploader_name?: string;
  status?: string;
  created_at?: string;
  model_type?: string;
}

interface RawLibraryResponse extends ApiResponse {
  data?: RawSkin[];
}

/**
 * Resolve an asset path from the site payload to an absolute URL.
 *
 * Mirrors the site's own `wE()` helper exactly, because the payload mixes three
 * different shapes and only one of them needs the `/api` prefix:
 *
 *   "https://i0.hdslb.com/bfs/face/x.jpg"  -> used as-is
 *       Team member avatars are usually Bilibili CDN URLs.
 *   "/uploads/skins/x.png"                 -> https://slatt.cn/api/uploads/skins/x.png
 *       Skin files are served under /api.
 *   "/api/uploads/profile-x.jpg"           -> https://slatt.cn/api/uploads/profile-x.jpg
 *       Uploaded avatars ALREADY carry /api; prefixing again yields /api/api/… (404).
 *
 * Getting this wrong is invisible in code review and only shows up as a broken
 * image, so the three branches are kept explicit.
 */
function assetUrl(path: string | undefined): string {
  const p = (path ?? '').trim();
  if (!p) return '';
  // Absolute URLs, inline data and blob URLs are already usable.
  if (/^(https?:|data:|blob:)/i.test(p)) return p;
  // Bare upload paths are served from the /api mount point.
  if (p.startsWith('/uploads/')) return `${SITE}/api${p}`;
  if (p.startsWith('uploads/')) return `${SITE}/api/${p}`;
  // Everything else — including a path that already starts with /api — is
  // site-root relative and must not be prefixed twice.
  return `${SITE}${p.startsWith('/') ? '' : '/'}${p}`;
}

function toUser(raw: RawUser): SlattUser {
  const role = roleOf(raw.group_id);
  return {
    uid: raw.uid ?? '',
    username: raw.username ?? '',
    email: raw.email ?? '',
    avatarUrl: assetUrl(raw.avatar),
    groupId: raw.group_id ?? '',
    role,
    roleLabel: ROLE_LABEL[role],
    hasSkin: Boolean(raw.skin),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let cachedUser: SlattUser | null = null;
let cachedExpiresAt: number | null = null;

/** Current session without touching the network (populated by login/restore). */
export function currentSession(): SlattSession | null {
  if (!cachedUser) return null;
  return { user: cachedUser, expiresAt: cachedExpiresAt };
}

/**
 * Restore the previous login by validating the stored token against the profile
 * endpoint. A 401/403 means the session was revoked or expired, so the token is
 * discarded and the user is treated as signed out.
 */
export async function restoreSession(): Promise<SlattSession | null> {
  const stored = loadToken();
  if (!stored) {
    cachedUser = null;
    cachedExpiresAt = null;
    return null;
  }

  const res = await fetch(`${API}/profile`, {
    headers: { Authorization: `Bearer ${stored.token}`, 'User-Agent': userAgent(), Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);

  if (!res) return null; // network problem: keep the token, report "offline"
  if (res.status === 401 || res.status === 403) {
    clearToken();
    cachedUser = null;
    cachedExpiresAt = null;
    return null;
  }
  if (!res.ok) return null;

  const body = (await res.json()) as RawProfileResponse;
  if (!body.success || !body.user) return null;

  cachedUser = toUser(body.user);
  cachedExpiresAt = stored.expiresAt;
  return { user: cachedUser, expiresAt: cachedExpiresAt };
}

export async function login(account: string, password: string): Promise<SlattSession> {
  const acc = account.trim();
  if (!acc) throw new Error('请输入 SLATT 账号或邮箱');
  if (!password) throw new Error('请输入密码');

  const res = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent(), Accept: 'application/json' },
    body: JSON.stringify({
      account: acc,
      password,
      device_id: deviceId(),
      client_name: 'SLCL',
      client_version: app.getVersion(),
    }),
    signal: AbortSignal.timeout(20000),
  }).catch(() => {
    throw new Error('无法连接 slatt.cn，请检查网络后重试');
  });

  if (!res.ok) throw new Error(await readError(res));

  const body = (await res.json()) as RawLoginResponse;
  if (!body.success || !body.user || !body.access_token) {
    throw new Error(body.error ?? '登录失败');
  }

  const expiresAt = saveToken(body.access_token, body.expires_in ?? null);
  cachedUser = toUser(body.user);
  cachedExpiresAt = expiresAt;
  return { user: cachedUser, expiresAt };
}

export async function logout(): Promise<void> {
  const stored = loadToken();
  if (stored) {
    // Best effort: revoke server-side, but always clear locally.
    await fetch(`${API}/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stored.token}`, 'Content-Type': 'application/json', 'User-Agent': userAgent() },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    }).catch(() => undefined);
  }
  clearToken();
  cachedUser = null;
  cachedExpiresAt = null;
}

// ---- team skin library ----

let libraryCache: { at: number; skins: SlattSkin[] } | null = null;

function toSkin(raw: RawSkin): SlattSkin | null {
  const skinUrl = assetUrl(raw.skin_file);
  if (!raw.id || !skinUrl) return null;
  return {
    id: raw.id,
    name: (raw.name ?? '').trim() || `皮肤 #${raw.id}`,
    skinUrl,
    previewUrl: assetUrl(raw.preview_file) || skinUrl,
    // uploader_contact is intentionally dropped here (it is an email address).
    uploaderName: (raw.uploader_name ?? '').trim(),
    model: (raw.model_type ?? '').toLowerCase() === 'slim' ? 'slim' : 'classic',
    createdAt: raw.created_at ?? '',
  };
}

/**
 * The whole team library. Public on the site, but the UI only reveals it after a
 * successful login (see the 更多 page), so callers are expected to be signed in.
 */
export async function listSkins(force = false): Promise<SlattSkin[]> {
  if (!force && libraryCache && Date.now() - libraryCache.at < LIBRARY_TTL_MS) {
    return libraryCache.skins;
  }

  const res = await fetch(`${SITE}/api/skins`, {
    headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  }).catch(() => {
    throw new Error('无法获取团队皮肤库，请检查网络后重试');
  });

  if (!res.ok) throw new Error(await readError(res));

  const body = (await res.json()) as RawLibraryResponse;
  if (!body.success || !Array.isArray(body.data)) {
    throw new Error(body.error ?? '团队皮肤库返回了无法识别的数据');
  }

  const skins = body.data
    .map(toSkin)
    .filter((s): s is SlattSkin => s !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  libraryCache = { at: Date.now(), skins };
  return skins;
}

/** Guard: skins may only be installed while signed in. */
function requireLogin(): void {
  if (!cachedUser) throw new Error('请先登录 SLATT 团队账号');
}

/**
 * Fetch a library skin's raw PNG bytes, validating the payload.
 *
 * Shared by "install onto an account" and "save to a folder" so both paths get
 * the same validation: the API can answer JSON on error, and writing that to a
 * `.png` produces a file Minecraft silently rejects.
 */
async function fetchSkinPng(skinId: number): Promise<{ skin: SlattSkin; buf: Buffer }> {
  const skins = await listSkins();
  const skin = skins.find((s) => s.id === skinId);
  if (!skin) throw new Error('皮肤库中找不到该皮肤');

  // The site content-negotiates skin images and answers lossy AVIF unless PNG is
  // requested. It also omits `Vary: Accept`, so a cached AVIF variant would be
  // reused even for a PNG request — `no-store` keeps the format honest. Either
  // failure mode would silently corrupt the file we write to disk.
  const res = await fetch(skin.skinUrl, {
    headers: { 'User-Agent': userAgent(), Accept: 'image/png' },
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
  }).catch(() => {
    throw new Error('皮肤下载失败，请检查网络后重试');
  });

  if (!res.ok) throw new Error(await readError(res));

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 33 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('皮肤文件无效（不是 PNG）');
  }
  return { skin, buf };
}

/**
 * Strip characters Windows forbids in file names, and guarantee a non-empty stem.
 * Skin names come from members and can contain `/`, `:` or emoji.
 */
function safeFileName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/** Download a library skin into an arbitrary folder (no account involved). */
export async function saveSkinToFolder(skinId: number, targetDir: string): Promise<string> {
  requireLogin();

  const dir = (targetDir ?? '').trim();
  if (!dir) throw new Error('请选择保存位置');
  if (!existsSync(dir)) throw new Error('目标文件夹不存在');

  const { skin, buf } = await fetchSkinPng(skinId);

  const stem = safeFileName(skin.name, `skin-${skin.id}`);
  // Never overwrite silently: append (2), (3) … like the rest of the app.
  let dest = join(dir, `${stem}.png`);
  for (let i = 2; existsSync(dest) && i < 1000; i += 1) {
    dest = join(dir, `${stem} (${i}).png`);
  }

  await writeFile(dest, buf);
  return dest;
}

/**
 * Download a library skin and install it on the target Minecraft account.
 *
 * Microsoft accounts: the skin is **uploaded to Mojang** so it becomes the real
 * profile skin (visible in game and to other players). If the upload fails — most
 * commonly an expired Minecraft token, which lives only in memory — we fall back
 * to a local preview and report why, instead of failing outright.
 *
 * Offline accounts have no Mojang profile, so the local skin *is* the skin.
 */
export async function applySkin(accountId: string, skinId: number): Promise<SlattApplyResult> {
  requireLogin();

  const account = getSettings().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('找不到要安装皮肤的账户');

  const { skin, buf } = await fetchSkinPng(skinId);
  const pngBase64 = buf.toString('base64');

  if (account.type === 'microsoft') {
    // Mojang only accepts 64x64 / 64x32 skins. HD skins (128x128) are common in
    // the team library, so refuse the upload up front and keep the local preview
    // rather than letting the server answer with an opaque error.
    const dims = pngDimensions(buf);
    const uploadable = isUploadableSkinSize(buf);
    if (!uploadable) {
      setLocalSkin(accountId, pngBase64);
      const size = dims ? `${dims.width}×${dims.height}` : '未知尺寸';
      return {
        accountId,
        accountName: account.name,
        skinName: skin.name,
        uploaded: false,
        uploadError: `Minecraft 官方只接受 64×64 或 64×32 的皮肤，这款是 ${size}，已仅应用到启动器预览`,
      };
    }

    try {
      // `model` already uses Mojang's own vocabulary (classic / slim).
      await uploadSkin(accountId, skin.model, pngBase64);
      return {
        accountId,
        accountName: account.name,
        skinName: skin.name,
        uploaded: true,
      };
    } catch (e) {
      // Keep the preview so the click still does something visible, and surface
      // the reason so the UI can tell the user to re-login.
      setLocalSkin(accountId, pngBase64);
      return {
        accountId,
        accountName: account.name,
        skinName: skin.name,
        uploaded: false,
        uploadError: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // A LittleSkin account's skin is owned by LittleSkin and resolved through its
  // Yggdrasil texture server, so a local file would neither show in the launcher
  // (the preview reads the online skin) nor reach the game. Point the user at the
  // place where the change actually has to happen.
  if (account.type === 'littleskin') {
    throw new Error(
      'LittleSkin 账户的皮肤由 LittleSkin 官网管理，无法在这里安装。请在启动器主页点击头像或「LittleSkin 角色」进入官网衣柜更换皮肤。',
    );
  }

  setLocalSkin(accountId, pngBase64);
  return {
    accountId,
    accountName: account.name,
    skinName: skin.name,
    uploaded: false,
  };
}

/** Exposed for the More page: lets the user re-read their own bound skin state. */
export async function refreshProfile(): Promise<SlattSession> {
  const stored = loadToken();
  if (!stored) throw new Error('请先登录 SLATT 团队账号');

  const res = await fetch(`${API}/profile`, {
    headers: { Authorization: `Bearer ${stored.token}`, 'User-Agent': userAgent(), Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  }).catch(() => {
    throw new Error('无法连接 slatt.cn，请检查网络后重试');
  });

  if (res.status === 401 || res.status === 403) {
    clearToken();
    cachedUser = null;
    throw new Error('登录已失效，请重新登录');
  }
  if (!res.ok) throw new Error(await readError(res));

  const body = (await res.json()) as RawProfileResponse;
  if (!body.success || !body.user) throw new Error(body.error ?? '资料读取失败');

  cachedUser = toUser(body.user);
  return { user: cachedUser, expiresAt: cachedExpiresAt };
}
