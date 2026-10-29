import type { Locator, Page } from "playwright";
import type { Shot } from "./capture.ts";
import type { Box, Spot } from "./compare.ts";
import type { Snapshot } from "./computed.ts";

/** Names the DOM elements behind each change, from the pages still holding the shot's document. */

/** A DOM element behind a change. Boxes in that side's page px (element px for a selector route). */
export interface ElementDiff {
  /** CSS selector, unique on the side(s) it names; usable as --selector or querySelector. */
  selector: string;
  /** Where it exists: "left" only in your change, "right" only in the reference. */
  side: "both" | "left" | "right";
  left: Box | null;
  right: Box | null;
  /** Computed properties that differ, [left, right], most telling first; `text` when its text does. */
  changed: Record<string, [string, string]>;
  /** The start of its text (left's when both), "" if none. */
  text: string;
  /** The right side's selector, when it was found by its text under a different one. */
  rightSelector?: string;
  /** Paired although its parent's or grandparent's tags differ, so the props may not be the cause. */
  reparented?: true;
}

const MAX_SPOTS = 5;
const PER_SPOT = 3;
const MAX_CHANGED = 6;

/** Layout first; width and height last, since they are usually a consequence. */
export const PROPS = [
  "display",
  "position",
  "float",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "gap",
  "grid-template-columns",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "white-space",
  "color",
  "background-color",
  "background-image",
  "border-top-color",
  "border-top-left-radius",
  "box-shadow",
  "opacity",
  "transform",
  "visibility",
  "z-index",
  "width",
  "height",
];

interface Seen {
  sel: string;
  tag: string;
  text: string;
  box: Box;
  styles: string[];
  /** Its grandparent's and parent's tags, e.g. `section>div`. */
  up: string;
  /** `::before` and `::after` when generated: their content, size, background and borders. */
  pseudo: (Record<string, string> | null)[];
}

interface Hit extends Seen {
  prev: Seen | null;
  parent: Seen | null;
}

interface Find {
  sel: string;
  tag: string;
  text: string;
  y: number;
  w: number;
  h: number;
  /** This side's box for the change, or null at a band's seam. */
  box: Box | null;
}

interface ProbeArgs {
  boxes: (Box | null)[];
  find: Find[];
  masked: Node[];
  props: string[];
  perSpot: number;
  /** Snapshot every element's `props` instead of picking, giving up after this many ms. */
  walk?: number;
  /** Where the walk starts, keyed `:scope`; the body, keyed `body`, when null. */
  root?: Node | null;
}

