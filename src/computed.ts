import type { Page } from "playwright";
import { textDiff } from "./compare.ts";
import { name } from "./config.ts";
import { MAX_STATES, SNAP_PROPS } from "./locate.ts";
import type { ComparedResult, RouteResult } from "./report.ts";

/** `--computed`: every rendered element's computed style on both sides, diffed by a stable key. */

/**
 * Selector path -> its opening tag with own text, `SNAP_PROPS` computed, and its
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
  /** Links and controls past `MAX_STATES` on a side, not forced into `:hover`/`:focus-visible`. */
  unchecked?: number;
  /** Style rules only that side has, grouped by stylesheet and enclosing at-rules; absent when not read. */
  rules?: RuleGroup[];
}

export interface RuleGroup {
  side: "left" | "right";
  /** The stylesheet's file name, asset hash read as `#`, or `inline#` and a hash of a `<style>`'s text. */
  sheet: string;
  /** Enclosing at-rules, outermost first: `@media (width >= 60em)`. */
  conditions: string[];
  rules: number;
  /** Elements on that side any of them could style here: every enclosing `@media`/`@supports` holds and the selector matches. */
  elements: number;
}

/** One group across the run: where it matched an element and where it matched none. */
export interface RuleFinding extends Omit<RuleGroup, "elements"> {
  matched: Finding["at"];
  unmatched: Finding["at"];
}

/** One change, with every route and width it was seen at. */
export interface Finding extends StyleChange {
  at: { url: string; widths: number[] }[];
}

export interface AriaDiff {
  /** Lines of Playwright's ARIA snapshot only the left (your change) has, at most `MAX_ARIA_LINES`; both empty: identical. */
  added: string[];
  removed: string[];
  /** Lines past `MAX_ARIA_LINES` on either side, left out. */
  truncated: number;
}

const MAX_CHANGES = 500;
const MAX_ARIA_LINES = 200;
const ARIA_LINES_SHOWN = 10;
const MAX_UNMATCHED = 20;
const FIELDS = SNAP_PROPS;

const INHERITED = new Set([
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "white-space",
  "word-break",
  "overflow-wrap",
  "hyphens",
  "text-wrap-style",
  "color",
  "visibility",
]);
const DISPLAY = FIELDS.indexOf("display");
const POSITION = FIELDS.indexOf("position");
const CLIP = FIELDS.indexOf("clip");
const CLIP_PATH = FIELDS.indexOf("clip-path");

/** Splits on commas outside parentheses. */
const topLevel = (s: string) => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && !depth) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...out, s.slice(start).trim()];
};

const SIDES: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270 };
const FLIP: Record<string, string> = { top: "bottom", bottom: "top", left: "right", right: "left" };

/**
 * One linear gradient layer as `angle, color pos%, …` pointing into [0, 180), so equal
 * gradients written another way compare equal; null when it can't be read exactly.
 */
