import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { MicrosoftAuthenticator, offline } from '@xmcl/user';
import type {
  AccountProfile,
  LittleSkinRoles,
  LoginProgress,
  MicrosoftDeviceCode,
  SkinLookupResult,
  SkinVariant,
} from '@shared/types';
import { getSettings, updateSettings } from '../settings/store';
import { forgetCredential, listRemembered, recallCredential, rememberCredential } from './credentials';

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
function saveLittleSkinAccount(
  profile: YggdrasilProfile,
  accessToken: string,
  clientToken: string,
  profiles: YggdrasilProfile[],
  loginName: string,
): AccountProfile {
  const s = getSettings();
  const account: AccountProfile = {
    id: `littleskin:${profile.id}`,
    name: profile.name,
    type: 'littleskin',
    uuid: profile.id,
    accessToken,
    clientToken,
    profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
    loginName,
    lastLoginAt: new Date().toISOString(),
  };
  const accounts = s.accounts.filter((a) => a.id !== account.id);
  accounts.push(account);
  updateSettings({ accounts, selectedAccountId: account.id });
  return account;
}

/**
 * Bind a freshly issued, *unbound* token to a profile.
 *
 * Yggdrasil only allows this once per token: after binding, further attempts are
 * rejected with "Access token already has a profile assigned". Binding is however
 * mandatory for gameplay — an unbound token is refused by the session join
 * endpoint (403), so multiplayer would break without it.
 */
async function bindLittleSkinProfile(
  accessToken: string,
  clientToken: string,
  profile: YggdrasilProfile,
): Promise<YggdrasilAuthResponse> {
  return yggdrasilRequest<YggdrasilAuthResponse>('/authserver/refresh', {
    accessToken,
    clientToken,
    requestUser: false,
    selectedProfile: { id: profile.id, name: profile.name },
  });
}

/** Sign in to LittleSkin with an email/username + password (Yggdrasil authenticate). */
export async function loginLittleSkin(
  username: string,
  password: string,
  remember = true,
): Promise<AccountProfile> {
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

  if (!data.accessToken) throw new Error('LittleSkin 未返回登录凭证');

  // Keep the full character list: the Yggdrasil API only exposes it in this
  // response, and role switching later depends on it.
  const available = data.availableProfiles?.length
    ? data.availableProfiles
    : data.selectedProfile
      ? [data.selectedProfile]
      : [];
  if (available.length === 0) throw new Error('LittleSkin 未返回角色信息,请先在 LittleSkin 官网创建角色');

  let token = data.accessToken;
  let bound = data.selectedProfile;

  if (!bound) {
    // Pick the character this launcher already knew about, so re-logging in does
    // not silently move the user to a different character.
    const previous = getSettings().accounts.find((a) => a.id === `littleskin:${available[0].id}`);
    const remembered = previous ? available.find((p) => p.name === previous.name) : undefined;
    const target = remembered ?? available[0];
    try {
      const res = await bindLittleSkinProfile(token, data.clientToken ?? clientToken, target);
      token = res.accessToken ?? token;
      bound = res.selectedProfile ?? target;
    } catch {
      // Binding failed; fall back to the unbound token. Launching still works for
      // single-player, and the account stays switchable.
      bound = target;
    }
  }

  const finalClientToken = data.clientToken ?? clientToken;
  skinMemo.delete(`littleskin:${bound.id}`);

  // Remember (or forget) the password so later role switches do not have to ask
  // for it again — Yggdrasil only issues unbound tokens from authenticate().
  if (remember) rememberCredential(user, password);
  else forgetCredential(user);

  return saveLittleSkinAccount(bound, token, finalClientToken, available, user);
}

/**
 * Remembered LittleSkin logins, including the password, for prefilling the login
 * form. The password is included on purpose: the user asked for one-click login,
 * and it is only readable after DPAPI decryption under the same OS user.
 */
export function listRememberedLogins(): Array<{ loginName: string; password: string }> {
  return listRemembered().map((loginName) => ({
    loginName,
    password: recallCredential(loginName) ?? '',
  }));
}

/** Drop a remembered login (e.g. the password was changed on the website). */
export function forgetRememberedLogin(loginName: string): void {
  forgetCredential(loginName);
}
/** Narrow a stored account to a LittleSkin one, or explain why it isn't usable. */
function requireLittleSkinAccount(accountId: string): AccountProfile {
  const account = getSettings().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('未找到该账户');
  if (account.type !== 'littleskin') throw new Error('该账户不是 LittleSkin 账户');
  if (!account.accessToken) throw new Error('LittleSkin 登录信息不完整，请重新登录');
  return account;
}