/** Runs in the page. At scroll 0 a client rect is page px, below the fold too. */
function probe({ boxes, find, masked, props, perSpot, walk, root }: ProbeArgs) {
  const MAX_SCAN = 50_000;
  const HASHED = /\d{3,}|^(css|sc|jsx|svelte)-|__[\w-]{5,}$|^_/;
  const TEST = ["data-testid", "data-test", "data-test-id", "data-cy", "data-qa"];
  const quote = (n: string, v: string) =>
    // oxlint-disable-next-line no-control-regex -- CSS strings must escape control characters
    `[${n}="${v.replace(/["\\]/g, "\\$&").replace(/[\0-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"]`;
  const unique = (s: string) => document.querySelectorAll(s).length === 1;
  const snippet = (e: Element) =>
    ((e as HTMLElement).innerText ?? e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  const generated = (e: Element, pseudo: string) => {
    const ps = getComputedStyle(e, pseudo);
    const c = ps.getPropertyValue("content");
    return c !== "none" && c !== "normal" ? ps : null;
  };

  /** Tag, a naming attribute and up to two classes that don't look generated. */
  const base = (e: Element, sorted: boolean) => {
    const tag = e.localName;
    let s = CSS.escape(tag);
    const href = e.getAttribute("href");
    if (tag === "a" && href && href.length < 60 && !href.startsWith("javascript:"))
      s += quote("href", href);
    else {
      for (const n of ["name", "aria-label", ...(tag === "input" ? ["type"] : [])]) {
        const v = e.getAttribute(n);
        if (v && v.length < 60) {
          s += quote(n, v);
          break;
        }
      }
    }
    // ponytail: hashed-class heuristic, attributes and nth-of-type are the fallback
    const classes = Array.from(e.classList).filter((c) => !HASHED.test(c));
    if (sorted) classes.sort();
    return (
      s +
      classes
        .slice(0, 2)
        .map((c) => `.${CSS.escape(c)}`)
        .join("")
    );
  };

  const part = (e: Element) => {
    const tag = e.localName;
    let s = base(e, false);
    const siblings = e.parentElement ? Array.from(e.parentElement.children) : [];
    if (siblings.some((c) => c !== e && c.matches(s))) {
      s += `:nth-of-type(${siblings.filter((c) => c.localName === tag).indexOf(e) + 1})`;
    }
    return s;
  };

  const selector = (e: Element) => {
    if (e.id && unique(`#${CSS.escape(e.id)}`)) return `#${CSS.escape(e.id)}`;
    for (const n of TEST) {
      const v = e.getAttribute(n);
      if (v && unique(e.localName + quote(n, v))) return e.localName + quote(n, v);
    }
    let path = "";
    for (let n: Element | null = e; n && n !== document.documentElement; n = n.parentElement) {
      if (n !== e && n.id && unique(`#${CSS.escape(n.id)}`))
        return `#${CSS.escape(n.id)} > ${path}`;
      path = path ? `${part(n)} > ${path}` : part(n);
      if (unique(path)) break;
    }
    return path;
  };

  const seen = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return {
      sel: selector(e),
      tag: e.localName,
      text: snippet(e),
      box: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
      styles: props.map((p) => cs.getPropertyValue(p)),
      up: (() => {
        const tags: string[] = [];
        for (let n = e.parentElement; n && tags.length < 2; n = n.parentElement)
          tags.unshift(n.localName);
        return tags.join(">");
      })(),
      pseudo: ["::before", "::after"].map((p) => {
        const ps = generated(e, p);
        return (
          ps &&
          Object.fromEntries(
            [
              "content",
              "width",
              "height",
              "background-color",
              "background-image",
              "border-top-width",
              "border-top-color",
              "border-bottom-width",
              "border-bottom-color",
              "box-shadow",
            ].map((q) => [
              q,
              // A url() resolves against each side's origin.
              ps.getPropertyValue(q).replaceAll(location.origin, ""),
            ]),
          )
        );
      }),
    };
  };
  const hit = (e: Element) => {
    const parent = e.parentElement;
    return {
      ...seen(e),
      prev: e.previousElementSibling ? seen(e.previousElementSibling) : null,
      parent: parent && parent !== document.body ? seen(parent) : null,
    };
  };

  const all: { e: Element; r: DOMRect }[] = [];
  const hidden = new Set<Element>();
  for (const m of masked as Element[])
    [m, ...Array.from(m.querySelectorAll("*"))].forEach((e) => hidden.add(e));

  if (walk) {
    // STILL_CSS stops CSS animations; this settles ones started from script.
    for (const a of document.getAnimations()) {
      try {
        a.finish();
      } catch {
        a.cancel();
      }
    }
    const snap: Record<string, { html: string; styles: string[]; size?: [string, string] }> = {};
    const SKIP = new Set(["script", "style", "link", "meta", "template", "noscript"]);
    let n = 0;
    const end = performance.now() + walk;
    // Generated class names change with the CSS, so they aren't markup changes.
    const html = (e: Element) => {
      const attrs = Array.from(e.attributes, (a) => {
        const v =
          a.name === "class"
            ? Array.from(e.classList)
                .filter((c) => !HASHED.test(c))
                .sort()
                .join(" ")
            : a.value;
        return ` ${a.name}="${v.replace(/"/g, "&quot;")}"`;
      }).join("");
      const text = Array.from(e.childNodes, (c) => (c.nodeType === 3 ? c.textContent : ""))
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      return `<${e.localName}${attrs}>${text}`;
    };
    // A display:none element is kept, so a rule that hid it is a style change; its subtree isn't.
    const visit = (e: Element, key: string) => {
      if (++n > MAX_SCAN) throw new Error(`more than ${MAX_SCAN} elements`);
      if (performance.now() > end) throw new Error(`took over ${walk}ms`);
      const cs = getComputedStyle(e);
      // Specified, not used: `auto`, `100%` or `200px` says which box sizes which.
      const m = e.computedStyleMap?.();
      snap[key] = {
        html: html(e),
        styles: props.map((p) => cs.getPropertyValue(p)),
        ...(m ? { size: [String(m.get("width")), String(m.get("height"))] } : {}),
      };
      if (cs.display === "none") return;
      for (const pseudo of ["::before", "::after"]) {
        const ps = generated(e, pseudo);
        if (ps) snap[key + pseudo] = { html: "", styles: props.map((p) => ps.getPropertyValue(p)) };
      }
      // Indexed among every child, as :nth-of-type counts, so the key works with querySelector.
      const ofType = new Map<string, number>();
      const kids = Array.from(e.children, (c) => {
        const k = (ofType.get(c.localName) ?? 0) + 1;
        ofType.set(c.localName, k);
        return { c, k };
      }).filter(
        ({ c }) => !hidden.has(c) && !SKIP.has(c.localName) && !(c as SVGElement).ownerSVGElement,
      );
      // The id, or the tag with a naming attribute and classes; with the index where siblings share it.
      const segs = kids.map(({ c }) =>
        c.id && !HASHED.test(c.id)
          ? `${CSS.escape(c.localName)}#${CSS.escape(c.id)}`
          : base(c, true),
      );
      const count = new Map<string, number>();
      for (const g of segs) count.set(g, (count.get(g) ?? 0) + 1);
      kids.forEach(({ c, k }, i) => {
        const g = segs[i]!;
        visit(c, `${key} > ${count.get(g)! > 1 ? `${g}:nth-of-type(${k})` : g}`);
      });
    };
    const start = (root as Element | null) ?? document.body;
    if (start) visit(start, root ? ":scope" : "body");
    return { picks: [], found: [], snap };
  }
  const els = document.body?.querySelectorAll("*") ?? [];
  for (let i = 0; i < els.length && i < MAX_SCAN; i++) {
    const e = els[i]!;
    if ((e as SVGElement).ownerSVGElement || hidden.has(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width && r.height) all.push({ e, r });
  }

  const picks = boxes.map((b) => {
    if (!b) return [];
    const ranked = all
      .map(({ e, r }) => {
        const ix = Math.min(r.right, b.x + b.w) - Math.max(r.left, b.x);
        const iy = Math.min(r.bottom, b.y + b.h) - Math.max(r.top, b.y);
        return {
          e,
          r,
          ix,
          iy,
          area: r.width * r.height,
          score: ix > 0 && iy > 0 ? (ix * iy) / Math.max(r.width * r.height, b.w * b.h) : 0,
        };
      })
      .filter((c) => c.score > 0)
      .sort((p, q) => q.score - p.score || p.area - q.area)
      .slice(0, 10)
      .filter(
        (c) => c.e.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true,
      );
    for (const c of ranked) {
      const cx = Math.max(c.r.left, b.x) + c.ix / 2;
      const cy = Math.max(c.r.top, b.y) + c.iy / 2;
      if (cy >= innerHeight || cx >= innerWidth) continue;
      // Something painted over it there, e.g. fixed chrome.
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== c.e && !c.e.contains(top) && !top.contains(c.e)) c.score *= 0.25;
    }
    ranked.sort((p, q) => q.score - p.score || p.area - q.area);
    const chosen: Element[] = [];
    for (const { e } of ranked) {
      if (chosen.length === perSpot) break;
      if (chosen.some((p) => p.contains(e) || e.contains(p))) continue;
      chosen.push(e);
    }
    return chosen.map(hit);
  });

  const found = find.map(({ sel, tag, text, y, w, h, box }) => {
    let e: Element | null = null;
    try {
      e = document.querySelector(sel);
    } catch {}
    if (e && text && snippet(e) !== text) e = null;
    // With no text to check, nth-of-type may now name a different element: require its shape and place.
    if (e && !text) {
      const r = e.getBoundingClientRect();
      const near =
        !box ||
        (r.right > box.x && r.left < box.x + box.w && r.bottom > box.y && r.top < box.y + box.h);
      if (e.localName !== tag || Math.abs(r.width - w) > 4 || Math.abs(r.height - h) > 4 || !near)
        e = null;
    }
    // An insertion shifts nth-of-type, so fall back to the same tag with the same text.
    if (!e && text) {
      const same = Array.from(document.querySelectorAll(tag)).filter((c) => snippet(c) === text);
      e =
        same.sort(
          (p, q) =>
            Math.abs(p.getBoundingClientRect().y - y) - Math.abs(q.getBoundingClientRect().y - y),
        )[0] ?? null;
    }
    return e ? hit(e) : null;
  });

  return { picks, found, snap: null };
}

