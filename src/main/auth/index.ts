import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { MicrosoftAuthenticator, offline } from '@xmcl/user';
import type { AccountProfile, LoginProgress, MicrosoftDeviceCode, SkinLookupResult } from '@shared/types';
import { getSettings, updateSettings } from '../settings/store';

/**
 * The public client id of the official Minecraft launcher.
 * NOTE: this client id is registered on the legacy Live (MSA v1) OAuth endpoint,
 * NOT the Azure AD v2 endpoint that MSAL uses. It only works with the raw
 * live.com device-code endpoints and the `service::user.auth.xboxlive.com::MBI_SSL`
 * scope. Using MSAL (login.microsoftonline.com) with this id returns `invalid_grant`.
 */
const MS_CLIENT_ID = '00000000402b5328';
const MS_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';

const mcAuthenticator = new MicrosoftAuthenticator();

let cancelCurrentLogin: (() => void) | null = null;

export function cancelMicrosoftLogin(): void {
  cancelCurrentLogin?.();
  cancelCurrentLogin = null;
}

function createCancelPromise(): { promise: Promise<never>; cancel: () => void } {
  let cancel!: () => void;
  const promise = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error('已取消登录'));
  });
  return { promise, cancel };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Abortable fetch that throws '已取消登录' when the cancel signal fires. */
async function liveFetch(url: string, body: URLSearchParams, signal: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (signal.aborted) throw new Error('已取消登录');
  return data;
}

/**
 * Authenticate with Xbox Live using a live.com (MSA v1) access token.
 * The RpsTicket uses the `t=` prefix (vs `d=` for Azure AD v2 tokens).
 * Returns the XBL token string for the subsequent XSTS authorize step.
 */
