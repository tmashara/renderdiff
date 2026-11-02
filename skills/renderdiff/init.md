# renderdiff init

Writes a `renderdiff-<project>` skill: what this skill can't know about the repo (build, serve,
routes, states, noise), nothing it already says. § names are sections of
[reference.md](reference.md).

```
renderdiff-<project>/
  SKILL.md                     the skeleton below
  <app>/renderdiff.config.mjs  every setting: built-in options, masks with reason, hooks; the why in comments
  <app>/routes.txt             grouped, a comment per group, # skipped with the reason
  <app>/serve.json             the host's URL rules, for `npx serve`
  scripts/                     only what the CLI and `npx serve` don't cover
```

Settings live in the config, not the SKILL.md: renderdiff rejects unknown config keys, so
drift fails loudly instead of being followed from stale prose.

## Ask (only these)

- **Where the skill lives:** in the repo (`.claude/skills/`, seen by the team and in every
  worktree) or local (`~/.claude/skills/`). Not an untracked folder kept out by
  `.git/info/exclude`: worktrees don't get it, and runs happen in worktrees.
- **Which apps**, if the repo has several.
- **Whether and where to publish reports**: they show every page; a public reports repo leaks
  private ones.
- **The reference**, only if the base can't be built locally.
- Missing secrets or CMS data the build needs.

Don't ask what to serve with (the curl check decides) or about `data-renderdiff-mask` in the
source (product edits for a test).

## Steps

1. **Build.** Take the command from the real deploy (CI workflow, `vercel.json`
   `buildCommand`, `netlify.toml`, env like `DEPLOY_ENV`), not from `package.json` alone.
   Build the base in a `git worktree` and record the command that worked and its output dir.
2. **Serve.** `npx serve -l <port> -c <absolute path to <app>/serve.json> <dist>` (`-c` is
   read against `<dist>`), the `serve.json` mirroring the host's clean URLs, trailing slashes
   and redirects (§ Reference and routes). Curl a sample of routes against both and compare
   status and final URL with the hosting rules; a script only if `serve` can't match them.
   One port per side plus a second base port, per app. Stop with
   `kill $(lsof -tiTCP:<port> -sTCP:LISTEN)`: `$!` is npx, not the server. Never `pkill`:
   other runs share the machine.
3. **Routes.** The sitemap, plus built `*.html` it misses (404, thank-you, noindex), minus
   `http-equiv="refresh"` stubs. Collections: one page per template. A skipped route is its
   own line starting with `#`; a `# reason` after a path is read as part of the route.
4. **States**, from the source: menus, hamburger, tabs, tooltips, search, version selectors.
   A plain path with `?state=<name>` (no pair, no `@sel`), mapped to a hook in the config
   (below). The hook clicks with no `isVisible()` guard and ends waiting for the open state
   (§ Scoping); a state that exists only at some widths returns early on the hook's `width`.
   A mask for a state route needs its full path, query included, or no `urlPath`.
   One component: `'/path @sel'`.
5. **Base vs base** on a sample (one page per template, every state): a list file for
   `--only`, so hooks apply (routes on the command line replace the config's). The run finds
   the noise (`varies` lines, `renderdiff probe`; `probe` runs only the top-level `before`,
   so a state URL is probed closed), not a read of the source. Per noise, the first that
   holds: a built-in (`maskMedia`, `freezeVideo`, `lottieFrame`, `hideSelectors`,
   `blockUrlPatterns`), a hook that removes the cause on both sides, a mask with a `reason`
   (§ Masks, accepts and thresholds). A page past the area ceiling (§ Errors): `@sel` on its
   main element, else `# skipped`. Repeat until clean; time it and estimate the full run.
6. **Write the project skill** (skeleton below). Record `renderdiff --version`.
7. **Feedback**: ask whether to add the section below. No: leave it out.
8. **Check** each app with `--config renderdiff.config.mjs --dry-run` (every route read as
   meant), then the sample's base-vs-base run from the written skill's own commands.
9. **Report**: what was created, what base vs base checked and on which sample, what not.

```js
import { readFileSync } from "node:fs";
const states = {
  menu: async (page, { width }) => {
    if (width < 1024) return;
    await page.locator("#menu-button").click();
    await page.locator("#menu[data-open]").waitFor({ timeout: 5_000 });
  },
};
const routes = readFileSync(new URL("./routes.txt", import.meta.url), "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  .map((r) => {
    const state = new URL(r, "http://x").searchParams.get("state");
    if (state && !states[state]) throw new Error(`routes.txt: no hook for state=${state}`);
    return state ? { left: r, before: states[state] } : r;
  });
export default {
  left: "http://localhost:4011",
  right: "http://localhost:4010",
  routes,
  outDir: "/tmp/renderdiff-<project>-<app>",
};
```

## Project SKILL.md skeleton

The description names the project, so it never competes with `renderdiff`. It retells neither
the loop (modes, reading order, verdict) nor flags: link the § instead.

```markdown
---
name: renderdiff-<project>
description: <project> specifics for renderdiff runs (<apps>). Use with the `renderdiff` skill when a change to <project> should not change how its pages look.
---

# renderdiff on <project>

Load the `renderdiff` skill first and follow its loop, its Feedback included; this adds only
what is specific here. Written for renderdiff <version>. Settings: `<app>/renderdiff.config.mjs`.

## Build
<per app: command from the deploy, output dir, worktree notes, secrets>

## Serve
<command; table: app | change (left) | base (right) | second base; stop by port>

## Routes
<how routes.txt was made (sitemap + unlisted html − stubs, one page per template), to redo
when the site changes>

## Run
<per app: the command from <app>/, in the background; base vs base against the second base
port; shots and minutes for a full run>

## Ignore
<leftover noise that isn't masked, and why; mask reasons live in the configs>

## Cleanup
<stop servers by port; git worktree remove>

## Publish
<only if asked: where, how to shrink, privacy>
```

## Feedback section (with consent)

Added to the project skill as written:

```markdown
## Feedback

At the end of a run, before the final report, only if something cost time or was wrong:
propose one set of edits to this skill as a diff, and apply it only once the user approves.
Replace and delete, not only append; keep SKILL.md under ~150 lines. A new mask or hook goes
in only after a base-vs-base rerun (`--only` the affected routes) is clean. renderdiff newer
than the version above: propose removing what it now does built in. A workaround for a
renderdiff bug links its issue, so it can go once that's fixed.
```