function canonLinear(layer: string): string | null {
  const m = /^((?:repeating-)?linear-gradient)\((.*)\)$/.exec(layer);
  if (!m) return null;
  const args = topLevel(m[2]!);
  const dir = /^(?:to ([a-z ]+?)|(-?[\d.]+)deg)? ?(in [a-z -]+)?$/.exec(args[0]!);
  if (dir && (dir[1] || dir[2] || dir[3])) args.shift();
  const interp = dir?.[3] ?? "";
  if (/increasing|decreasing/.test(interp)) return null;
  const words = dir?.[1]?.split(" ") ?? [];
  let angle = dir?.[2] ? Number(dir[2]) : words.length === 1 ? SIDES[words[0]!] : 180;
  if (angle === undefined || words.length > 2 || !words.every((w) => w in FLIP)) return null;
  angle = ((angle % 360) + 360) % 360;
  const stops: { color: string; pos?: number }[] = [];
  for (const a of args) {
    const s = /^(.*?)(?: (-?[\d.]+)(%|px))?$/.exec(a)!;
    let bare = s[1]!;
    while (/\([^()]*\)/.test(bare)) bare = bare.replace(/\([^()]*\)/g, "");
    // A colour has no space outside parentheses, so one there is a position we can't flip.
    if (!/[a-z]/i.test(bare) || bare.includes(" ") || s[1]!.includes("calc(")) return null;
    if (s[3] === "px" && Number(s[2]) !== 0) return null;
    stops.push({ color: s[1]!, ...(s[2] === undefined ? {} : { pos: Number(s[2]) }) });
  }
  if (stops.length < 2) return null;
  stops[0]!.pos ??= 0;
  stops.at(-1)!.pos ??= 100;
  let max = -Infinity;
  for (const s of stops) if (s.pos !== undefined) s.pos = max = Math.max(max, s.pos);
  for (let i = 1; i < stops.length; i++) {
    if (stops[i]!.pos !== undefined) continue;
    let j = i;
    while (stops[j]!.pos === undefined) j++;
    const [from, to] = [stops[i - 1]!.pos!, stops[j]!.pos!];
    for (let k = i; k < j; k++) stops[k]!.pos = from + ((to - from) * (k - i + 1)) / (j - i + 1);
  }
  let corner = words.length === 2 ? words : null;
  if (corner ? corner.includes("bottom") : angle >= 180) {
    if (corner) corner = corner.map((w) => FLIP[w]!);
    else angle -= 180;
    stops.reverse();
    for (const s of stops) s.pos = 100 - s.pos!;
  }
  const head = corner ? `to ${corner.join(" ")}` : `${angle}deg`;
  return `${m[1]}(${[head, interp].filter(Boolean).join(" ")}, ${stops.map((s) => `${s.color} ${+s.pos!.toFixed(4)}%`).join(", ")})`;
}

/** Same `background-image` once each linear gradient layer is canonical; other layers as written. */
export const sameImage = (a: string, b: string) => {
  const canon = (v: string) => topLevel(v).map((l) => canonLinear(l) ?? l);
  const [x, y] = [canon(a), canon(b)];
  return x.length === y.length && x.every((l, i) => l === y[i]);
};

/** Paints nothing: a zero-area `clip` rect where clip applies, or a `%` `clip-path: inset()` that meets itself. */
const fullClip = (styles: string[]) => {
  const r = /^rect\((-?[\d.]+)px, (-?[\d.]+)px, (-?[\d.]+)px, (-?[\d.]+)px\)$/
    .exec(styles[CLIP]!)
    ?.slice(1)
    .map(Number);
  if (r && /^(absolute|fixed)$/.test(styles[POSITION]!) && (r[2]! <= r[0]! || r[1]! <= r[3]!))
    return true;
  const ins = /^inset\(([\d.% ]+)\)$/.exec(styles[CLIP_PATH]!)?.[1]!.split(" ");
  if (!ins?.every((v) => v.endsWith("%"))) return false;
  const [t, rt = t, b = t, l = rt] = ins.map(parseFloat) as [number, number?, number?, number?];
  return t + b >= 100 || rt + l >= 100;
};

const PSEUDO = /::(before|after)$/;
const isPseudo = (key: string) => PSEUDO.test(key);
const STATE = /:(hover|focus-visible)(?= > |::|$)/;
const isState = (key: string) => STATE.test(key);

const parentOf = (key: string) => {
  if (isPseudo(key)) return key.replace(PSEUDO, "");
  const i = key.lastIndexOf(" > ");
  return i >= 0 ? key.slice(0, i) : "";
};

/** Letters and digits alternating at least twice: `3f9a8c1d`, not `banner2024` or `photo`. */
const hashy = (t: string) => (t.match(/\d+|[A-Za-z]+/g)?.length ?? 0) >= 4;

/** In URL attributes, bundler hashes in a file name (`main.3f9a8c1d.png`, `?v=…`) read the same on both sides. */
export const normalizeAssets = (html: string) =>
  html.replace(
    / (src|href|srcset|poster)="([^"]*)"/g,
    (_, n: string, v: string) => ` ${n}="${normalizeUrl(v)}"`,
  );

