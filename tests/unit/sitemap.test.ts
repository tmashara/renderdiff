/**
 * `--sitemap`: routes read from the right side's sitemap.
 *
 * All through `--dry-run`, so no browser; the sitemaps come from a local HTTP server that
 * stands in for the right origin. Left is never fetched.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { cleanupTempDirs, runCli, tempDir } from "../helpers/cli.ts";

const L = "http://left.test";
let R = "";
let pages: Record<string, { body: string; type?: string; status?: number }> = {};

const server = http.createServer((req, res) => {
  const page = pages[req.url ?? ""];
  res.writeHead(page?.status ?? (page ? 200 : 404), {
    "content-type": page?.type ?? "application/xml",
  });
  res.end(page?.body ?? "not found");
});

before(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  R = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  cleanupTempDirs();
});
beforeEach(() => {
  pages = {};
});

const urlset = (...locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  locs.map((l) => `  <url><loc>${l}</loc></url>\n`).join("") +
  `</urlset>\n`;

const dry = (extra: string[], cwd?: string) =>
  runCli(["--dry-run", "--left", L, "--right", R, ...extra], { noOut: true, cwd });

/** The route labels a dry run listed, in order. */
const listed = (stdout: string) =>
  stdout
    .split("\n")
    .filter((l) => l.startsWith("  "))
    .map((l) => l.trim().split(/\s+/)[0]);

async function rejects(extra: string[], needle: string) {
  const r = await dry(extra);
  assert.equal(r.code, 2, `expected exit 2\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.stderr.includes(needle), `stderr lacks "${needle}":\n${r.stderr}`);
}

describe("--sitemap", () => {
  test("reads <right>/sitemap.xml: paths on right whatever the host, deduped, files dropped", async () => {
    pages["/sitemap.xml"] = {
      body: urlset(
        "https://example.com/",
        "https://example.com/about",
        "https://example.com/about/",
        "https://example.com/doc.pdf",
        "<![CDATA[https://example.com/blog/a?x=1&y=2]]>",
      ),
    };
    const r = await dry(["--sitemap"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(listed(r.stdout), ["/", "/about", "/blog/a?x=1&y=2"]);
    assert.ok(r.stdout.includes(`Sitemap: ${R}/sitemap.xml: 3 routes, 1 files dropped`), r.stdout);
    assert.ok(r.stdout.includes(`${R}/about`), r.stdout);
  });

  test("decodes XML entities in a <loc> and trims the whitespace around it", async () => {
    pages["/sitemap.xml"] = { body: urlset("\n    https://example.com/s?a=1&amp;b=2\n  ") };
    const r = await dry(["--sitemap"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(listed(r.stdout), ["/s?a=1&b=2"]);
  });

  test("follows a sitemap index one level, fetching each child from right", async () => {
    pages["/sitemap.xml"] = {
      body:
        `<?xml version="1.0"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `<sitemap><loc>https://example.com/sitemap-0.xml</loc></sitemap>\n</sitemapindex>\n`,
    };
    pages["/sitemap-0.xml"] = { body: urlset("https://example.com/x", "https://example.com/y") };
    const r = await dry(["--sitemap"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(listed(r.stdout), ["/x", "/y"]);
  });

  test("--sitemap=<path> resolves against right", async () => {
    pages["/custom.xml"] = { body: urlset("/c") };
    const r = await dry(["--sitemap=/custom.xml"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(listed(r.stdout), ["/c"]);
  });

  test("explicit routes come first and the sitemap doesn't repeat their paths", async () => {
    pages["/sitemap.xml"] = { body: urlset("/plans", "/contact", "/x") };
    const r = await dry(["/contact", "/pricing::/plans", "--sitemap"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(listed(r.stdout), ["/contact", "/pricing::/plans", "/x"]);
  });

  test("a config route with its own before hook isn't clashed by the sitemap's same path", async () => {
    pages["/sitemap.xml"] = { body: urlset("/a", "/b") };
    const cwd = tempDir("renderdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "renderdiff.config.mjs"),
      'export default { routes: [{ left: "/a", before: async () => {} }] };\n',
    );
    const r = await dry(["--sitemap"], cwd);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(listed(r.stdout), ["/a", "/b"]);
  });

  test("a bare --sitemap before the origins leaves both as origins", async () => {
    pages["/sitemap.xml"] = { body: urlset("/z") };
    const r = await runCli(["--dry-run", "--sitemap", L, R], { noOut: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`${L}/z  |  ${R}/z`), r.stdout);
  });

  test("exit 2 on a sitemap it can't use", async () => {
    await rejects(["--sitemap"], `sitemap: HTTP 404 at ${R}/sitemap.xml`);
    pages["/sitemap.xml"] = { body: "<!doctype html><html></html>", type: "text/html" };
    await rejects(["--sitemap"], "is not a sitemap");
    pages["/sitemap.xml"] = { body: urlset() };
    await rejects(["--sitemap"], "gave no routes");
    pages["/sitemap.xml"] = { body: urlset("/a.pdf", "/b.png") };
    await rejects(["/a", "--sitemap"], "gave no routes");
    await rejects(["--sitemap=http://127.0.0.1:1/sitemap.xml"], "sitemap: could not fetch");
    const r = await dry(["--sitemap="]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--sitemap= needs a URL or path/);
  });
});