type Pair = [Seen | null, Seen | null];

function element([l, r]: Pair, origins: Shot["origin"][]): ElementDiff {
  const changed: Record<string, [string, string]> = {};
  if (l && r) {
    if (l.text !== r.text) changed.text = [l.text, r.text];
    PROPS.forEach((p, i) => {
      if (l.styles[i] !== r.styles[i]) changed[p] = [l.styles[i]!, r.styles[i]!];
    });
  }
  const at = (s: Seen | null, o: Shot["origin"]) =>
    s && { ...s.box, x: s.box.x - o.x, y: s.box.y - o.y };
  return {
    selector: (l ?? r)!.sel,
    side: l && r ? "both" : l ? "left" : "right",
    left: at(l, origins[0]!),
    right: at(r, origins[1]!),
    changed: Object.fromEntries(Object.entries(changed).slice(0, MAX_CHANGED)),
    text: (l ?? r)!.text,
    ...(l && r && l.sel !== r.sel ? { rightSelector: r.sel } : {}),
  };
}

/** `sel::before` / `sel::after` where the pseudo-element exists on one side only, or differs. */
function pseudos([l, r]: [Seen, Seen], origins: Shot["origin"][]): ElementDiff[] {
  return ["::before", "::after"].flatMap((name, i) => {
    const [p, q] = [l.pseudo[i], r.pseudo[i]];
    if (!p && !q) return [];
    const changed = Object.fromEntries(
      p && q
        ? Object.keys(p)
            .filter((k) => p[k] !== q[k])
            .map((k): [string, [string, string]] => [k, [p[k]!, q[k]!]])
        : [],
    );
    if (p && q && !Object.keys(changed).length) return [];
    const host = element([p ? l : null, q ? r : null], origins);
    return [
      {
        ...host,
        selector: host.selector + name,
        changed,
        text: "",
        ...(host.rightSelector ? { rightSelector: host.rightSelector + name } : {}),
      },
    ];
  });
}

