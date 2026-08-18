"use strict";

/* dashboard.html, as a page its own scripts can actually be run against.
 *
 * The dashboard's classic scripts are written so that every element lookup is
 * null-guarded - the markup is mid-port and anything may already have moved -
 * which means a stub page that answered null to everything would let them all
 * "pass" having done nothing. So this parses the real markup instead of taking
 * a list of ids: the elements are the ones the page ships, and a rename in the
 * HTML shows up here as a view that renders nothing rather than as a fixture
 * that quietly agreed with it.
 *
 * Not a DOM implementation and not trying to be one (see
 * standards/dependency-discipline.md). It is a tree, a selector matcher over
 * the subset this page uses - tag, #id, .class, [attr], [attr=value] and the
 * descendant combinator - and delegated event dispatch. Anything outside that
 * subset THROWS rather than answering null, for the reason above: a selector
 * this cannot read must not look like an element that is not there.
 *
 * innerHTML is re-parsed rather than stored, so a row a view has just drawn is
 * a real element with real data-* attributes and can be clicked, which is how
 * the boot test drives handlers that only exist for rendered markup.
 */

const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" ")
);

const TOKEN =
  /<!--[\s\S]*?-->|<!\s*doctype[^>]*>|<(\/)?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/)?>/gi;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
/* One compound selector, consumed whole. Sticky: anything left over is a
 * selector this file does not understand, and the caller is told so. */
