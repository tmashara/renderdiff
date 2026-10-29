# Accepted differences and reruns

A migration starts with differences that already exist between the untouched local build
and production. Record them once, then change code and re-check only what's red:

```
renderdiff http://localhost:3000 https://example.com / /about --accept "differs before the migration"
# …change code…
renderdiff http://localhost:3000 https://example.com / /about --rerun-failed
```

`--accept "<reason>"` runs as usual, then writes every difference it saw that isn't accepted
yet to `renderdiff.accepted.json`, next to the config file (or in cwd without one), each with
the reason. Scope it the way you scope any run: pass only the routes and `--width`s to accept.
Commit the file; it is one entry per line, so its diff reads as what was accepted.

A shot whose every difference matches an accepted one is `accepted`: it is listed on an
`accepted:` line like `clean:`, doesn't count as differing or toward the exit code, and has
`"accepted": true` in `results.json` and a badge in the report. Anything else on the page
still shows: a row with some changes accepted says `1 accepted`, and its `dom` line skips
them. A shot with unstable pixels is never accepted, since part of it went unmeasured.
`summary.mean` and `summary.worst` leave accepted shots out, like the verdict line.
Accepted entries for a route and width the run measured but didn't see are **stale**: they
print on a `stale accepted:` line, sit in `summary.stale` and the report, and the next
`--accept` over that route and width prunes them.

Each entry is one change, a band or a region, keyed by route (as the summary names it) and
width, with a fingerprint. Two changes match when they have the same kind and side, the same
`x`, width and height (regions sit on the 16px grid, bands are exact rows), the same hash of
every pixel under the change on both sides at 4 bits a channel, and, when the entry named
elements, the same `dom` elements with the same changed values. That makes a match:

- robust to a change above it moving it down the page (`y` is left out), to unrelated
  changes elsewhere (they are their own changes, and stay unaccepted), and to shade jitter
  that stays within one of sixteen steps per channel;
- strict about the spot itself: any other change to what is drawn there, a change touching
  it (the region grows), or a second identical change (an entry matches once) all surface.

The cost is false alarms rather than hidden changes. Noise that crosses a 4-bit step, an
element probe that times out, or a new change that makes repeated identical rows align
differently (turning an accepted region into bands) makes an accepted change show again;
accept it again once you've looked. What can still hide is a shade change under one step
(e.g. `#000` to `#080808`) that doesn't cross a step boundary anywhere in the change.

Accept on the platform that checks. The pixel hash is not portable: macOS and Linux render
the same page with different fonts and anti-aliasing, so entries accepted on a Mac mostly come
back stale on a Linux CI runner. For CI, accept in CI ([github-action.md](github-action.md)).
The same goes for renderdiff upgrades that change what counts as a changed pixel (0.3.2
lowered the threshold): accepted regions can come back with a new box, so re-accept once
you've looked.

A shot whose pages differ in width, or in height without the rows aligning into bands, is
never accepted: the padding past the shorter page belongs to no band or region, so no
fingerprint covers it.

`--rerun-failed` reads `results.json` in `--out`, keeps every shot that was clean or is
accepted (against the accepted file as it is now), reruns the rest — differences, unstable
shots, errors — and merges them back into `results.json` and `report.html` in route and width
order. The out dir is kept rather than wiped; only a rerun shot's own old files are replaced.
A `rerun:` line says how many shots it reran on how many routes, and how many it reused.
`meta` describes the rerun (its clock, browser and time); a reused shot was taken under the
earlier run's. It must repeat the previous run: different origins, routes, widths, config
(`meta.config` hashes masks, `before` hooks and `locate` sources, hidden selectors, block
patterns, extra CSS and storage state file names) or renderdiff version exit 2, as does a
missing `results.json`.