/** Without text to compare, a selector naming both is only the same element if the box agrees. */
const same = (a: Seen, b: Seen) =>
  !!(a.text || b.text) ||
  (a.tag === b.tag && Math.abs(a.box.w - b.box.w) <= 4 && Math.abs(a.box.h - b.box.h) <= 4);

const moved = (a: Box, b: Box) => a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h;

const handles = async (ls: Locator[]) =>
  (await Promise.all(ls.map((l) => l.elementHandles()))).flat();

/**
 * Every rendered element's computed `PROPS` and `content`, and its `::before`/`::after` when
 * generated, keyed by a selector path; masked and `display: none` subtrees are skipped.
 * Finishes the page's animations, so it runs after `locate`.
 */
export async function snapshot(
  page: Page,
  masks: Locator[],
  budget: number,
  root: Locator | null,
): Promise<Snapshot> {
  const { snap } = await page.evaluate(probe, {
    root: root && (await root.elementHandle()),
    boxes: [],
    find: [],
    masked: await handles(masks),
    props: [...PROPS, "content"],
    perSpot: 0,
    walk: budget,
  });
  return snap!;
}

/**
 * The elements behind each of the first `MAX_SPOTS` spots, in spot order. Each side picks the
 * elements that best fill its box, then the other side looks for each by selector.
 */