/**
 * List the Minecraft characters owned by a LittleSkin account.
 *
 * The list comes from the authenticate response, which we persist on the account.
 * Accounts created before that field existed only have one character recorded, so
 * they fall back to a refresh — some servers include `availableProfiles` there as
 * well, and if not the user is told to sign in again.
 */
export async function listLittleSkinRoles(
  accountId: string,
  password?: string,
  loginName?: string,
): Promise<LittleSkinRoles> {
  const account = requireLittleSkinAccount(accountId);
  let profiles = account.profiles ?? [];
  let currentId = account.uuid;

  // With a password we can read the authoritative list: authenticate issues an
  // unbound token and returns every character. Accounts created before the
  // launcher stored `profiles` need this, since refresh alone does not include
  // the list.
  if (password) {
    const identifier = (loginName ?? account.loginName ?? '').trim();
    if (identifier.includes('@')) {
      try {
        const auth = await yggdrasilRequest<YggdrasilAuthResponse>('/authserver/authenticate', {
          agent: { name: 'Minecraft', version: 1 },
          username: identifier,
          password,
          clientToken: randomUUID().replace(/-/g, ''),
          requestUser: false,
        });
        const available = auth.availableProfiles ?? [];
        if (available.length > 0) {
          profiles = available.map((p) => ({ id: p.id, name: p.name }));
          const s = getSettings();
          const updated: AccountProfile = {
            ...account,
            profiles,
            loginName: identifier,
          };
          updateSettings({ accounts: s.accounts.map((a) => (a.id === account.id ? updated : a)) });
        }
      } catch (e) {
        if (e instanceof YggdrasilAuthError) throw new Error(`LittleSkin 密码验证失败：${e.message}`);
        throw e;
      }
    }
  }
  if (profiles.length === 0) {
    // Accounts signed in before the launcher stored the list: a refresh may still
    // return it, depending on the server. Never fatal — fall back to the character
    // we know about rather than showing an error.
    try {
      const res = await yggdrasilRequest<YggdrasilAuthResponse>('/authserver/refresh', {
        accessToken: account.accessToken,
        clientToken: account.clientToken,
        requestUser: false,
      });
      const available = res.availableProfiles ?? [];
      if (available.length > 0) {
        profiles = available.map((p) => ({ id: p.id, name: p.name }));
        currentId = res.selectedProfile?.id ?? currentId;
        // The refresh rotated the token; keep the account usable.
        const s = getSettings();
        const updated: AccountProfile = {
          ...account,
          accessToken: res.accessToken ?? account.accessToken,
          clientToken: res.clientToken ?? account.clientToken,
          uuid: currentId,
          name: res.selectedProfile?.name ?? account.name,
          profiles,
        };
        updateSettings({ accounts: s.accounts.map((a) => (a.id === account.id ? updated : a)) });
      }
    } catch {
      /* fall through to the single-character fallback */
    }
  }

  if (profiles.length === 0) {
    // Only the current character is known. Switching still works for it (a no-op),
    // and the UI explains that a re-login reveals the rest.
    return {
      roles: [{ id: account.uuid, name: account.name, selected: true }],
      needsRelogin: true,
    };
  }

  return {
    roles: profiles.map((p) => ({ id: p.id, name: p.name, selected: p.id === currentId })),
    needsRelogin: false,
  };
}

/**
 * Switch the LittleSkin account to another of its characters.
 *
 * Per the Yggdrasil spec this is a refresh carrying `selectedProfile`; the server
 * rotates the token and binds it to the new character. The launcher then updates
 * the stored uuid/name so launching and the skin lookup follow the new character.
 */
