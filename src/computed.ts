import { name } from "./config.ts";
import { PROPS } from "./locate.ts";
import type { ComparedResult, RouteResult } from "./report.ts";

/** `--computed`: every rendered element's computed style on both sides, diffed by a stable key. */

/**
 * Selector path -> its opening tag with own text, `PROPS` then `content` computed, and its
 * specified width and height (`auto`, `100%`, `200px`) where the browser says.
 */
export type Snapshot = Record<string, { html: string; styles: string[]; size?: [string, string] }>;

export interface StyleChange {
  /** Selector path from `body`, e.g. `body > div.page > nav.chips > a[href="#blog"]`; `::before` on a pseudo-element. */
  key: string;
  prop: string;
  /** [left, right], as in `ElementDiff.changed`. */
  values: [string, string];
}

export interface ComputedDiff {
  /** Elements whose tag, attributes (asset hashes and generated classes aside) or own text differ, or that one side lacks; 0 is "dom identical". */
  dom: number;
  /** At most `MAX_CHANGES`, inherited repeats of a parent's change dropped. */
  changes: StyleChange[];
  /** Changes past `MAX_CHANGES`, left out of `changes`. */
  truncated: number;
  /** Elements only that side has, outermost only, at most `MAX_UNMATCHED` per side. */
  unmatched: { left: string[]; right: string[] };
}

/** One change, with every route and width it was seen at. */
export interface Finding extends StyleChange {
  at: { url: string; widths: number[] }[];
}

const MAX_CHANGES = 500;
const MAX_UNMATCHED = 20;
const FIELDS = [...PROPS, "content"];

const INHERITED = new Set([
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "white-space",
  "color",
  "visibility",
]);
const DISPLAY = FIELDS.indexOf("display");

const PSEUDO = /::(before|after)$/;
const isPseudo = (key: string) => PSEUDO.test(key);

const parentOf = (key: string) => {
  if (isPseudo(key)) return key.replace(PSEUDO, "");
  const i = key.lastIndexOf(" > ");
  return i >= 0 ? key.slice(0, i) : "";
};

/** Letters and digits alternating at least twice: `3f9a8c1d`, not `banner2024` or `photo`. */
const hashy = (t: string) => (t.match(/\d+|[A-Za-z]+/g)?.length ?? 0) >= 4;

