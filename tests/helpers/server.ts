/**
 * The fixture site: two origins serving the same routes, one per side.
 *
 * vdiff compares `left + route` against `right + route`, so the corpus is modelled as two
 * origins over one directory tree — `pages/<route>/left.html` and `pages/<route>/right.html`.
 * Each server closes over its own side, so the same path yields different markup per origin,
 * which is exactly the situation the tool exists to measure.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "fixtures");
export const PAGES_DIR = path.join(FIXTURES, "pages");
const SHARED_DIR = path.join(FIXTURES, "shared");

export type Side = "left" | "right";

/**
 * Images are served slowly on purpose. `capture()` scrolls the page to trigger lazy
 * loading and then settles; with instant responses that scroll would be untestable
 * because the images would already be there.
 */
const IMG_DELAY_MS = 150;

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
};

/** `/` -> `home`, `/flex-vs-grid` -> `flex-vs-grid`. Rejects anything with a separator. */
function routeToDir(pathname: string): string | null {
  const name = pathname === "/" ? "home" : pathname.replace(/^\/+/, "");
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  return path.join(PAGES_DIR, name);
}

/**
 * A route is either a pair of static files or, when the markup is impractical to write by
 * hand, a `page.ts` exporting `left()` / `right()`. Static files win.
 */
async function pageHtml(pathname: string, side: Side): Promise<string | null> {
  const dir = routeToDir(pathname);
  if (!dir) return null;

  const stat = path.join(dir, `${side}.html`);
  if (fs.existsSync(stat)) return fs.readFileSync(stat, "utf8");

  const gen = path.join(dir, "page.ts");
  if (fs.existsSync(gen)) {
    const mod = (await import(pathToFileURL(gen).href)) as Record<
      string,
      () => string
    >;
    const fn = mod[side];
    if (typeof fn !== "function") {
      throw new Error(`${gen} does not export ${side}()`);
    }
    return fn();
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serve a file from `fixtures/shared/`. Path-traversal guarded — it is still a server. */
async function sharedFile(
  pathname: string,
): Promise<{ body: Buffer; type: string } | null> {
  const rel = pathname.slice("/shared/".length);
  const file = path.resolve(SHARED_DIR, rel);
  if (!file.startsWith(SHARED_DIR + path.sep) || !fs.existsSync(file)) {
    return null;
  }
  if (rel.startsWith("img/")) await sleep(IMG_DELAY_MS);
  return {
    body: fs.readFileSync(file),
    type: CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
  };
}

function handler(side: Side): http.RequestListener {
  return (req, res) => {
    void (async () => {
      // `preflight()` in src/cli.ts HEADs the origin root and refuses to start unless it
      // answers, so HEAD has to be a first-class method here.
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://x").pathname;

      const send = (status: number, type: string, body: Buffer | string) => {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
        res.writeHead(status, {
          "content-type": type,
          "content-length": buf.byteLength,
          // Two captures of the same URL seconds apart must not be served from cache —
          // the drifting-counter fixture depends on a genuine reload.
          "cache-control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : buf);
      };

      try {
        if (pathname.startsWith("/shared/")) {
          const asset = await sharedFile(pathname);
          if (!asset) return send(404, "text/plain", "not found");
          return send(200, asset.type, asset.body);
        }

        const html = await pageHtml(pathname, side);
        if (html === null) return send(404, "text/html; charset=utf-8", "no such route");
        return send(200, "text/html; charset=utf-8", html);
      } catch (e) {
        send(500, "text/plain", e instanceof Error ? e.stack ?? e.message : String(e));
      }
    })();
  };
}

export interface FixtureSite {
  /** Origin for the left side, e.g. `http://127.0.0.1:51234`. No trailing slash. */
  left: string;
  right: string;
  close(): Promise<void>;
}

async function listen(side: Side): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler(side));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return { server, origin: `http://127.0.0.1:${addr.port}` };
}

/** Start both origins on ephemeral ports. Always `close()` in an `after` hook. */
export async function startFixtureSite(): Promise<FixtureSite> {
  const [l, r] = await Promise.all([listen("left"), listen("right")]);
  return {
    left: l.origin,
    right: r.origin,
    close: async () => {
      await Promise.all(
        [l.server, r.server].map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections();
              s.close(() => resolve());
            }),
        ),
      );
    },
  };
}

/** Every route directory in the corpus. Used by the fixture lint. */
export function listRoutes(): string[] {
  return fs
    .readdirSync(PAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Directory name -> the URL path vdiff should be given for it. */
export const routePath = (dir: string) => (dir === "home" ? "/" : `/${dir}`);