async function xblAuthenticate(liveAccessToken: string): Promise<string> {
  const res = await fetch('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-xbl-contract-version': '1' },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `t=${liveAccessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
  });
  if (res.status !== 200) {
    const text = await res.text();
    let detail = '';
    try {
      const j = JSON.parse(text) as { XErr?: string; Message?: string };
      detail = j.XErr ? ` (${j.XErr}: ${j.Message ?? ''})` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`Xbox Live 认证失败 (${res.status})${detail}`);
  }
  const data = (await res.json()) as { Token?: string };
  if (typeof data.Token !== 'string') throw new Error('Xbox Live 认证返回缺少令牌');
  return data.Token;
}

/**
 * In-memory cache of Microsoft access tokens keyed by account id.
 * Minecraft access tokens are NOT persisted to disk for security.
 */
const msTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function formatUuid(raw: string): string {
  const clean = raw.replace(/-/g, '');
  if (clean.length !== 32) return raw;
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

export function listAccounts(): AccountProfile[] {
  return getSettings().accounts;
}

export function selectedAccount(): AccountProfile | null {
  const s = getSettings();
  return s.accounts.find((a) => a.id === s.selectedAccountId) ?? null;
}

export function selectAccount(id: string | null): void {
  updateSettings({ selectedAccountId: id });
}

export function removeAccount(id: string): void {
  const s = getSettings();
  const accounts = s.accounts.filter((a) => a.id !== id);
  msTokenCache.delete(id);
  clearLocalSkin(id);
  updateSettings({
    accounts,
    selectedAccountId: s.selectedAccountId === id ? null : s.selectedAccountId,
  });
}

export function loginOffline(username: string): AccountProfile {
  const name = username.trim();
  if (!name) throw new Error('用户名不能为空');
  const auth = offline(name);
  const profile: AccountProfile = {
    id: auth.selectedProfile.id,
    name: auth.selectedProfile.name,
    type: 'offline',
    uuid: auth.selectedProfile.id,
  };
  const s = getSettings();
  // Replace an existing offline account with the same name.
  const accounts = s.accounts.filter((a) => !(a.type === 'offline' && a.name === name));
  accounts.push(profile);
  updateSettings({ accounts, selectedAccountId: profile.id });
  return profile;
}

/**
 * Run the Microsoft device-code login flow via the legacy Live OAuth endpoint.
 * `onProgress` receives live status so the renderer can display the code and result.
 */
export async function loginMicrosoft(onProgress: (p: LoginProgress) => void): Promise<AccountProfile> {
  const controller = new AbortController();
  const { promise: cancelPromise, cancel } = createCancelPromise();
  cancelCurrentLogin = cancel;

  let msAccessToken: string;
  try {
    // 1. Request a device code.
    const codeData = await liveFetch(
      DEVICE_CODE_URL,
      new URLSearchParams({ client_id: MS_CLIENT_ID, response_type: 'device_code', scope: MS_SCOPE }),
      controller.signal,
    );
    if (typeof codeData.user_code !== 'string' || typeof codeData.device_code !== 'string') {
      throw new Error('获取登录验证码失败,请重试');
    }
    const deviceCode: MicrosoftDeviceCode = {
      userCode: codeData.user_code,
      verificationUri: (codeData.verification_uri as string) ?? 'https://microsoft.com/devicelogin',
      message: (codeData.message as string) ?? '',
      expiresAt: Date.now() + ((codeData.expires_in as number) ?? 900) * 1000,
    };
    onProgress({ status: 'device_code', deviceCode });
    onProgress({ status: 'waiting' });

    const interval = Math.max((codeData.interval as number) ?? 5, 3);

    // 2. Poll the token endpoint until the user authorizes or it expires.
    let msToken: Record<string, unknown> | null = null;
    while (msToken === null) {
      await Promise.race([sleep(interval * 1000), cancelPromise]);
      if (controller.signal.aborted) throw new Error('已取消登录');

      const res = await liveFetch(
        TOKEN_URL,
        new URLSearchParams({
          client_id: MS_CLIENT_ID,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: codeData.device_code as string,
        }),
        controller.signal,
      );

      if (typeof res.access_token === 'string') {
        msToken = res;
        break;
      }
      const err = res.error as string | undefined;
      if (err === 'authorization_pending') continue; // keep waiting
      if (err === 'slow_down') continue; // back off handled by interval
      if (err === 'expired_token') throw new Error('验证码已过期,请重新登录');
      if (err === 'authorization_declined') throw new Error('已拒绝授权');
      throw new Error(`登录失败: ${err ?? '未知错误'}`);
    }

    if (!msToken || typeof msToken.access_token !== 'string') {
      throw new Error('未获取到 Microsoft 访问令牌');
    }
    msAccessToken = msToken.access_token;
  } catch (e) {
    onProgress({ status: 'error', error: messageOf(e) });
    throw e;
  } finally {
    cancelCurrentLogin = null;
  }

  try {
    // Exchange the Live access token -> XBL -> XSTS -> Minecraft access token.
    // NOTE: @xmcl/user's `acquireXBoxToken` hardcodes `RpsTicket: d=<token>` (Azure AD v2
    // prefix), which is WRONG for a live.com MBI_SSL token — it needs `t=<token>`.
    // So we do the XBL authenticate step ourselves and reuse authorizeXboxLive (XSTS)
    // and loginMinecraftWithXBox (Minecraft login), which are prefix-agnostic.
    const xblToken = await xblAuthenticate(msAccessToken);
    const minecraftXstsResponse = await mcAuthenticator.authorizeXboxLive(xblToken, 'rp://api.minecraftservices.com/');
    const mcAuth = await mcAuthenticator.loginMinecraftWithXBox(
      minecraftXstsResponse.DisplayClaims.xui[0].uhs,
      minecraftXstsResponse.Token,
    );

    // Fetch the Minecraft profile to get the real UUID (and verify game ownership).
    const profileRes = await fetch('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${mcAuth.access_token}` },
    });
    if (!profileRes.ok) {
      throw new Error('该 Microsoft 账户未拥有 Minecraft(Java 版),无法登录');
    }
    const profileData = (await profileRes.json()) as { id: string; name: string };

    const profile: AccountProfile = {
      id: formatUuid(profileData.id),
      name: profileData.name,
      type: 'microsoft',
      uuid: formatUuid(profileData.id),
      lastLoginAt: new Date().toISOString(),
    };

    msTokenCache.set(profile.id, {
      accessToken: mcAuth.access_token,
      expiresAt: Date.now() + mcAuth.expires_in * 1000,
    });

    const s = getSettings();
    const accounts = s.accounts.filter((a) => a.id !== profile.id);
    accounts.push(profile);
    updateSettings({ accounts, selectedAccountId: profile.id });

    onProgress({ status: 'success', account: profile });
    return profile;
  } catch (e) {
    onProgress({ status: 'error', error: messageOf(e) });
    throw e;
  }
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---- LittleSkin (Yggdrasil / authlib-injector) ----

