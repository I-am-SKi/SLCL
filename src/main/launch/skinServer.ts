import { createHash } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';

/**
 * A tiny Yggdrasil server that exists so **offline accounts can have skins**.
 *
 * Minecraft has no local skin setting: at startup the client asks its session
 * server for the player's profile, and skins live in the `textures` property of
 * that profile. An offline account has no session server, so the lookup fails and
 * the client falls back to Steve — which is exactly the bug this module fixes.
 *
 * We run a loopback-only HTTP server that answers that lookup, and point
 * authlib-injector at it. authlib-injector is the same agent already shipped for
 * LittleSkin, so no extra download and no mod is required.
 *
 * The two endpoints that matter (authlib-injector Yggdrasil spec):
 *
 *   GET /                                              -> API metadata
 *   GET /sessionserver/session/minecraft/profile/{uuid} -> profile + textures
 *   GET /textures/{sha1}.png                            -> the PNG itself
 *
 * Notes that are easy to get wrong:
 *   - `skinDomains` must whitelist the texture host, otherwise the client rejects
 *     the payload with "Textures payload has been tampered with (non-whitelisted
 *     domain)". A rule without a leading dot matches that host exactly, so
 *     `127.0.0.1` is what we need.
 *   - The profile id is the **offline** UUID (UUID v3 of "OfflinePlayer:<name>"),
 *     because that is the UUID the launcher passes to the game and therefore the
 *     one the client asks about. Answering any other UUID leaves the player on
 *     Steve.
 *   - The launcher must also pass `-Dauthlibinjector.yggdrasil.prefetched=<base64
 *     metadata>`; without it authlib-injector fetches the metadata itself at game
 *     startup, which races the window being shown.
 */

/** Only loopback is served; the port is chosen by the OS. */
const HOST = '127.0.0.1';

export interface LocalSkinSource {
  /** Profile UUID as passed to the game (dashes optional). */
  uuid: string;
  /** Player name, shown by the client and stored in the textures payload. */
  name: string;
  /** Raw PNG bytes of the skin. */
  png: Buffer;
  /** Arm width baked into the textures metadata. */
  variant: 'classic' | 'slim';
}

export interface LocalSkinServer {
  /** API root to hand to authlib-injector, with a trailing slash. */
  apiRoot: string;
  /** Base64 of the API metadata, for `-Dauthlibinjector.yggdrasil.prefetched`. */
  prefetchedMetadata: string;
  /** Stop listening. Safe to call more than once. */
  close(): void;
}

/** Strip dashes — the Yggdrasil profile endpoint uses the unsigned form. */
function undashed(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // authlib-injector and the client both cache aggressively; this data changes
    // as soon as the user picks another skin.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

/**
 * Build the `textures` property value: base64 of the texture document.
 *
 * `metadata.model` is where the arm width lives; omitting it means classic, so it
 * is only written for slim skins.
 */
function texturesProperty(skin: LocalSkinSource, skinUrl: string): string {
  const document = {
    timestamp: Date.now(),
    profileId: undashed(skin.uuid),
    profileName: skin.name,
    textures: {
      SKIN: {
        url: skinUrl,
        ...(skin.variant === 'slim' ? { metadata: { model: 'slim' } } : {}),
      },
    },
  };
  return Buffer.from(JSON.stringify(document), 'utf8').toString('base64');
}

/**
 * API metadata for both `GET /` and `-Dauthlibinjector.yggdrasil.prefetched`.
 *
 * `skinDomains` whitelists the texture host. No `signaturePublickey`: our
 * properties are unsigned, which the client accepts; advertising secure-chat or
 * profile-key support would make the game call endpoints we do not implement.
 */
function apiMetadata(): Record<string, unknown> {
  return {
    skinDomains: [HOST, 'localhost'],
    meta: {
      serverName: 'SLCL 本地皮肤',
      implementationName: 'SLCL',
      implementationVersion: '1',
      feature: {
        non_email_login: false,
        legacy_skin_api: false,
        no_mojang_namespace: true,
        enable_profile_key: false,
      },
    },
  };
}

/**
 * Start the loopback skin server for one account.
 *
 * Resolves once the server is listening, with the API root and prefetched metadata
 * the launcher needs. The caller owns the returned handle and must `close()` it
 * when the game exits.
 */
export async function startLocalSkinServer(skin: LocalSkinSource): Promise<LocalSkinServer> {
  const hash = createHash('sha1').update(skin.png).digest('hex');
  const profileId = undashed(skin.uuid);

  // Filled in once the port is known; every handler reads it lazily.
  let apiRoot = '';

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', apiRoot || `http://${HOST}`);
    const path = url.pathname;

    if (path === '/' || path === '') {
      json(res, 200, apiMetadata());
      return;
    }

    // The lookup that actually decides whether the skin loads. The client sends the
    // unsigned form, but a dashed UUID is accepted too so either style works.
    const profileMatch = /^\/sessionserver\/session\/minecraft\/profile\/([0-9a-f-]+)$/i.exec(path);
    if (profileMatch) {
      if (undashed(profileMatch[1]) !== profileId) {
        // A different profile: answer 204 like a real server does for unknown ids.
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      json(res, 200, {
        id: profileId,
        name: skin.name,
        properties: [
          { name: 'textures', value: texturesProperty(skin, `${apiRoot}textures/${hash}.png`) },
        ],
      });
      return;
    }

    // The PNG. Kept under its content hash so the client's own cache behaves.
    if (path === `/textures/${hash}.png`) {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': skin.png.length,
        'Cache-Control': 'no-store',
      });
      res.end(skin.png);
      return;
    }

    notFound(res);
  };

  const server: Server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    server.once('error', onError);
    server.listen(0, HOST, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  apiRoot = `http://${HOST}:${port}/`;

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      server.close();
    } catch {
      /* already closed */
    }
    // Sockets kept alive by the game would otherwise hold the event loop briefly.
    server.closeAllConnections?.();
  };

  return {
    apiRoot,
    prefetchedMetadata: Buffer.from(JSON.stringify(apiMetadata()), 'utf8').toString('base64'),
    close,
  };
}