/** In URL attributes, bundler hashes in a file name (`main.3f9a8c1d.png`, `?v=…`) read the same on both sides. */
export const normalizeAssets = (html: string) =>
  // ponytail: hex/base36 hashes between separators; add a framework's build-id path when one shows up
  html.replace(/ (src|href|srcset|poster)="([^"]*)"/g, (_, n: string, v: string) => {
    const u = v
      .replace(
        /([.\-_])([A-Za-z0-9]{8,})(?=(?:[.\-_][A-Za-z0-9]+)*\.[A-Za-z0-9]{2,5}(?:$|[?#\s,]))/g,
        (m, sep: string, t: string) => (hashy(t) ? `${sep}#` : m),
      )
      .replace(/([?&](?:v|ver|version|hash)=)[\w.-]+/g, "$1#");
    return ` ${n}="${u}"`;
  });

/** A page's throw is its text after the first `Error: `, without the stack page.evaluate appends. */
export const pageError = (e: unknown) => {
  const m = String(e instanceof Error ? e.message : e);
  const i = m.indexOf("Error: ");
  return i < 0 ? m : m.slice(i + 7).split("\n")[0]!;
};

/**
 * Drops what a change elsewhere explains: an inherited property's change the parent has too,
 * a width inside a parent whose width changed, a height around a child whose height changed.
 * With the snapshots, a box whose own size is set in px on either side is kept, and a
 * percentage height inside a px-height parent whose height changed is the one that follows.
 */
export function collapseInherited(changes: StyleChange[], snaps: Snapshot[] = []): StyleChange[] {
  const raw = new Set(changes.map((c) => `${c.key}\0${c.prop}\0${c.values.join("\0")}`));
  const wide = new Set(changes.filter((c) => c.prop === "width").map((c) => c.key));
  const tall = new Set(changes.filter((c) => c.prop === "height").map((c) => c.key));
  const spec = (key: string, i: 0 | 1) => snaps.map((s) => s[key]?.size?.[i] ?? "auto");
  const set = (key: string, i: 0 | 1) => spec(key, i).some((v) => v.endsWith("px"));
  // A percentage of an auto height is auto, so only a px-height parent sizes it.
  const follows = (key: string) => {
    const vs = spec(key, 1);
    const p = parentOf(key);
    return tall.has(p) && set(p, 1) && vs.length > 0 && vs.every((v) => v.includes("%"));
  };
  const tallKid = new Set([...tall].filter((k) => !follows(k)).map(parentOf));
  return changes.filter((c) => {
    const p = parentOf(c.key);
    if (INHERITED.has(c.prop)) return !raw.has(`${p}\0${c.prop}\0${c.values.join("\0")}`);
    if (c.prop === "width") return !wide.has(p) || set(c.key, 0);
    if (c.prop === "height") return (!tallKid.has(c.key) || set(c.key, 1)) && !follows(c.key);
    return true;
  });
}

/** `from`'s origin, also protocol-relative, written as `to`'s: in keys, markup and styles. */
function rebase(s: Snapshot, from: string, to: string): Snapshot {
  const [f, t] = [new URL(from), new URL(to)];
  if (f.origin === t.origin || f.origin === "null" || t.origin === "null") return s;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Not `:46110` for `:4611`, nor `localhost.example.com` for `localhost`.
  const re = new RegExp(`(${esc(f.protocol)})?//${esc(f.host)}(?![\\w.:-])`, "g");
  // Origins hold no `"` or `\`, so the JSON text rewrites like the strings it encodes.
  return JSON.parse(
    JSON.stringify(s).replace(re, (_, p?: string) => `${p ? t.protocol : ""}//${t.host}`),
  ) as Snapshot;
}

export function diffSnapshots(
  left: Snapshot,
  right: Snapshot,
  origins?: [string, string],
): ComputedDiff {
  if (origins) left = rebase(left, ...origins);
  const html = (s: Snapshot, k: string) => (s[k] ? normalizeAssets(s[k].html) : null);
  // Under an element `b` has display:none, so `b` never walked it: a style change, not markup.
  const hiddenIn = (b: Snapshot, k: string) => {
    for (let p = parentOf(k); p; p = parentOf(p)) {
      const e = b[p];
      if (e) return e.styles[DISPLAY] === "none";
    }
    return false;
  };
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let dom = 0;
  for (const k of keys) {
    if (isPseudo(k) || html(left, k) === html(right, k)) continue;
    if (!left[k] && hiddenIn(left, k)) continue;
    if (!right[k] && hiddenIn(right, k)) continue;
    dom++;
  }

  const changes: StyleChange[] = [];
  const content = FIELDS.length - 1;
  for (const key of keys) {
    const [l, r] = [left[key], right[key]];
    if (l && r) {
      // Styles of a box that isn't rendered are noise beside the display change itself.
      const shown = [l, r].filter((x) => x.styles[DISPLAY] !== "none").length;
      if (shown === 1) {
        changes.push({ key, prop: "display", values: [l.styles[DISPLAY]!, r.styles[DISPLAY]!] });
        continue;
      }
      FIELDS.forEach((prop, i) => {
        if (l.styles[i] !== r.styles[i])
          changes.push({ key, prop, values: [l.styles[i]!, r.styles[i]!] });
      });
    } else if (
      isPseudo(key) &&
      [left, right].every((s) => s[parentOf(key)] && s[parentOf(key)]!.styles[DISPLAY] !== "none")
    ) {
      // A pseudo-element one side no longer generates: the removed rule's own finding.
      changes.push({
        key,
        prop: "content",
        values: [l?.styles[content] ?? "none", r?.styles[content] ?? "none"],
      });
    }
  }

  const only = (a: Snapshot, b: Snapshot) => {
    const ks = Object.keys(a).filter((k) => !isPseudo(k) && !b[k] && !hiddenIn(b, k));
    const set = new Set(ks);
    return ks.filter((k) => !set.has(parentOf(k))).slice(0, MAX_UNMATCHED);
  };
  const kept = collapseInherited(changes, [left, right]);
  return {
    dom,
    changes: kept.slice(0, MAX_CHANGES),
    truncated: Math.max(0, kept.length - MAX_CHANGES),
    unmatched: { left: only(left, right), right: only(right, left) },
  };
}

const computedOf = (rs: RouteResult[]) =>
  rs.filter((r): r is ComparedResult => r.status === "compared" && !!r.computed);

/** Every change across routes and widths, one per (key, property, values), most widespread first. */
export function groupFindings(results: RouteResult[]): Finding[] {
  const out = new Map<string, Finding>();
  for (const r of computedOf(results)) {
    for (const c of r.computed!.changes) {
      const id = `${c.key}\0${c.prop}\0${c.values.join("\0")}`;
      const f = out.get(id) ?? { ...c, at: [] };
      out.set(id, f);
      const url = name(r);
      const at = f.at.find((a) => a.url === url);
      if (at) at.widths.push(r.width);
      else f.at.push({ url, widths: [r.width] });
    }
  }
  const shots = (f: Finding) => f.at.reduce((n, a) => n + a.widths.length, 0);
  return [...out.values()].sort((a, b) => shots(b) - shots(a) || a.key.localeCompare(b.key));
}

/** Findings shown in the console summary; results.json has them all. */
export const SHOWN = 20;
export const AT_ROUTES = 3;
/** Unmatched routes, and keys per route, in the console summary. */
const UNMATCHED_SHOWN = 5;

/** The console block: dom per route, then one line per finding, `left→right` like `dom`. */
export function fmtComputed(results: RouteResult[], routes: string[]): string[] {
  const rows = results.filter(
    (r): r is ComparedResult => r.status === "compared" && "computed" in r,
  );
  if (!rows.length) return [];
  const findings = groupFindings(results);
  const differs: string[] = [];
  const failed: string[] = [];
  let identical = 0;
  for (const route of routes) {
    const rs = rows.filter((r) => name(r) === route);
    if (!rs.length) continue;
    const bad = rs.find((r) => !r.computed);
    if (bad) failed.push(`${route}@${bad.width} (${bad.computedError ?? "unknown"})`);
    const dom = Math.max(...rs.map((r) => r.computed?.dom ?? 0));
    if (dom) differs.push(`${route} (${dom})`);
    else if (rs.some((r) => r.computed)) identical++;
  }
  const out = [
    `computed: ${findings.length} finding${findings.length === 1 ? "" : "s"}; ` +
      `dom identical on ${identical} of ${identical + differs.length} route(s)` +
      (differs.length ? `, differs ${differs.join(" ")}, so findings there are hints` : "") +
      (failed.length ? `; snapshot failed on ${failed.join(" ")}` : ""),
  ];
  for (const f of findings.slice(0, SHOWN)) {
    const at = f.at
      .slice(0, AT_ROUTES)
      .map((a) => `${a.url}@${a.widths.join(",")}`)
      .join(" ");
    const more = f.at.length > AT_ROUTES ? ` +${f.at.length - AT_ROUTES} routes` : "";
    out.push(`  ${f.key} ${f.prop} ${f.values.join("→")}  ${at}${more}`);
  }
  if (findings.length > SHOWN) out.push(`  (+${findings.length - SHOWN} more in results.json)`);
  const cut = computedOf(rows).filter((r) => r.computed!.truncated);
  if (cut.length)
    out.push(
      `  truncated: only the first ${MAX_CHANGES} changes kept on ` +
        cut.map((r) => `${name(r)}@${r.width} (+${r.computed!.truncated})`).join(" "),
    );
  const unmatched = routes.flatMap((route) => {
    const r = computedOf(rows).find((x) => name(x) === route && x.computed!.dom);
    if (!r) return [];
    const { left, right } = r.computed!.unmatched;
    const keys = [...left.map((k) => `+${k}`), ...right.map((k) => `-${k}`)];
    if (!keys.length) return [];
    const more = keys.length > UNMATCHED_SHOWN ? ` (+${keys.length - UNMATCHED_SHOWN} more)` : "";
    return [`  unmatched ${route}@${r.width} ${keys.slice(0, UNMATCHED_SHOWN).join(" ")}${more}`];
  });
  out.push(...unmatched.slice(0, UNMATCHED_SHOWN));
  if (unmatched.length > UNMATCHED_SHOWN)
    out.push(`  (+${unmatched.length - UNMATCHED_SHOWN} more routes with unmatched elements)`);
  return out;
}