/** LittleSkin's Yggdrasil API root. Passed to authlib-injector at launch time too. */
export const LITTLESKIN_API_ROOT = 'https://littleskin.cn/api/yggdrasil';

interface YggdrasilProfile {
  id: string;
  name: string;
}

interface YggdrasilAuthResponse {
  accessToken?: string;
  clientToken?: string;
  selectedProfile?: YggdrasilProfile;
  availableProfiles?: YggdrasilProfile[];
}

interface YggdrasilErrorBody {
  error?: string;
  errorMessage?: string;
}

/** Thrown when the Yggdrasil server rejects a token (HTTP 401/403). */
class YggdrasilAuthError extends Error {}

async function yggdrasilRequest<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(`${LITTLESKIN_API_ROOT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as YggdrasilErrorBody;
      detail = j.errorMessage || j.error || '';
    } catch {
      /* non-JSON error body */
    }
    const message = detail || `LittleSkin 请求失败 (${res.status})`;
    if (res.status === 401 || res.status === 403) throw new YggdrasilAuthError(message);
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** Persist a LittleSkin account (replacing any previous entry for the same UUID). */
function saveLittleSkinAccount(profile: YggdrasilProfile, accessToken: string, clientToken: string): AccountProfile {
  const s = getSettings();
  const account: AccountProfile = {
    id: `littleskin:${profile.id}`,
    name: profile.name,
    type: 'littleskin',
    uuid: profile.id,
    accessToken,
    clientToken,
    lastLoginAt: new Date().toISOString(),
  };
  const accounts = s.accounts.filter((a) => a.id !== account.id);
  accounts.push(account);
  updateSettings({ accounts, selectedAccountId: account.id });
  return account;
}

/** Sign in to LittleSkin with an email/username + password (Yggdrasil authenticate). */
export async function loginLittleSkin(username: string, password: string): Promise<AccountProfile> {
  const user = username.trim();
  if (!user) throw new Error('请输入 LittleSkin 邮箱或用户名');
  if (!password) throw new Error('请输入密码');

  const clientToken = randomUUID().replace(/-/g, '');
  let data: YggdrasilAuthResponse;
  try {
    data = await yggdrasilRequest<YggdrasilAuthResponse>('/authserver/authenticate', {
      agent: { name: 'Minecraft', version: 1 },
      username: user,
      password,
      clientToken,
      requestUser: false,
    });
  } catch (e) {
    if (e instanceof YggdrasilAuthError) {
      throw new Error(`LittleSkin 登录失败:${e.message}`);
    }
    throw e;
  }

  const profile = data.selectedProfile ?? data.availableProfiles?.[0];
  if (!profile || !data.accessToken) throw new Error('LittleSkin 未返回角色信息,请先在 LittleSkin 官网创建角色');

  skinMemo.delete(`littleskin:${profile.id}`);
  return saveLittleSkinAccount(profile, data.accessToken, data.clientToken ?? clientToken);
}

/**
 * Ensure a LittleSkin account has a usable access token.
 * Yggdrasil access tokens can expire; refresh with the stored clientToken when needed.
 */
async function ensureLittleSkinToken(account: AccountProfile): Promise<string> {
  const accessToken = account.accessToken;
  const clientToken = account.clientToken;
  if (accessToken && clientToken) {
    try {
      await yggdrasilRequest<void>('/authserver/validate', { accessToken, clientToken });
      return accessToken;
    } catch (e) {
      // A network failure should not block a launch that otherwise works offline;
      // only an explicit auth rejection (401/403) means the token is really dead.
      if (!(e instanceof YggdrasilAuthError)) return accessToken;
    }
    try {
      const refreshed = await yggdrasilRequest<YggdrasilAuthResponse>('/authserver/refresh', {
        accessToken,
        clientToken,
        requestUser: false,
      });
      const refreshedToken = refreshed.accessToken;
      if (refreshedToken) {
        const next: AccountProfile = {
          ...account,
          accessToken: refreshedToken,
          clientToken: refreshed.clientToken ?? clientToken,
        };
        const s = getSettings();
        updateSettings({ accounts: s.accounts.map((a) => (a.id === account.id ? next : a)) });
        return refreshedToken;
      }
    } catch (e) {
      if (!(e instanceof YggdrasilAuthError)) throw e;
    }
  }
  throw new Error('LittleSkin 登录已过期,请重新登录');
}

/**
 * Resolve launch auth info for any account type.
 * Microsoft/LittleSkin tokens may need a network refresh, hence async.
 */
export async function resolveLaunchUser(accountId: string): Promise<{
  name: string;
  uuid: string;
  accessToken: string;
  userType: 'legacy' | 'msa';
  authlibInjector?: { apiRoot: string };
}> {
  const account = getSettings().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('未找到该账户');

  if (account.type === 'littleskin') {
    const accessToken = await ensureLittleSkinToken(account);
    return {
      name: account.name,
      uuid: account.uuid,
      accessToken,
      userType: 'msa',
      authlibInjector: { apiRoot: LITTLESKIN_API_ROOT },
    };
  }
  return getLaunchUser(accountId);
}

/**
 * Resolve the launch auth info for a given account.
 * For Microsoft accounts, requires a fresh in-memory token (re-login if expired).
 */
export function getLaunchUser(accountId: string): {
  name: string;
  uuid: string;
  accessToken: string;
  userType: 'legacy' | 'msa';
} {
  const account = getSettings().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('未找到该账户');

  if (account.type === 'littleskin') {
    // LittleSkin tokens need an async refresh; the launcher must use resolveLaunchUser.
    throw new Error('内部错误:LittleSkin 账户必须通过 resolveLaunchUser 解析');
  }

  if (account.type === 'offline') {
    return {
      name: account.name,
      uuid: account.uuid,
      accessToken: randomUUID().replace(/-/g, ''),
      userType: 'legacy',
    };
  }

  const cached = msTokenCache.get(account.id);
  if (!cached || cached.expiresAt <= Date.now()) {
    throw new Error('Microsoft 账户登录已过期,请重新登录');
  }
  return {
    name: account.name,
    uuid: account.uuid,
    accessToken: cached.accessToken,
    userType: 'msa',
  };
}

// ---- skin management ----

/** Mojang's official default "Steve" skin (64x64 PNG), base64-encoded. */
const STEVE_SKIN_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAEwElEQVR4Xu1av2sUURgMqCABQQVBBK0SCdooMQQD5jSFkNgpKdIEwSZoZ6GYJohNUmlhqrSxsUlhYZM/If/TmdncrLOz3+7drcneXtyB4f36bvNm3vd2l32ZmOiD+3eudMHZqWtJyTrbn189LqVfb+xAwZ17N1LxqLsBH17MZniuDFDBXn5b6+TEkxjz640dXLSmP8r/wgDd+74VILJoC5wLA3TFNRsgHqRQv/mh7+v64vkwwO8BSoiE4KLSrzd2UNF+QwQpdnn6aobs9+s1DpraFDZ183Im5ZkFSjVBf6PX0WtEcSh9PrUjmiBIIVpX8V7yd5Foxvn10efzqR0qwifMvr03y91fn9a7v7+8S8qf79eSvkfT13OxINvs0zpNYJ/Pp3ZwQjpRXUkIhWAIp3gSY5Go6JqsM55tn0/t0ImxxCMM4iACQoGXT3ZS0agDaCMGffhNdC0aGhnUCAN8hShIyRV/+/RBQs0AJUX5yuv9QQ1B2+dTOzgRlFx5PsO/v15MX2jwaPu4NJdw6fZkJoaPPGaCXtMN8LbPp3bwrU3FuwkoIRomsKRoGqS/5fX0zfDurckM2e/zGTkWHu50lfPz8wlnZmYSenwOR0fp9lBj0Ycxv77TL5fDwUE34f5+Znt6WGX4hCicRnh8DsciVbyacNoGqNEeVhk+oSoZcNYGTB4epgY0MgPOdAscC9ct8M8Z8Gxurwvij6N8vvAjJftYkjp+cXc3Q0/PVHxv4kXxYKafQpW9uLS9tZWlxg4KChzUAB0HMdlL29sJU0E9oUxP74/iMyK9j/2RARsbJ6QBHB8UZQI9O3wchJALm5sJUdcURel9Hu8muFkZ8WJGMlZkADgoygQWGaB1iiH7CfL4UJi0c2mupHg1gRwULpDtqE/HSBeUWXEzQFc/MiC39/f/3uh4s9N6RI67zkK4Ab7CkSHa9pRODegJcQM83jMkFd9r66OON1Rtq+hKj8XIAN8GZeMURXoK66p6bBTvv3VhKj4ygKXrLASFFQnsZwAmqWKSDNAVZTb0BHl8aIDED2oAykoZ4OmtwpUeR1KQiqNwF8cYj8sYIOIR4yvrBqgRlQxYWVnpgn5zczLOqaIiM1Sgx6YGiGgVD6rgoizQLTC0AXi97XQ6GVGrq6s5oYjxWNR1i6hhmjk0gsI8RrePxiATIwM0K9wAlq6zEHzHpzgXSOFRHOpqAKnbiCVX1OP9XsMY9pcJ1/3vRrjOFi1atGjRosX4AR9Ai5h5fT44+ViajrVo0aJFixYtWtQN/5Q29OGqfELTDyEe1li4AUMfr4sBmZPlcYEbUCUD+JrLDBhrAypnwHFZ6airbujXX//I6WM6zpjcgaefEbDtbAoGEcls8DEwPOJWA9wEtpsCNwClG6Dj/QxID0vcCK83BS7QRfq49iUGlJ3xl5HQTOmZ498NnKdqoItnO+rTMdLP9/XG5wce2u/zGBmKBPtq67jGu1h99Hm7kY/FSGC/LaB0A4pEs5+lz2NkcIEoIwMic8DofM/Fq/DGZYCnv6+09kfbJNrnkXDv93mMDDxJpsAi+nE7WSY+Et44A3hcrqKG+f+CyAAV7Qaw7fMYGaL/G1CBFB7FoQ5BRfeByAiO+zyq4g8lK5z2I+oYkQAAAABJRU5ErkJggg==';

export type SkinVariant = 'classic' | 'slim';

/** How long a premium (live) skin cache stays fresh before a re-fetch. */
const LIVE_SKIN_TTL_MS = 24 * 60 * 60 * 1000;

/** In-memory cache: accountId -> skin data URL (fast path, avoids IPC/disk on every switch). */
const skinMemo = new Map<string, string>();

function getSkinsRoot(): string {
  const dir = join(app.getPath('userData'), 'skins');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeKey(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, '_');
}

/** User-chosen skin (authoritative, never expires). */
function localSkinPath(accountId: string): string {
  const dir = join(getSkinsRoot(), 'local');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${safeKey(accountId)}.png`);
}