export async function switchLittleSkinRole(
  accountId: string,
  roleId: string,
  password?: string,
  loginName?: string,
): Promise<AccountProfile> {
  const account = requireLittleSkinAccount(accountId);
  const identifier = (loginName ?? account.loginName ?? '').trim();
  if (!identifier) throw new Error('请填写 LittleSkin 邮箱账号');
  if (!identifier.includes('@')) {
    throw new Error('切换角色需要使用邮箱登录。用角色名登录会立即绑定角色，无法再切换。');
  }

  // Prefer the remembered password so switching is one click, like other launchers.
  // The explicit argument wins (e.g. after the stored one stopped working).
  let secret = password?.trim() ?? '';
  if (!secret) {
    const remembered = recallCredential(identifier);
    if (remembered) secret = remembered;
  }
  if (!secret) {
    throw new Error('需要 LittleSkin 密码才能切换角色，请在弹窗中输入（可勾选记住密码）');
  }

  const clientToken = randomUUID().replace(/-/g, '');

  // Switching needs an UNBOUND token, and only authenticate issues one. A bound
  // token cannot be rebound (Yggdrasil rejects it), which is why credentials are
  // required here rather than reusing the stored token.
  let auth: YggdrasilAuthResponse;
  try {
    auth = await yggdrasilRequest<YggdrasilAuthResponse>('/authserver/authenticate', {
      agent: { name: 'Minecraft', version: 1 },
      username: identifier,
      password: secret,
      clientToken,
      requestUser: false,
    });
  } catch (e) {
    // A rejected stored password must not be reused forever.
    if (!password) forgetCredential(identifier);
    if (e instanceof YggdrasilAuthError) throw new Error(`LittleSkin 密码验证失败：${e.message}`);
    throw e;
  }

  if (!auth.accessToken) throw new Error('LittleSkin 未返回登录凭证');
  if (auth.selectedProfile) {
    throw new Error('该账号登录时已被绑定角色，无法切换。请改用邮箱登录。');
  }

  const available = auth.availableProfiles ?? [];
  if (available.length === 0) throw new Error('LittleSkin 未返回角色列表，请先到官网创建角色');

  const target = available.find((p) => p.id === roleId);
  if (!target) throw new Error('找不到该角色，请重新读取角色列表');

  const bound = await bindLittleSkinProfile(auth.accessToken, auth.clientToken ?? clientToken, target);

  // A successful switch proves the credentials work, so make sure they are kept
  // for next time even when the caller only supplied them ad hoc.
  rememberCredential(identifier, secret);

  // The cached skin belongs to the previous character.
  skinMemo.delete(accountId);
  const oldSkin = liveSkinPaths(account.uuid);
  rmSync(oldSkin.png, { force: true });
  rmSync(oldSkin.meta, { force: true });

  const updated: AccountProfile = {
    ...account,
    id: `littleskin:${bound.selectedProfile?.id ?? target.id}`,
    accessToken: bound.accessToken ?? auth.accessToken,
    clientToken: bound.clientToken ?? auth.clientToken ?? clientToken,
    uuid: bound.selectedProfile?.id ?? target.id,
    name: bound.selectedProfile?.name ?? target.name,
    profiles: available.map((p) => ({ id: p.id, name: p.name })),
    loginName: identifier,
    lastLoginAt: new Date().toISOString(),
  };
  const s = getSettings();
  // The account id embeds the profile uuid, so the id can change when the
  // character does — replace the old entry rather than appending a duplicate.
  const accounts = s.accounts.filter((a) => a.id !== account.id && a.id !== updated.id);
  accounts.push(updated);
  updateSettings({
    accounts,
    selectedAccountId: s.selectedAccountId === account.id ? updated.id : s.selectedAccountId,
  });
  return updated;
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

/** Re-exported so callers can keep importing it from the auth module. */
export type { SkinVariant };

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

/**
 * Arm width of the local skin.
 *
 * Minecraft bakes the model choice (Steve's 4px arms vs Alex's 3px) into the skin
 * texture metadata; the PNG itself has no such field. Without persisting it the
 * launcher had no way to tell the game which model to use, and every local skin
 * rendered with default-width arms.
 */
function localSkinMetaPath(accountId: string): string {
  return localSkinPath(accountId).replace(/\.png$/, '.json');
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

/** Arm width stored alongside the local skin; defaults to classic (Steve). */
function readLocalSkinVariant(accountId: string): SkinVariant {
  try {
    const raw = JSON.parse(readFileSync(localSkinMetaPath(accountId), 'utf8')) as {
      variant?: string;
    };
    return raw.variant === 'slim' ? 'slim' : 'classic';
  } catch {
    return 'classic';
  }
}

function saveLocalSkin(accountId: string, pngBase64: string, variant: SkinVariant = 'classic'): void {
  writeFileSync(localSkinPath(accountId), Buffer.from(pngBase64, 'base64'));
  writeFileSync(localSkinMetaPath(accountId), JSON.stringify({ variant }), 'utf8');
  skinMemo.delete(accountId);
}

function clearLocalSkin(accountId: string): void {
  rmSync(localSkinPath(accountId), { force: true });
  rmSync(localSkinMetaPath(accountId), { force: true });
  skinMemo.delete(accountId);
}

/** Arm width of this account's local skin (`classic` when nothing is stored). */
export function getSkinVariant(accountId: string): SkinVariant {
  return readLocalSkinVariant(accountId);
}

/**
 * The local skin PNG plus its arm width, ready to be served to the game.
 *
 * Returns null when the account has no local skin, so the launcher can skip the
 * whole skin-server path.
 */
export function getLocalSkinForLaunch(
  accountId: string,
): { png: Buffer; variant: SkinVariant } | null {
  const path = localSkinPath(accountId);
  if (!existsSync(path)) return null;
  try {
    const png = readFileSync(path);
    if (png.length === 0) return null;
    return { png, variant: readLocalSkinVariant(accountId) };
  } catch {
    return null;
  }
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
 * LittleSkin accounts skip the local skin entirely — their skin is owned by
 * LittleSkin and edited on the website, so the online copy always wins there.
 * `force` bypasses the in-memory and TTL caches (the "refresh preview" action); in that
 * mode a failed download is reported as an error instead of silently reusing stale data.
 */
export async function getSkin(accountId: string, force = false): Promise<string> {
  const account = getSettings().accounts.find((a) => a.id === accountId);

  // 1. A user-chosen local skin is authoritative — except for LittleSkin accounts.
  //    There the skin lives on LittleSkin's server and is changed in the website
  //    closet, so a leftover local file would mask the account's real skin.
  if (account?.type !== 'littleskin') {
    const local = readLocalSkin(accountId);
    if (local) {
      skinMemo.set(accountId, local);
      return local;
    }
  }

  // 2. In-memory memo (sub-millisecond).
  if (!force) {
    const memo = skinMemo.get(accountId);
    if (memo) return memo;
  }

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

/**
 * Save a user-picked PNG as the account's local skin.
 *
 * For offline accounts this is not merely a launcher preview: the launcher serves
 * it to the game through a loopback Yggdrasil server, so an unsupported size would
 * be silently ignored by the client and the player would still see Steve. Rejecting
 * here keeps every write path honest — this is the single choke point for local
 * skins, so the UI cannot bypass it.
 */
export function setLocalSkin(accountId: string, pngBase64: string, variant?: SkinVariant): void {
  const buf = Buffer.from(pngBase64, 'base64');
  assertUploadableSkin(buf);
  saveLocalSkin(accountId, pngBase64, variant);
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
  // Carry the arm width over too: a slim premium skin rendered with classic arms
  // looks visibly wrong, and the game cannot infer it from the PNG.
  saveLocalSkin(accountId, b64, result.slim ? 'slim' : 'classic');
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
 * Read a PNG's pixel dimensions from its IHDR chunk (offsets 16..23).
 * Returns null when the buffer is not a PNG.
 */
export function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Mojang's skin API only accepts the two canonical sizes: 64x64 (modern) and
 * 64x32 (legacy). Higher-resolution "HD" skins (128x128 is common in the team
 * library) are rejected by the server, so catch them locally and explain why
 * instead of surfacing a raw API error.
 */
export function isUploadableSkinSize(buf: Buffer): boolean {
  const d = pngDimensions(buf);
  if (!d) return false;
  return d.width === 64 && (d.height === 64 || d.height === 32);
}

/**
 * Explanation for a skin the client cannot render, or null when the size is fine.
 *
 * The same restriction covers both paths: a Microsoft upload is rejected by the
 * API, and an offline account's skin is served straight to the client, which then
 * fails to map the texture grid and falls back to Steve. Saying "can't upload"
 * would undersell it, so the message covers both.
 */
export function skinSizeProblem(buf: Buffer): string | null {
  const d = pngDimensions(buf);
  if (!d) return '皮肤文件不是有效的 PNG';
  if (d.width === 64 && (d.height === 64 || d.height === 32)) return null;
  return (
    `Minecraft 客户端只接受 64×64 或 64×32 的皮肤，这款是 ${d.width}×${d.height}，` +
    `无法上传到正版账号，也无法用于离线启动。`
  );
}

/** Throwing variant of `skinSizeProblem`, with a user-facing message. */
export function assertUploadableSkin(buf: Buffer): void {
  const problem = skinSizeProblem(buf);
  if (problem) throw new Error(problem);
}

/**
 * Upload a skin (PNG) for a Microsoft account.
 * `pngBase64` is the raw PNG bytes base64-encoded.
 */
export async function uploadSkin(accountId: string, variant: SkinVariant, pngBase64: string): Promise<void> {
  const buf = Buffer.from(pngBase64, 'base64');
  // Validate the size before touching the network: an unsupported resolution would
  // otherwise come back as an opaque server error.
  assertUploadableSkin(buf);
  const token = getMcAccessToken(accountId);
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
  saveLocalSkin(accountId, pngBase64, variant);
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
