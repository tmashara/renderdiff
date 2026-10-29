import { name } from "./config.ts";
import { PROPS } from "./locate.ts";
import type { ComparedResult, RouteResult } from "./report.ts";

/** `--computed`: every rendered element's computed style on both sides, diffed by a stable key. */

/** Selector path -> its opening tag with own text, and `PROPS` then `content`, computed. */
export type Snapshot = Record<string, { html: string; styles: string[] }>;

export interface StyleChange {
  /** Selector path from `body`, e.g. `body > div.page > nav.chips > a[href="#blog"]`; `::before` on a pseudo-element. */
  key: string;
  prop: string;
  /** [left, right], as in `ElementDiff.changed`. */
  values: [string, string];
}

export interface ComputedDiff {
  /** Elements whose tag, attributes (asset hashes aside) or own text differ; 0 is "dom identical". */
  dom: number;
  /** At most `MAX_CHANGES`, inherited repeats of a parent's change dropped. */
  changes: StyleChange[];
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
/** A box resizing resizes what it holds: only the outermost one is a finding. */
const SIZES = new Set(["width", "height"]);

const parentOf = (key: string) => {
  const p = key.indexOf("::");
  if (p >= 0) return key.slice(0, p);
  const i = key.lastIndexOf(" > ");
  return i >= 0 ? key.slice(0, i) : "";
};

/** In URL attributes, `main.a1b2c3.css`, `app-3f9a8c1d.js`, `?v=1a2b3c` and hex runs read the same on both sides. */
export const normalizeAssets = (html: string) =>
  // ponytail: common bundler hash shapes; add a framework's build-id path when one shows up
  html.replace(/ (src|href|srcset|poster)="([^"]*)"/g, (_, n: string, v: string) => {
    const u = v
      .replace(
        /([.\-_])(?=[A-Za-z]*\d)[A-Za-z0-9]{6,}(?=\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|avif|woff2?)\b)/g,
        "$1#",
      )
      .replace(/([?&](?:v|ver|version|hash)=)[\w.-]+/g, "$1#")
      .replace(/\b[0-9a-f]{8,}\b/g, "#");
    return ` ${n}="${u}"`;
  });

/** Drops an inherited property's change when its parent has the same one, and a size change inside a resized parent. */
export function collapseInherited(changes: StyleChange[]): StyleChange[] {
  const raw = new Set(changes.map((c) => `${c.key}\0${c.prop}\0${c.values.join("\0")}`));
  const sized = new Set(changes.filter((c) => SIZES.has(c.prop)).map((c) => `${c.key}\0${c.prop}`));
  return changes.filter((c) => {
    const p = parentOf(c.key);
    if (!p) return true;
    if (INHERITED.has(c.prop)) return !raw.has(`${p}\0${c.prop}\0${c.values.join("\0")}`);
    if (SIZES.has(c.prop)) return !sized.has(`${p}\0${c.prop}`);
    return true;
  });
}

export function diffSnapshots(left: Snapshot, right: Snapshot): ComputedDiff {
  const lines = (s: Snapshot) => {
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(s)) {
      if (k.includes("::")) continue;
      const line = `${k}\t${normalizeAssets(v.html)}`;
      m.set(line, (m.get(line) ?? 0) + 1);
    }
    return m;
  };
  const [ll, rl] = [lines(left), lines(right)];
  let dom = 0;
  for (const line of new Set([...ll.keys(), ...rl.keys()]))
    dom += Math.abs((ll.get(line) ?? 0) - (rl.get(line) ?? 0));

  const changes: StyleChange[] = [];
  const content = FIELDS.length - 1;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const [l, r] = [left[key], right[key]];
    if (l && r) {
      FIELDS.forEach((prop, i) => {
        if (l.styles[i] !== r.styles[i])
          changes.push({ key, prop, values: [l.styles[i]!, r.styles[i]!] });
      });
    } else if (key.includes("::") && left[parentOf(key)] && right[parentOf(key)]) {
      // A pseudo-element one side no longer generates: the removed rule's own finding.
      changes.push({
        key,
        prop: "content",
        values: [l?.styles[content] ?? "none", r?.styles[content] ?? "none"],
      });
    }
  }

  const only = (a: Snapshot, b: Snapshot) => {
    const keys = Object.keys(a).filter((k) => !k.includes("::") && !b[k]);
    const set = new Set(keys);
    return keys.filter((k) => !set.has(parentOf(k))).slice(0, MAX_UNMATCHED);
  };
  return {
    dom,
    changes: collapseInherited(changes).slice(0, MAX_CHANGES),
    unmatched: { left: only(left, right), right: only(right, left) },
  };
}

const computedOf = (rs: RouteResult[]) =>
  rs.filter((r): r is ComparedResult => r.status === "compared" && !!r.computed && !r.accepted);

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
const SHOWN = 20;
const AT_ROUTES = 3;

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
    if (rs.some((r) => !r.computed)) failed.push(route);
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
  for (const route of routes) {
    const r = computedOf(rows).find((x) => name(x) === route && x.computed!.dom);
    if (!r) continue;
    const { left, right } = r.computed!.unmatched;
    const keys = [...left.map((k) => `+${k}`), ...right.map((k) => `-${k}`)];
    if (keys.length) out.push(`  unmatched ${route}@${r.width} ${keys.join(" ")}`);
  }
  return out;
}