/** Premium skin downloaded from Mojang/mirrors (cached with TTL). */
function liveSkinPaths(uuid: string): { png: string; meta: string } {
  const dir = join(getSkinsRoot(), 'live');
  mkdirSync(dir, { recursive: true });
  const k = safeKey(uuid.replace(/-/g, ''));
  return { png: join(dir, `${k}.png`), meta: join(dir, `${k}.json`) };
}

function fileToDataUrl(p: string): string | null {
  if (!existsSync(p)) return null;
  try {
    return `data:image/png;base64,${readFileSync(p).toString('base64')}`;
  } catch {
    return null;
  }
}

function readLocalSkin(accountId: string): string | null {
  return fileToDataUrl(localSkinPath(accountId));
}

function saveLocalSkin(accountId: string, pngBase64: string): void {
  writeFileSync(localSkinPath(accountId), Buffer.from(pngBase64, 'base64'));
  skinMemo.delete(accountId);
}

function clearLocalSkin(accountId: string): void {
  rmSync(localSkinPath(accountId), { force: true });
  skinMemo.delete(accountId);
}

/** Read a cached premium skin. When `checkTtl`, stale entries are treated as missing. */
function readLiveSkin(uuid: string, checkTtl: boolean): string | null {
  const { png, meta } = liveSkinPaths(uuid);
  if (!existsSync(png)) return null;
  if (checkTtl) {
    try {
      const m = JSON.parse(readFileSync(meta, 'utf8')) as { fetchedAt?: number };
      if (!m.fetchedAt || Date.now() - m.fetchedAt > LIVE_SKIN_TTL_MS) return null;
    } catch {
      return null;
    }
  }
  return fileToDataUrl(png);
}