const normalizeUrl = (v: string) =>
  // ponytail: hex/base36 hashes between separators; add a framework's build-id path when one shows up
  v
    .replace(
      /([.\-_])([A-Za-z0-9]{8,})(?=(?:[.\-_][A-Za-z0-9]+)*\.[A-Za-z0-9]{2,5}(?:$|[?#\s,]))/g,
      (m, sep: string, t: string) => (hashy(t) ? `${sep}#` : m),
    )
    .replace(/([?&](?:v|ver|version|hash)=)[\w.-]+/g, "$1#");

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
export function collapseInherited<C extends { key: string; prop: string; values: string[] }>(
  changes: C[],
  snaps: Snapshot[] = [],
): C[] {
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
    // A state only reports what differs from resting.
    if (isState(c.key) && raw.has(`${c.key.replace(STATE, "")}\0${c.prop}\0${c.values.join("\0")}`))
      return false;
    const p = parentOf(c.key);
    if (INHERITED.has(c.prop)) return !raw.has(`${p}\0${c.prop}\0${c.values.join("\0")}`);
    if (c.prop === "width") return !wide.has(p) || set(c.key, 0);
    if (c.prop === "height") return (!tallKid.has(c.key) || set(c.key, 1)) && !follows(c.key);
    return true;
  });
}

/** `from`'s origin, also protocol-relative, written as `to`'s. */
function rebaseText(s: string, from: string, to: string): string {
  const [f, t] = [new URL(from), new URL(to)];
  if (f.origin === t.origin || f.origin === "null" || t.origin === "null") return s;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Not `:46110` for `:4611`, nor `localhost.example.com` for `localhost`.
  const re = new RegExp(`(${esc(f.protocol)})?//${esc(f.host)}(?![\\w.:-])`, "g");
  return s.replace(re, (_, p?: string) => `${p ? t.protocol : ""}//${t.host}`);
}

/** In keys, markup and styles. Origins hold no `"` or `\`, so the JSON text rewrites like the strings it encodes. */
const rebase = (s: Snapshot, from: string, to: string): Snapshot =>
  JSON.parse(rebaseText(JSON.stringify(s), from, to)) as Snapshot;

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
    if (isPseudo(k) || isState(k) || html(left, k) === html(right, k)) continue;
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
      // Skipped here, not later, so a resting change dropped can't hide a state's real one.
      const hidden = fullClip(l.styles) && fullClip(r.styles);
      FIELDS.forEach((prop, i) => {
        const [a, b] = [l.styles[i]!, r.styles[i]!];
        if (a === b) return;
        if (prop === "background-image" && sameImage(a, b)) return;
        if (hidden && (i === CLIP || i === CLIP_PATH)) return;
        changes.push({ key, prop, values: [a, b] });
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
    const ks = Object.keys(a).filter(
      (k) => !isPseudo(k) && !isState(k) && !b[k] && !hiddenIn(b, k),
    );
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

/** A style rule as the page reads it: sheet, enclosing at-rules, selector, declarations, whether its at-rules hold. */
type RuleRow = [string, string[], string, string, boolean];

/**
 * Runs in the page. Every style rule in `document.styleSheets` (renderdiff's own CSS is
 * adopted, so not among them), nesting resolved; an inline sheet is named by a hash of its text.
 */
function sheetRules() {
  const rows: RuleRow[] = [];
  const unreadable: string[] = [];
  const walk = (
    list: CSSRuleList,
    sheet: string,
    conds: string[],
    holds: boolean,
    parent: string | null,
  ) => {
    for (const r of Array.from(list)) {
      if (r instanceof CSSImportRule) {
        if (r.styleSheet) read(r.styleSheet, conds, holds);
      } else if (r instanceof CSSStyleRule || r.constructor.name === "CSSNestedDeclarations") {
        const own = r instanceof CSSStyleRule ? r.selectorText : "&";
        const sel =
          parent === null
            ? own
            : own.includes("&")
              ? own.replaceAll("&", `:is(${parent})`)
              : `:is(${parent}) ${own}`;
        rows.push([sheet, conds, sel, (r as CSSStyleRule).style.cssText, holds]);
        if (r instanceof CSSStyleRule) walk(r.cssRules, sheet, conds, holds, sel);
      } else if (r instanceof CSSGroupingRule) {
        const [at, ok] =
          r instanceof CSSMediaRule
            ? [`@media ${r.conditionText}`, matchMedia(r.conditionText).matches]
            : r instanceof CSSSupportsRule
              ? [`@supports ${r.conditionText}`, CSS.supports(r.conditionText)]
              : [r.cssText.slice(0, r.cssText.indexOf("{")).trim(), true];
        walk(r.cssRules, sheet, [...conds, at], holds && ok, parent);
      }
    }
  };
  const read = (s: CSSStyleSheet, conds: string[], holds: boolean) => {
    if (s.disabled) return;
    let list: CSSRuleList;
    try {
      list = s.cssRules;
    } catch {
      unreadable.push(s.href!);
      return;
    }
    let h = 0x811c9dc5;
    if (!s.href)
      for (const c of s.ownerNode?.textContent ?? "")
        h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
    const m = s.media.mediaText;
    walk(
      list,
      s.href
        ? new URL(s.href).pathname.split("/").pop() || s.href
        : `inline#${(h >>> 0).toString(16).padStart(8, "0").slice(0, 6)}`,
      m ? [...conds, `@media ${m}`] : conds,
      holds && (!m || matchMedia(m).matches),
      null,
    );
  };
  for (const s of Array.from(document.styleSheets)) read(s, [], true);
  return { rows, unreadable };
}

/** Runs in the page: per group, how many elements any of its selectors matches. */
function matching(groups: string[][]) {
  // ponytail: a state or pseudo-element read as any element, and @container as holding, lean to "matched"
  const STRIP =
    /::?(?:before|after|first-line|first-letter|placeholder|marker|selection|backdrop|file-selector-button|-[\w-]+)|:(?:hover|focus|focus-visible|focus-within|active|visited)(?![\w-])/g;
  const find = (sel: string) => {
    for (const s of [sel.replace(STRIP, ":where(*)"), sel]) {
      try {
        return document.querySelectorAll(s);
      } catch {}
    }
    return [];
  };
  return groups.map((sels) => {
    const els = new Set<Element>();
    for (const sel of sels) find(sel).forEach((e) => els.add(e));
    return els.size;
  });
}

/** A row compared across sides: the left origin read as the right's, asset hashes in `url()` as `#`. */
const ruleKey = ([, conds, sel, css]: RuleRow, origins?: [string, string]) => {
  const k = `${conds.join(" ")}\0${sel}\0${css}`;
  return (origins ? rebaseText(k, ...origins) : k).replace(
    /url\("([^"]*)"\)/g,
    (_, u: string) => `url("${normalizeUrl(u)}")`,
  );
};

/** Indices of `a`'s keys with no copy left in `b`. */
function oneSided(a: string[], b: string[]): number[] {
  const rest = new Map<string, number>();
  for (const k of b) rest.set(k, (rest.get(k) ?? 0) + 1);
  return a.flatMap((k, i) => {
    const n = rest.get(k) ?? 0;
    rest.set(k, n - 1);
    return n > 0 ? [] : [i];
  });
}

/** `--computed`'s rule coverage: the style rules only one side has, and what each side's could style. */
export async function ruleCoverage(
  pages: [Page, Page],
  origins: [string, string],
): Promise<{ rules: RuleGroup[]; unreadable: [string[], string[]] }> {
  const read = await Promise.all(pages.map((p) => p.evaluate(sheetRules)));
  const keys = [
    read[0]!.rows.map((r) => ruleKey(r, origins)),
    read[1]!.rows.map((r) => ruleKey(r)),
  ];
  const rules = await Promise.all(
    [oneSided(keys[0]!, keys[1]!), oneSided(keys[1]!, keys[0]!)].map(async (kept, i) => {
      const groups = new Map<string, RuleGroup & { sels: string[] }>();
      for (const [sheet, conditions, sel, , holds] of kept.map((k) => read[i]!.rows[k]!)) {
        const id = JSON.stringify([sheet, conditions]);
        const g = groups.get(id) ?? {
          side: i ? ("right" as const) : ("left" as const),
          sheet: normalizeUrl(sheet),
          conditions,
          rules: 0,
          elements: 0,
          sels: [],
        };
        groups.set(id, g);
        g.rules++;
        if (holds) g.sels.push(sel);
      }
      const gs = [...groups.values()];
      const counts = gs.length
        ? await pages[i]!.evaluate(
            matching,
            gs.map((g) => g.sels),
          )
        : [];
      return gs.map(({ sels, ...g }, j) => ({ ...g, elements: counts[j]! }));
    }),
  );
  return {
    rules: rules.flat(),
    unreadable: [read[0]!.unreadable.map(normalizeUrl), read[1]!.unreadable.map(normalizeUrl)],
  };
}

const computedOf = (rs: RouteResult[]) =>
  rs.filter((r): r is ComparedResult => r.status === "compared" && !!r.computed);

export function addAt(at: Finding["at"], r: RouteResult) {
  const url = name(r);
  const seen = at.find((a) => a.url === url);
  if (seen) seen.widths.push(r.width);
  else at.push({ url, widths: [r.width] });
}

/** Every change across routes and widths, one per (key, property, values), most widespread first. */
export function groupFindings(results: RouteResult[]): Finding[] {
  const out = new Map<string, Finding>();
  for (const r of computedOf(results)) {
    for (const c of r.computed!.changes) {
      const id = `${c.key}\0${c.prop}\0${c.values.join("\0")}`;
      const f = out.get(id) ?? { ...c, at: [] };
      out.set(id, f);
      addAt(f.at, r);
    }
  }
  const shots = (f: Finding) => f.at.reduce((n, a) => n + a.widths.length, 0);
  return [...out.values()].sort((a, b) => shots(b) - shots(a) || a.key.localeCompare(b.key));
}

/** Each one-sided rule group once, never matched first, then matched on some shots only. */
export function groupRules(results: RouteResult[]): RuleFinding[] {
  const out = new Map<string, RuleFinding>();
  for (const r of computedOf(results)) {
    for (const { elements, ...g } of r.computed!.rules ?? []) {
      const id = JSON.stringify([g.side, g.sheet, g.conditions]);
      const f = out.get(id) ?? { ...g, matched: [], unmatched: [] };
      f.rules = Math.max(f.rules, g.rules);
      out.set(id, f);
      addAt(elements ? f.matched : f.unmatched, r);
    }
  }
  const rank = (f: RuleFinding) => (!f.matched.length ? 0 : f.unmatched.length ? 1 : 2);
  return [...out.values()].sort((a, b) => rank(a) - rank(b));
}

const fmtGroup = (f: RuleFinding) =>
  `${f.side === "left" ? "+" : "-"}${[f.sheet, ...f.conditions].join(" ")} (${f.rules} rule${f.rules === 1 ? "" : "s"})`;

/** The `rules:` block: groups that matched nothing, or matched on some shots only, with where. */
function fmtRules(rows: ComparedResult[]): string[] {
  if (!rows.some((r) => r.computed?.rules)) return [];
  const all = groupRules(rows);
  if (!all.length) return ["rules: no style rule differs between the sides"];
  const never = all.filter((f) => !f.matched.length);
  const some = all.filter((f) => f.matched.length && f.unmatched.length);
  const out = [
    `rules: ${all.length} changed group${all.length === 1 ? "" : "s"}` +
      (never.length || some.length
        ? `, ${never.length} never matched, ${some.length} matched on some shots`
        : ", all matched"),
    ...never.map((f) => `  ${fmtGroup(f)}  matched nothing: ${fmtAt(f.unmatched)}`),
    ...some.map(
      (f) => `  ${fmtGroup(f)}  matched ${fmtAt(f.matched)}; nothing ${fmtAt(f.unmatched)}`,
    ),
  ];
  const shown = out.slice(0, SHOWN + 1);
  if (out.length > shown.length)
    shown.push(`  (+${out.length - shown.length} more in results.json)`);
  return shown;
}

/** Findings shown in the console summary; results.json has them all. */
export const SHOWN = 20;
const AT_ROUTES = 3;
/** Unmatched routes, and keys per route, in the console summary. */
const UNMATCHED_SHOWN = 5;

export const fmtAt = (at: Finding["at"]) =>
  at
    .slice(0, AT_ROUTES)
    .map((a) => `${a.url}@${a.widths.join(",")}`)
    .join(" ") + (at.length > AT_ROUTES ? ` +${at.length - AT_ROUTES} routes` : "");

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
  for (const f of findings.slice(0, SHOWN))
    out.push(`  ${f.key} ${f.prop} ${f.values.join("→")}  ${fmtAt(f.at)}`);
  if (findings.length > SHOWN) out.push(`  (+${findings.length - SHOWN} more in results.json)`);
  const cut = computedOf(rows).filter((r) => r.computed!.truncated);
  if (cut.length)
    out.push(
      `  truncated: only the first ${MAX_CHANGES} changes kept on ` +
        cut.map((r) => `${name(r)}@${r.width} (+${r.computed!.truncated})`).join(" "),
    );
  const capped = computedOf(rows).filter((r) => r.computed!.unchecked);
  if (capped.length)
    out.push(
      `  states: only the first ${MAX_STATES} links and controls forced on ` +
        capped.map((r) => `${name(r)}@${r.width} (+${r.computed!.unchecked})`).join(" "),
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
  return [...out, ...fmtRules(rows)];
}

// ponytail: raw indented lines, so a wrapper role added or removed re-indents everything below it; key lines by role path if that gets noisy
export function diffAria(left: string, right: string, origins?: [string, string]): AriaDiff {
  const lines = (t: string) =>
    t.split("\n").map((l) => l.replace(/^(\s*- \/url: )(.*)$/, (_, p, u) => p + normalizeUrl(u)));
  const { added, removed } = textDiff(
    lines(origins ? rebaseText(left, ...origins) : left),
    lines(right),
  );
  return {
    added: added.slice(0, MAX_ARIA_LINES),
    removed: removed.slice(0, MAX_ARIA_LINES),
    truncated:
      Math.max(0, added.length - MAX_ARIA_LINES) + Math.max(0, removed.length - MAX_ARIA_LINES),
  };
}

/** The console block: identical routes counted, then each distinct diff once with the widths it was seen at. */
export function fmtAria(results: RouteResult[], routes: string[]): string[] {
  const rows = results.filter((r): r is ComparedResult => r.status === "compared" && "aria" in r);
  if (!rows.length) return [];
  const groups = new Map<string, { at: string; widths: number[]; lines: string[]; more: number }>();
  const failed: string[] = [];
  const differs: string[] = [];
  let identical = 0;
  for (const route of routes) {
    const rs = rows.filter((r) => name(r) === route);
    if (!rs.length) continue;
    const bad = rs.find((r) => !r.aria);
    if (bad) failed.push(`${route}@${bad.width} (${bad.ariaError ?? "unknown"})`);
    const diffs = rs.filter((r) => r.aria && (r.aria.added.length || r.aria.removed.length));
    if (diffs.length) differs.push(route);
    else if (rs.some((r) => r.aria)) identical++;
    for (const r of diffs) {
      const { added, removed, truncated } = r.aria!;
      const id = JSON.stringify([route, added, removed]);
      const g = groups.get(id);
      if (g) g.widths.push(r.width);
      else {
        const lines = [...added.map((l) => `+${l}`), ...removed.map((l) => `-${l}`)];
        groups.set(id, { at: route, widths: [r.width], lines, more: truncated });
      }
    }
  }
  const out = [
    `aria: identical on ${identical} of ${identical + differs.length} route(s)` +
      (differs.length ? `, differs ${differs.join(" ")}` : "") +
      (failed.length ? `; snapshot failed on ${failed.join(" ")}` : ""),
  ];
  const all = [...groups.values()];
  for (const g of all.slice(0, SHOWN)) {
    out.push(`  ${g.at}@${g.widths.join(",")}`);
    out.push(...g.lines.slice(0, ARIA_LINES_SHOWN).map((l) => `    ${l}`));
    const more = Math.max(0, g.lines.length - ARIA_LINES_SHOWN) + g.more;
    if (more) out.push(`    (+${more} more in results.json)`);
  }
  if (all.length > SHOWN) out.push(`  (+${all.length - SHOWN} more in results.json)`);
  return out;
}