const PART = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=("[^"]*"|'[^']*'|[^\]]*))?\]/y;

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const unquote = (v) => (/^["']/.test(v) ? v.slice(1, -1) : v);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", mdash: "—", ndash: "–" };
const decode = (s) => s.replace(/&([a-z#0-9]+);/gi, (m, name) => (name in ENTITIES ? ENTITIES[name] : m));

// ---- nodes ---------------------------------------------------------------

function textNode(data) {
  return { nodeType: 3, data, parentElement: null, get textContent() { return this.data; } };
}

function element(tag, attributes) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attributes: Object.assign({}, attributes),
    dataset: {},
    childNodes: [],
    parentElement: null,
    style: {},
    listeners: new Map(),
  };
  for (const [name, value] of Object.entries(node.attributes)) {
    if (name.startsWith("data-")) node.dataset[camel(name.slice(5))] = value;
  }

  const attr = (name, fallback) => (name in node.attributes ? node.attributes[name] : fallback);

  Object.defineProperties(node, {
    children: { get: () => node.childNodes.filter((n) => n.nodeType === 1) },
    id: {
      get: () => attr("id", ""),
      set: (v) => { node.attributes.id = v; },
    },
    className: {
      get: () => attr("class", ""),
      set: (v) => { node.attributes.class = v; },
    },
    textContent: {
      get: () => node.childNodes.map((n) => n.textContent).join(""),
      set: (v) => {
        node.childNodes = [];
        node.appendChild(textNode(String(v)));
      },
    },
    innerHTML: {
      get: () => node.childNodes.map(serialize).join(""),
      set: (v) => {
        node.childNodes = [];
        for (const child of parseFragment(String(v))) node.appendChild(child);
      },
    },
    // A <select>'s option list, which legacy.js's fillSelect truncates and
    // refills on every repaint.
    length: {
      get: () => node.children.length,
      set: (n) => {
        node.childNodes = node.children.slice(0, n);
        node.childNodes.forEach((k) => (k.parentElement = node));
      },
    },
    options: { get: () => node.children },
  });

  node.hidden = "hidden" in node.attributes;
  node.disabled = "disabled" in node.attributes;
  node.checked = "checked" in node.attributes;
  node.value = attr("value", "");
  node.type = attr("type", "");
  node.min = attr("min", "");
  node.max = attr("max", "");
  node.placeholder = attr("placeholder", "");

  node.classList = {
    contains: (name) => node.className.split(/\s+/).includes(name),
    add: (name) => {
      if (!node.classList.contains(name)) node.className = (node.className + " " + name).trim();
    },
    remove: (name) => {
      node.className = node.className.split(/\s+/).filter((c) => c && c !== name).join(" ");
    },
    toggle: (name, force) => {
      const on = force === undefined ? !node.classList.contains(name) : !!force;
      if (on) node.classList.add(name);
      else node.classList.remove(name);
      return on;
    },
  };

  node.getAttribute = (name) => (name in node.attributes ? node.attributes[name] : null);
  node.hasAttribute = (name) => name in node.attributes;
  node.setAttribute = (name, value) => {
    node.attributes[name] = String(value);
    if (name.startsWith("data-")) node.dataset[camel(name.slice(5))] = String(value);
  };
  node.removeAttribute = (name) => {
    delete node.attributes[name];
  };

  node.appendChild = (child) => {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = node;
    node.childNodes.push(child);
    return child;
  };
  node.add = node.appendChild; // <select>.add(new Option(...))
  node.removeChild = (child) => {
    node.childNodes = node.childNodes.filter((n) => n !== child);
    child.parentElement = null;
    return child;
  };
  node.remove = () => {
    if (node.parentElement) node.parentElement.removeChild(node);
  };

  node.addEventListener = (type, fn) => {
    if (!node.listeners.has(type)) node.listeners.set(type, []);
    node.listeners.get(type).push(fn);
  };
  node.removeEventListener = (type, fn) => {
    node.listeners.set(type, (node.listeners.get(type) || []).filter((f) => f !== fn));
  };

  // An element click goes through the same delegated path a user's would:
  // several of the dashboard's controls are proxies that call .click() on
  // another button, and every branch that answers is on the document.
  node.click = () => dispatchAt(node, "click");
  /* Code under test fires its own events too - the Matchups view narrows the
   * page by writing the filter controls and dispatching at them, exactly as a
   * hand would, rather than by a private query. It passes a constructed Event,
   * so the type is taken off whatever object it hands over. */
  node.dispatchEvent = (event) => dispatchAt(node, event && event.type, { target: node });
  node.focus = () => {
    const root = rootOf(node);
    if (root.document) root.document.activeElement = node;
  };

  node.matches = (selector) => matchCompound(node, compound(selector));
  node.closest = (selector) => {
    const want = compound(selector);
    for (let at = node; at; at = at.parentElement) if (matchCompound(at, want)) return at;
    return null;
  };
  node.querySelector = (selector) => select(node, selector)[0] || null;
  node.querySelectorAll = (selector) => select(node, selector);

  return node;
}

function serialize(node) {
  if (node.nodeType === 3) return node.data;
  const attrs = Object.entries(node.attributes).map(([k, v]) => ` ${k}="${v}"`).join("");
  const tag = node.tagName.toLowerCase();
  if (VOID.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${node.childNodes.map(serialize).join("")}</${tag}>`;
}

function rootOf(node) {
  let at = node;
  while (at.parentElement) at = at.parentElement;
  return at;
}

/**
 * Fire `type` at `node`: its own listeners, then each ancestor's, then the
 * document's - which is the ordering the load order in dashboard.html exists to
 * control, so a test driving this is driving the real arrangement.
 */
function dispatchAt(node, type, extra) {
  if (!node) throw new Error(`nothing to dispatch ${type} at`);
  const event = Object.assign(
    { type, target: node, currentTarget: node, preventDefault() {}, stopPropagation() {} },
    extra || {}
  );
  for (let at = node; at; at = at.parentElement) {
    for (const fn of (at.listeners.get(type) || []).slice()) fn(event);
  }
  const root = rootOf(node);
  if (root.isRoot) for (const fn of (root.documentListeners.get(type) || []).slice()) fn(event);
  return event;
}

// ---- parsing -------------------------------------------------------------

function parseFragment(html) {
  const root = element("fragment", {});
  let at = root;
  let last = 0;
  TOKEN.lastIndex = 0;
  let m;
  const text = (upto) => {
    const raw = html.slice(last, upto);
    if (raw.trim()) at.appendChild(textNode(decode(raw)));
  };
  while ((m = TOKEN.exec(html))) {
    text(m.index);
    last = TOKEN.lastIndex;
    if (m[2] === undefined) continue; // comment or doctype
    const tag = m[2].toLowerCase();
    if (m[1]) {
      // A close tag: unwind to it, tolerating markup that never opened one.
      for (let up = at; up && up !== root; up = up.parentElement) {
        if (up.tagName === tag.toUpperCase()) {
          at = up.parentElement;
          break;
        }
      }
      continue;
    }
    const attrs = {};
    ATTR.lastIndex = 0;
    let a;
    while ((a = ATTR.exec(m[3] || ""))) {
      attrs[a[1].toLowerCase()] = decode(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] || "");
    }
    const node = at.appendChild(element(tag, attrs));
    if (!VOID.has(tag) && !m[4]) at = node;
  }
  text(html.length);
  const kids = root.childNodes.slice();
  kids.forEach((k) => (k.parentElement = null));
  return kids;
}

// ---- selectors -----------------------------------------------------------

const compoundCache = new Map();

/** One compound selector as a list of tests, or a throw if it is out of range. */
function compound(selector) {
  const key = String(selector).trim();
  if (compoundCache.has(key)) return compoundCache.get(key);
  const parts = [];
  PART.lastIndex = 0;
  let m;
  while (PART.lastIndex < key.length && (m = PART.exec(key))) {
    if (m[1]) parts.push({ tag: m[1].toUpperCase() });
    else if (m[2]) parts.push({ id: m[2] });
    else if (m[3]) parts.push({ cls: m[3] });
    else parts.push({ attr: m[4], value: m[5] === undefined ? null : unquote(m[5]) });
  }
  if (!parts.length || PART.lastIndex !== key.length) {
    throw new Error(
      `fake-page cannot read the selector "${selector}". It understands tag, #id, .class, ` +
        "[attr], [attr=value] and descendants; teach it the rest rather than letting it " +
        "answer null, which the dashboard's null-guarded lookups would swallow."
    );
  }
  compoundCache.set(key, parts);
  return parts;
}

function matchCompound(node, parts) {
  if (node.nodeType !== 1) return false;
  for (const p of parts) {
    if (p.tag && node.tagName !== p.tag) return false;
    if (p.id && node.id !== p.id) return false;
    if (p.cls && !node.classList.contains(p.cls)) return false;
    if (p.attr) {
      if (!node.hasAttribute(p.attr)) return false;
      if (p.value !== null && node.getAttribute(p.attr) !== p.value) return false;
    }
  }
  return true;
}

function descendants(node, out) {
  for (const kid of node.childNodes) {
    if (kid.nodeType !== 1) continue;
    out.push(kid);
    descendants(kid, out);
  }
  return out;
}

/** Document order, descendant combinator only. */
function select(scope, selector) {
  const steps = String(selector).trim().split(/\s+/);
  if (steps.some((s) => /^[>+~,]$/.test(s) || s.includes(","))) {
    throw new Error(`fake-page cannot read the selector "${selector}"`);
  }
  let current = [scope];
  for (const step of steps) {
    const want = compound(step);
    const next = [];
    const seen = new Set();
    for (const node of current) {
      for (const kid of descendants(node, [])) {
        if (seen.has(kid) || !matchCompound(kid, want)) continue;
        seen.add(kid);
        next.push(kid);
      }
    }
    current = next;
  }
  return current;
}

// ---- the page ------------------------------------------------------------

/** A document over `html`, plus the delegated dispatch the dashboard needs. */
function loadPage(html) {
  const roots = parseFragment(html);
  const documentElement = roots.find((n) => n.nodeType === 1 && n.tagName === "HTML") || roots[0];
  documentElement.isRoot = true;
  documentElement.documentListeners = new Map();
  const listeners = documentElement.documentListeners;
  const body = documentElement.querySelector("body") || documentElement;

  const document = {
    documentElement,
    body,
    activeElement: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
    },
    querySelector: (s) => select(documentElement, s)[0] || null,
    querySelectorAll: (s) => select(documentElement, s),
    getElementById: (id) => select(documentElement, "#" + id)[0] || null,
    createElement: (tag) => element(tag, {}),
    createTextNode: (data) => textNode(String(data)),
  };
  documentElement.document = document;

  return { document, dispatch: dispatchAt };
}

module.exports = { loadPage, element };