function writeLiveSkin(uuid: string, buf: Buffer): void {
  const { png, meta } = liveSkinPaths(uuid);
  writeFileSync(png, buf);
  writeFileSync(meta, JSON.stringify({ fetchedAt: Date.now() }));
}

/** Drop a premium skin cache (used when the account's skin is reset). */
function clearLiveSkin(uuid: string): void {
  const { png, meta } = liveSkinPaths(uuid);
  rmSync(png, { force: true });
  rmSync(meta, { force: true });
}

function steveDataUrl(): string {
  return `data:image/png;base64,${STEVE_SKIN_B64}`;
}

/**
 * Download a premium skin PNG by UUID.
 * `textures.minecraft.net` is frequently blocked in some regions (ECONNRESET),
 * so we go through public skin mirrors first, then fall back to the official URL.
 */
async function downloadSkinImage(uuid: string): Promise<Buffer | null> {
  const id = uuid.replace(/-/g, '');
  const sources = [
    `https://mc-heads.net/skin/${id}`,
    `https://crafatar.com/skins/${id}`,
    `https://api.mineatar.io/skin/${id}`,
  ];
  for (const url of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // Validate PNG signature (89 50 4E 47).
      if (buf.length > 8 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return buf;
    } catch {
      /* try next source */
    }
  }
  // Last resort: official textures URL resolved via the session server.
  try {
    const prof = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (prof.ok) {
      const data = (await prof.json()) as { properties?: Array<{ name: string; value: string }> };
      const tex = data.properties?.find((p) => p.name === 'textures');
      const decoded = tex
        ? (JSON.parse(Buffer.from(tex.value, 'base64').toString('utf8')) as { textures?: { SKIN?: { url?: string } } })
        : null;
      const url = decoded?.textures?.SKIN?.url;
      if (url) {
        const res = await fetch(url.replace('http://', 'https://'), { signal: AbortSignal.timeout(8000) });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Fetch the skin data URL for a premium account (and cache it on disk). */
async function fetchPremiumSkin(uuid: string): Promise<string | null> {
  const buf = await downloadSkinImage(uuid);
  if (!buf) return null;
  writeLiveSkin(uuid, buf);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/**
 * Resolve a LittleSkin player's skin by UUID.
 * LittleSkin serves textures through its Yggdrasil session server (same shape as Mojang),
 * so we decode the signed `textures` property and download the referenced PNG.
 */
async function downloadLittleSkinImage(uuid: string): Promise<Buffer | null> {
  const id = uuid.replace(/-/g, '');
  try {
    const res = await fetch(`${LITTLESKIN_API_ROOT}/sessionserver/session/minecraft/profile/${id}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { properties?: Array<{ name: string; value: string }> };
    const tex = data.properties?.find((p) => p.name === 'textures');
    if (!tex) return null;
    const decoded = JSON.parse(Buffer.from(tex.value, 'base64').toString('utf8')) as {
      textures?: { SKIN?: { url?: string } };
    };
    const url = decoded.textures?.SKIN?.url;
    if (!url) return null;
    const img = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 8 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return buf;
  } catch {
    /* ignore */
  }
  return null;
}

/** Fetch + cache a LittleSkin player's skin. */
async function fetchLittleSkinSkin(uuid: string): Promise<string | null> {
  const buf = await downloadLittleSkinImage(uuid);
  if (!buf) return null;
  writeLiveSkin(uuid, buf);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/**
 * Get the skin (data URL) to display for an account.
 * Priority: user-chosen local skin -> cached online skin -> live fetch -> Steve.
 * `force` bypasses the in-memory and TTL caches (the "refresh preview" action); in that
 * mode a failed download is reported as an error instead of silently reusing stale data.
 */
export async function getSkin(accountId: string, force = false): Promise<string> {
  // 1. A user-chosen skin is authoritative and instant.
  const local = readLocalSkin(accountId);
  if (local) {
    skinMemo.set(accountId, local);
    return local;
  }

  // 2. In-memory memo (sub-millisecond).
  if (!force) {
    const memo = skinMemo.get(accountId);
    if (memo) return memo;
  }

  const account = getSettings().accounts.find((a) => a.id === accountId);
  const online = account?.type === 'microsoft' || account?.type === 'littleskin';

  if (account && online) {
    // 3. Disk cache (fresh within TTL).
    if (!force) {
      const cached = readLiveSkin(account.uuid, true);
      if (cached) {
        skinMemo.set(accountId, cached);
        return cached;
      }
    }
    // 4. Network fetch (Mojang mirrors vs LittleSkin's Yggdrasil texture).
    const fetched =
      account.type === 'littleskin' ? await fetchLittleSkinSkin(account.uuid) : await fetchPremiumSkin(account.uuid);
    if (fetched) {
      skinMemo.set(accountId, fetched);
      return fetched;
    }
    // 5. Network failed: an explicit refresh must surface the failure, otherwise fall back.
    if (force) throw new Error('刷新皮肤失败,请检查网络连接后重试');
    const stale = readLiveSkin(account.uuid, false);
    if (stale) {
      skinMemo.set(accountId, stale);
      return stale;
    }
  }

  // Default skin (do not memoize for online accounts so a retry can succeed later).
  const steve = steveDataUrl();
  if (!online) skinMemo.set(accountId, steve);
  return steve;
}

/** Save a user-picked PNG as the account's local skin (preview only for offline accounts). */
export function setLocalSkin(accountId: string, pngBase64: string): void {
  saveLocalSkin(accountId, pngBase64);
}

/** Look up a premium account's skin by username (Mojang public APIs, no auth needed). */
export async function lookupSkinByUsername(username: string): Promise<SkinLookupResult> {
  const name = username.trim();
  if (!name) throw new Error('请输入正版用户名');
  const uRes = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  if (uRes.status === 404) throw new Error(`找不到正版账户「${name}」`);
  if (!uRes.ok) throw new Error(`查询账户失败 (${uRes.status})`);
  const u = (await uRes.json()) as { id?: string; name?: string };
  if (!u.id) throw new Error(`找不到正版账户「${name}」`);

  const skin = await fetchPremiumSkin(u.id);
  if (!skin) throw new Error(`账户「${u.name ?? name}」没有自定义皮肤`);

  // Detect slim model from the textures metadata.
  let slim = false;
  try {
    const pRes = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${u.id}`);
    const data = (await pRes.json()) as { properties?: Array<{ name: string; value: string }> };
    const tex = data.properties?.find((p) => p.name === 'textures');
    if (tex) {
      const decoded = JSON.parse(Buffer.from(tex.value, 'base64').toString('utf8')) as {
        textures?: { SKIN?: { metadata?: { model?: string } } };
      };
      slim = decoded.textures?.SKIN?.metadata?.model === 'slim';
    }
  } catch {
    /* ignore */
  }

  return { name: u.name ?? name, uuid: u.id, skin, slim };
}

/** Apply a premium account's skin to a local account (saved as the local skin cache). */
export async function applySkinFromUsername(accountId: string, username: string): Promise<SkinLookupResult> {
  const result = await lookupSkinByUsername(username);
  const b64 = result.skin.split(',')[1] ?? '';
  if (!b64) throw new Error('获取皮肤数据失败');
  saveLocalSkin(accountId, b64);
  return result;
}

/** Get the in-memory Minecraft access token for a Microsoft account. */
function getMcAccessToken(accountId: string): string {
  const cached = msTokenCache.get(accountId);
  if (!cached || cached.expiresAt <= Date.now()) {
    throw new Error('账户登录已过期,请先重新登录再更换皮肤');
  }
  return cached.accessToken;
}

/**
 * Upload a skin (PNG) for a Microsoft account.
 * `pngBase64` is the raw PNG bytes base64-encoded.
 */
export async function uploadSkin(accountId: string, variant: SkinVariant, pngBase64: string): Promise<void> {
  const token = getMcAccessToken(accountId);
  const buf = Buffer.from(pngBase64, 'base64');
  const blob = new Blob([buf], { type: 'image/png' });
  const form = new FormData();
  form.append('variant', variant);
  form.append('file', blob, 'skin.png');

  const res = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`更换皮肤失败 (${res.status}): ${text.slice(0, 200)}`);
  }
  // Cache locally so it shows even after the token expires.
  saveLocalSkin(accountId, pngBase64);
}

/** Reset an account's skin to the default (clears local cache; for Microsoft also resets on Mojang). */
export async function resetSkin(accountId: string): Promise<void> {
  const account = getSettings().accounts.find((a) => a.id === accountId);
  clearLocalSkin(accountId);
  if (account?.type === 'microsoft') {
    const cached = msTokenCache.get(accountId);
    if (cached && cached.expiresAt > Date.now()) {
      const res = await fetch('https://api.minecraftservices.com/minecraft/profile/skins/active', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cached.accessToken}` },
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`重置皮肤失败 (${res.status})`);
      }
    }
    // The cached premium skin no longer matches the account; force a fresh download next time.
    clearLiveSkin(account.uuid);
  }
}