export async function locate(
  pages: [Page, Page],
  shots: [Shot, Shot],
  spots: Spot[],
  masks: [Locator[], Locator[]],
): Promise<ElementDiff[][]> {
  const todo = spots.slice(0, MAX_SPOTS);
  if (!todo.length) return [];
  const masked = await Promise.all(masks.map(handles));
  const boxes = (s: 0 | 1) =>
    todo.map((t) => {
      const b = s ? t.right : t.left;
      const o = shots[s].origin;
      return b.w && b.h ? { ...b, x: b.x + o.x, y: b.y + o.y } : null;
    });
  const run = (s: 0 | 1, find: Find[]) =>
    pages[s].evaluate(probe, {
      boxes: find.length ? [] : boxes(s),
      find,
      masked: masked[s]!,
      props: PROPS,
      perSpot: PER_SPOT,
    });

  const [l, r] = await Promise.all([run(0, []), run(1, [])]);
  const picks = [l.picks, r.picks] as Hit[][][];
  // Each side looks for what only the other picked.
  const asks = ([0, 1] as const).map((s) =>
    picks[1 - s]!.flatMap((hits, i) =>
      hits
        .filter((h) => !picks[s]![i]!.some((o) => o.sel === h.sel && same(o, h)))
        .map((h) => ({ i, h })),
    ),
  );
  const answers = await Promise.all(
    ([0, 1] as const).map((s) =>
      asks[s]!.length
        ? run(
            s,
            asks[s]!.map(({ i, h }) => ({
              sel: h.sel,
              tag: h.tag,
              text: h.text,
              y: h.box.y,
              w: h.box.w,
              h: h.box.h,
              box: boxes(s)[i]!,
            })),
          ).then((a) => a.found as (Hit | null)[])
        : [],
    ),
  );

  return todo.map((spot, i) => {
    const pairs: [Hit | null, Hit | null][] = [];
    const keys = new Set<string>();
    for (const s of [0, 1] as const) {
      for (const h of picks[s]![i]!) {
        const k = asks[1 - s]!.findIndex((a) => a.i === i && a.h === h);
        const other =
          picks[1 - s]![i]!.find((o) => o.sel === h.sel && same(o, h)) ??
          (k >= 0 ? answers[1 - s]![k]! : null);
        const pair: [Hit | null, Hit | null] = s ? [other, h] : [h, other];
        const key = `${pair[0]?.sel}\n${pair[1]?.sel}`;
        if (!keys.has(key)) {
          keys.add(key);
          pairs.push(pair);
        }
      }
    }
    const out: ElementDiff[] = [];
    for (const [a, b] of pairs.slice(0, PER_SPOT)) {
      const el = element([a, b], [shots[0].origin, shots[1].origin]);
      if (a && b && a.up !== b.up) el.reparented = true;
      out.push(el);
      if (a && b)
        out.push(
          ...pseudos([a, b], [shots[0].origin, shots[1].origin]).map((p) =>
            el.reparented ? { ...p, reparented: el.reparented } : p,
          ),
        );
      // ponytail: one level of cause; a deeper cascade search if agents ask for it
      if (el.left && el.right && !Object.keys(el.changed).length && moved(el.left, el.right)) {
        for (const [p, q] of [
          [a!.prev, b!.prev],
          [a!.parent, b!.parent],
        ] as Pair[]) {
          if (!p || !q || p.sel !== q.sel) continue;
          const cause = element([p, q], [shots[0].origin, shots[1].origin]);
          if (
            Object.keys(cause.changed).length &&
            !out.some((o) => o.selector === cause.selector)
          ) {
            out.push(cause);
            break;
          }
        }
      }
    }
    const unique = out.filter((e, j) => out.findIndex((o) => o.selector === e.selector) === j);
    // A band's rows are what one side added; an element on both sides there was only pushed.
    if (spot.kind === "band") return unique.filter((e) => e.side !== "both");
    // Unchanged and unmoved, e.g. covered by what changed: noise beside anything that explains.
    const telling = unique.filter(
      (e) => e.side !== "both" || Object.keys(e.changed).length || moved(e.left!, e.right!),
    );
    return telling.length ? telling : unique;
  });
}
