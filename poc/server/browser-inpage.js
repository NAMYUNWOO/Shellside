// Runs inside each page of the board browser, in an isolated world: page scripts can neither see nor change it.
// Plain JS on purpose (it is sent to the page as text, never compiled).
// - snapshot(): the page as compact text, with @refs for everything you can act on
// - resolve()/point()/…: find an element again from @ref, css: or text:, and prepare actions on it
(() => {
  if (globalThis.__ss) return;

  const refs = new Map(); // n → WeakRef(Element)
  const ids = new WeakMap(); // Element → n
  let next = 1;
  const refOf = (el) => {
    let n = ids.get(el);
    if (!n) {
      n = next++;
      ids.set(el, n);
      refs.set(n, new WeakRef(el));
    }
    return n;
  };

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "BASE", "TITLE", "OPTION", "OPTGROUP", "DATALIST"]);
  const BLOCK = new Set(["block", "flex", "grid", "list-item", "table", "table-row-group", "table-header-group", "table-footer-group", "flow-root", "table-caption"]);
  const INLINE_BOX = new Set(["inline-block", "inline-flex", "inline-grid", "inline-table", "table-cell"]);
  const ARIA_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem",
  ]);
  const TEXT_TYPES = new Set(["", "text", "email", "search", "url", "tel", "password", "number", "date", "datetime-local", "month", "time", "week"]);
  const INTERACTIVE_SEL = "a[href],button,input:not([type=hidden]),textarea,select,summary,[role],[onclick],[tabindex],[contenteditable='true'],[contenteditable='']";

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const q = (s) => JSON.stringify(s);
  const styleOf = (el) => el.ownerDocument.defaultView.getComputedStyle(el);

  const isTextInput = (el) => (el.tagName === "INPUT" && TEXT_TYPES.has((el.getAttribute("type") || "").toLowerCase())) || el.tagName === "TEXTAREA";
  const editableRoot = (el) => el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable);

  /** What an element is to someone using the page, or null if it is just content. */
  function roleOf(el) {
    const aria = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (ARIA_ROLES.has(aria)) return aria === "searchbox" ? "textbox" : aria;
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : null;
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "select";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "file") return "file";
      if (t === "color") return "color";
      return t === "password" ? "password" : "textbox";
    }
    if (editableRoot(el)) return "textbox";
    // Script-driven controls: an onclick handler, keyboard focus, or the start of a pointer cursor.
    if (el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.tabIndex >= 0 && tag !== "DIALOG" && tag !== "BODY")) return "clickable";
    const st = styleOf(el);
    if (st.cursor === "pointer" && el.parentElement && styleOf(el.parentElement).cursor !== "pointer" && tag !== "LABEL") return "clickable";
    return null;
  }

  function nameOf(el) {
    const doc = el.ownerDocument;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map((e) => e.innerText || e.textContent).join(" "));
      if (t) return t;
    }
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const labels = el.labels ? clean([...el.labels].map(labelText).join(" ")) : "";
      if (labels) return labels;
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (["button", "submit", "reset"].includes(t)) return clean(el.value) || (t === "submit" ? "Submit" : t === "reset" ? "Reset" : "");
      if (t === "image") return clean(el.alt) || "Submit";
      return clean(el.getAttribute("title")) || clean(el.getAttribute("placeholder"));
    }
    if (tag === "IMG") return clean(el.alt);
    const text = clean(el.innerText);
    if (text) return text;
    const img = el.querySelector("img[alt]");
    if (img && clean(img.alt)) return clean(img.alt);
    const svgTitle = el.querySelector("svg title");
    if (svgTitle && clean(svgTitle.textContent)) return clean(svgTitle.textContent);
    const own = clean(el.getAttribute("title")) || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("value"));
    if (own) return own;
    // An icon link or button: the icon inside may carry the words (e.g. <div title="upvote">).
    const inner = el.querySelector("[aria-label],[title]");
    return inner ? clean(inner.getAttribute("aria-label")) || clean(inner.getAttribute("title")) : "";
  }

  /** A label's own words, without the text of the controls inside it (a <select>'s options, say). */
  function labelText(label) {
    if (!label.querySelector("input,select,textarea,button")) return label.innerText;
    const copy = label.cloneNode(true);
    for (const c of copy.querySelectorAll("input,select,textarea,button")) c.remove();
    return copy.textContent;
  }
  /** A <label> that wraps its control: the control's token already carries the label's words. */
  const wrapsControl = (el) => el.tagName === "LABEL" && el.control && el.contains(el.control);

  const shortHref = (el) => {
    const raw = el.getAttribute("href") || "";
    if (raw.startsWith("javascript:")) return "";
    try {
      const u = new URL(el.href);
      const shown = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href;
      let readable = shown;
      try {
        readable = decodeURI(shown); // 한글 and other non-ASCII paths, as people read them
      } catch {}
      return cut(readable, 90);
    } catch {
      return cut(raw, 90);
    }
  };

  function describe(el) {
    if (!el) return "nothing";
    const r = roleOf(el) || el.tagName.toLowerCase();
    const n = cut(nameOf(el), 60);
    return n ? `${r} ${q(n)}` : r;
  }

  /** The bracketed token for something you can act on. */
  function token(el, role) {
    const n = refOf(el);
    const name = cut(nameOf(el), 100);
    const parts = [`@${n}`, role];
    if (name) parts.push(q(name));
    const tag = el.tagName;
    if (role === "link") {
      const h = shortHref(el);
      if (h) parts.push(`→ ${h}`);
    } else if (role === "textbox") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (t && t !== "text") parts.push(`type=${t}`);
      const v = el.isContentEditable && tag !== "INPUT" && tag !== "TEXTAREA" ? clean(el.innerText) : el.value;
      if (v) parts.push(`value=${q(cut(String(v), 120))}`);
      const ph = clean(el.getAttribute("placeholder"));
      if (ph && ph !== name) parts.push(`placeholder=${q(cut(ph, 60))}`);
    } else if (role === "password") {
      if (el.value) parts.push("(filled)");
    } else if (role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox" || role === "menuitemradio") {
      const on = tag === "INPUT" ? el.checked : el.getAttribute("aria-checked") === "true";
      parts.push(on ? "checked" : "unchecked");
    } else if (role === "select") {
      const opts = [...el.options];
      const cur = el.selectedOptions && el.selectedOptions[0];
      if (cur) parts.push(`= ${q(cut(clean(cur.text), 60))}`);
      const list = opts.slice(0, 12).map((o) => cut(clean(o.text), 30)).join(" | ");
      parts.push(`(${opts.length} options: ${list}${opts.length > 12 ? " | …" : ""})`);
      if (el.multiple) parts.push("multiple");
    } else if (role === "file") {
      const acc = el.getAttribute("accept");
      if (acc) parts.push(`accept=${q(acc)}`);
      if (el.files && el.files.length) parts.push(`(${el.files.length} file${el.files.length > 1 ? "s" : ""} chosen)`);
    } else if (role === "slider") {
      parts.push(`value=${q(String(el.value ?? el.getAttribute("aria-valuenow") ?? ""))}`);
    }
    const exp = el.getAttribute("aria-expanded");
    if (exp) parts.push(exp === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") && el.getAttribute("aria-current") !== "false") parts.push("current");
    if (el.getAttribute("aria-pressed") === "true") parts.push("pressed");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (el.required) parts.push("required");
    if (el.readOnly) parts.push("readonly");
    if (el.ownerDocument.activeElement === el) parts.push("focused");
    return `[${parts.join(" ")}]`;
  }

  const kids = (node) => {
    if (node.shadowRoot) return [...node.shadowRoot.childNodes];
    if (node.tagName === "SLOT") {
      const assigned = node.assignedNodes({ flatten: true });
      return assigned.length ? assigned : [...node.childNodes];
    }
    return [...node.childNodes];
  };

  function frameDoc(el) {
    try {
      return el.contentDocument && el.contentDocument.body ? el.contentDocument : null;
    } catch {
      return null;
    }
  }

  /** The page (or the part under `selector`) as text. Interactive things become [@N role "name" …]. */
  function snapshot(opts) {
    opts = opts || {};
    const max = Math.max(1000, opts.maxChars || 20000);
    const only = !!opts.interactive;
    const lines = [];
    let size = 0;
    let full = false;
    let cur = "";
    let pre = "";
    let inline = 0; // >0 inside table rows and headings: blocks do not break the line
    let listDepth = 0;
    let count = 0;
    let mute = 0; // >0 inside a label that wraps its control: its words are already in the control's token

    const push = (s) => {
      if (full) return;
      lines.push(s);
      size += s.length + 1;
      if (size > max) full = true;
    };
    const flush = () => {
      const t = clean(cur);
      cur = "";
      if (!t) return;
      if (!only) push(pre + t);
      pre = "";
    };
    const emit = (tok) => {
      count++;
      if (only) push(tok);
      else cur += ` ${tok} `;
    };

    const walk = (node) => {
      if (full) return;
      if (node.nodeType === 3) {
        if (!only && !mute) cur += node.data;
        return;
      }
      if (node.nodeType === 11) {
        for (const k of [...node.childNodes]) walk(k);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.tagName;
      if (SKIP.has(tag)) return;
      if (el.getAttribute("aria-hidden") === "true") return;
      const st = styleOf(el);
      if (st.display === "none" || st.visibility === "hidden" || st.visibility === "collapse") return;
      if (st.display !== "contents" && el.getClientRects().length === 0 && tag !== "SLOT") return;
      if ((st.overflow === "hidden" || st.overflow === "clip") && tag !== "BODY" && tag !== "HTML") {
        const r = el.getBoundingClientRect();
        if (r.width < 2 && r.height < 2 && r.width + r.height < 2 && !el.querySelector("input,textarea,select")) {
          // visually hidden helper text (sr-only): keep the words, they label things
          if (!only) cur += ` ${el.textContent || ""} `;
          return;
        }
        if (r.height === 0 || r.width === 0) return; // collapsed menu or panel
      }

      if (tag === "IFRAME" || tag === "FRAME") {
        const doc = frameDoc(el);
        if (doc) {
          if (inline === 0) flush();
          walk(doc.body);
          if (inline === 0) flush();
        } else {
          emit(`[iframe ${q(cut(clean(el.title || el.name || ""), 40) || "embedded page")} from ${cut(el.src || "", 60)} (other site: not readable)]`);
        }
        return;
      }
      if (tag === "IMG") {
        const alt = clean(el.alt);
        if (alt && !only) cur += ` [img ${q(cut(alt, 80))}] `;
        return;
      }
      if (tag === "svg" || tag === "SVG") {
        const label = clean(el.getAttribute("aria-label")) || clean(el.querySelector("title")?.textContent);
        if (label && !only) cur += ` [img ${q(cut(label, 60))}] `;
        return;
      }
      if (tag === "CANVAS" || tag === "VIDEO" || tag === "AUDIO") {
        if (!only) cur += ` [${tag.toLowerCase()}] `;
        return;
      }

      const role = roleOf(el);
      if (role) {
        // A wrapper that only looks clickable but holds real controls: show the controls instead.
        const wrapper = role === "clickable" && el.querySelector(INTERACTIVE_SEL.replace(",[tabindex]", "").replace(",[role]", ""));
        if (!wrapper) {
          emit(token(el, role));
          return;
        }
      }

      if (wrapsControl(el)) {
        mute++;
        for (const k of kids(el)) walk(k);
        mute--;
        return;
      }
      const display = st.display;
      const block = BLOCK.has(display) || tag === "BR" || tag === "HR";
      const heading = /^H[1-6]$/.test(tag) || el.getAttribute("role") === "heading";
      if (tag === "BR") {
        if (inline === 0) flush();
        else cur += " ";
        return;
      }
      if (heading && inline === 0) {
        flush();
        const level = /^H[1-6]$/.test(tag) ? Number(tag[1]) : Number(el.getAttribute("aria-level") || 2);
        pre = "#".repeat(Math.min(6, Math.max(1, level))) + " ";
        inline++;
        for (const k of kids(el)) walk(k);
        inline--;
        flush();
        pre = "";
        return;
      }
      if (tag === "TR" && inline === 0) {
        flush();
        inline++;
        for (const k of kids(el)) {
          if (k.nodeType !== 1) continue;
          cur += " | ";
          walk(k);
        }
        inline--;
        if (clean(cur.replace(/\|/g, ""))) cur = cur.replace(/^\s*\|\s*/, "| ") + " |";
        else cur = "";
        flush();
        return;
      }
      if (tag === "TABLE" && inline > 0) {
        // A table inside a table row (old layout tables): its rows get their own lines.
        const saved = inline;
        inline = 0;
        flush();
        for (const k of kids(el)) walk(k);
        flush();
        inline = saved;
        return;
      }
      const list = tag === "UL" || tag === "OL";
      if (list) listDepth++;
      if (tag === "LI" && inline === 0) {
        flush();
        pre = "  ".repeat(Math.max(0, listDepth - 1)) + "- ";
        for (const k of kids(el)) walk(k);
        flush();
        pre = "";
        if (list) listDepth--;
        return;
      }
      if (block) {
        if (inline === 0) flush();
        else cur += " ";
      } else if (INLINE_BOX.has(display)) cur += " ";
      for (const k of kids(el)) walk(k);
      if (block) {
        if (inline === 0) flush();
        else cur += " ";
      } else if (INLINE_BOX.has(display)) cur += " ";
      if (list) listDepth--;
    };

    let root = document.body || document.documentElement;
    if (opts.selector) {
      root = deepQuery(opts.selector);
      if (!root) throw new Error(`nothing on the page matches the selector ${q(opts.selector)}`);
    }
    if (root) walk(root);
    flush();
    const se = document.scrollingElement || document.documentElement;
    const focused = document.activeElement && document.activeElement !== document.body ? describe(document.activeElement) : null;
    return {
      text: lines.join("\n"),
      truncated: full,
      interactive: count,
      scroll: { y: Math.round(se.scrollTop), max: Math.max(0, Math.round(se.scrollHeight - innerHeight)) },
      viewport: { w: innerWidth, h: innerHeight },
      title: document.title,
      focused,
    };
  }

  /** querySelector that also looks into open shadow roots and same-site frames. */
  function deepQuery(sel, root) {
    root = root || document;
    let found = null;
    try {
      found = root.querySelector(sel);
    } catch {
      throw new Error(`bad CSS selector ${q(sel)}`);
    }
    if (found) return found;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const f = deepQuery(sel, el.shadowRoot);
        if (f) return f;
      }
      if (el.tagName === "IFRAME") {
        const d = frameDoc(el);
        if (d) {
          const f = deepQuery(sel, d);
          if (f) return f;
        }
      }
    }
    return null;
  }

  const visible = (el) => {
    const st = styleOf(el);
    return st.display !== "none" && st.visibility !== "hidden" && el.getClientRects().length > 0;
  };

  function allElements(root, out) {
    out = out || [];
    for (const el of root.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) allElements(el.shadowRoot, out);
      if (el.tagName === "IFRAME") {
        const d = frameDoc(el);
        if (d) allElements(d, out);
      }
    }
    return out;
  }

  function byText(text) {
    const want = clean(text).toLowerCase();
    if (!want) throw new Error("text: needs some text, e.g. text:Sign in");
    const els = allElements(document).filter((el) => roleOf(el) && visible(el));
    const named = els.map((el) => [el, nameOf(el).toLowerCase()]);
    const hit = named.find(([, n]) => n === want) || named.find(([, n]) => n.startsWith(want)) || named.find(([, n]) => n.includes(want));
    if (hit) return hit[0];
    // Plain text on the page (a menu entry without a role, a card title…).
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (clean(n.data).toLowerCase().includes(want) && n.parentElement && visible(n.parentElement)) return n.parentElement;
    }
    throw new Error(`nothing on the page shows the text ${q(text)}`);
  }

  /** @12 | css:<selector> | text:<visible text> → the element. */
  function resolve(target) {
    if (typeof target !== "string" || !target.trim()) throw new Error("target must be @N (from a snapshot), css:<selector> or text:<visible text>");
    const t = target.trim();
    const m = /^@(\d+)$/.exec(t);
    if (m) {
      const el = refs.get(Number(m[1]))?.deref();
      if (!el || !el.isConnected) throw new Error(`${t} is gone (the page changed since the snapshot). Take a new snapshot and use the new refs.`);
      return el;
    }
    if (t.startsWith("css:")) {
      const sel = t.slice(4).trim();
      // Prefer what the person can see: pages often keep hidden copies (mobile menus, collapsed search boxes).
      let all = [];
      try {
        all = [...document.querySelectorAll(sel)];
      } catch {
        throw new Error(`bad CSS selector ${q(sel)}`);
      }
      const el = all.find(visible) || all[0] || deepQuery(sel);
      if (!el) throw new Error(`nothing on the page matches ${t}`);
      return el;
    }
    if (t.startsWith("text:")) return byText(t.slice(5));
    throw new Error(`unknown target ${q(t)}: use @N (from a snapshot), css:<selector> or text:<visible text>`);
  }

  /** Offset of a frame's content inside the top page. */
  function frameOffset(el) {
    let x = 0;
    let y = 0;
    let win = el.ownerDocument.defaultView;
    while (win && win.frameElement) {
      const fe = win.frameElement;
      const r = fe.getBoundingClientRect();
      const fs = win.parent.getComputedStyle(fe);
      x += r.left + parseFloat(fs.borderLeftWidth) + parseFloat(fs.paddingLeft);
      y += r.top + parseFloat(fs.borderTopWidth) + parseFloat(fs.paddingTop);
      win = win.parent;
    }
    return { x, y };
  }

  function hitTest(x, y) {
    let doc = document;
    let hit = doc.elementFromPoint(x, y);
    let ox = 0;
    let oy = 0;
    while (hit && (hit.tagName === "IFRAME" || hit.tagName === "FRAME")) {
      const d = frameDoc(hit);
      if (!d) break;
      const r = hit.getBoundingClientRect();
      ox += r.left;
      oy += r.top;
      const inner = d.elementFromPoint(x - ox, y - oy);
      if (!inner) break;
      hit = inner;
    }
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x - ox, y - oy);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  /** Scroll the element into view and return the point to click, plus what (if anything) covers it. */
  function point(target) {
    const el = resolve(target);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rects = [...el.getClientRects()];
    const r = rects.find((x) => x.width >= 1 && x.height >= 1) || el.getBoundingClientRect();
    const what = describe(el);
    if (r.width < 1 || r.height < 1) return { x: null, y: null, what, reason: "it has no size on screen" };
    const off = frameOffset(el);
    let x = off.x + r.left + r.width / 2;
    let y = off.y + r.top + r.height / 2;
    x = Math.min(Math.max(x, 1), innerWidth - 2);
    y = Math.min(Math.max(y, 1), innerHeight - 2);
    const hit = hitTest(x, y);
    const label = el.tagName === "INPUT" && el.labels ? [...el.labels] : [];
    // Fine when the point hits the element, something inside it, its label, or a parent that takes its clicks.
    const ok = !!hit && (hit === el || el.contains(hit) || hit.contains(el) || label.some((l) => l === hit || l.contains(hit)));
    return { x: Math.round(x), y: Math.round(y), what, covered: ok ? null : describe(hit) };
  }

  /** Click without the mouse (for controls with no size on screen, e.g. a styled checkbox). */
  function clickDirect(target) {
    const el = resolve(target);
    el.click();
    return describe(el);
  }

  /** Focus a text field (or the field inside a wrapper) and select its contents, ready for typing over. */
  function prepareFill(target) {
    let el = resolve(target);
    if (el.tagName === "SELECT") return { kind: "select", what: describe(el) };
    if (el.tagName === "INPUT" && ["checkbox", "radio"].includes((el.type || "").toLowerCase())) return { kind: "check", what: describe(el) };
    if (el.tagName === "INPUT" && el.type === "file") return { kind: "file", what: describe(el) };
    if (!isTextInput(el) && !el.isContentEditable) {
      const inner = el.querySelector("input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable='true'],[contenteditable='']");
      if (!inner) throw new Error(`${describe(el)} is not a text field`);
      el = inner;
    }
    if (el.disabled || el.readOnly) throw new Error(`${describe(el)} is ${el.disabled ? "disabled" : "read-only"}`);
    if (!visible(el)) throw new Error(`${describe(el)} is not visible on the page (it may sit in a closed menu or panel): click what opens it first, then take a snapshot`);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    if (el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
      const d = el.ownerDocument;
      const range = d.createRange();
      range.selectNodeContents(el);
      const sel = d.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (typeof el.select === "function") {
      el.select();
    }
    refOf(el);
    return { kind: "text", what: describe(el), ref: `@${ids.get(el)}`, focused: el.ownerDocument.activeElement === el };
  }

  function valueOf(target) {
    const el = resolve(target);
    if (el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return clean(el.innerText);
    if (el.type === "password") return el.value ? "(filled)" : "";
    return el.value ?? clean(el.innerText);
  }

  function choose(target, wanted) {
    let el = resolve(target);
    if (el.tagName !== "SELECT") {
      const inner = el.querySelector("select");
      if (!inner) throw new Error(`${describe(el)} is not a dropdown (<select>). Click it, then click the option instead.`);
      el = inner;
    }
    const opts = [...el.options];
    const w = clean(String(wanted)).toLowerCase();
    const o =
      opts.find((x) => x.value === String(wanted)) ||
      opts.find((x) => clean(x.label || x.text).toLowerCase() === w) ||
      opts.find((x) => clean(x.text).toLowerCase().startsWith(w)) ||
      opts.find((x) => clean(x.text).toLowerCase().includes(w));
    if (!o) throw new Error(`${describe(el)} has no option ${q(String(wanted))}. Options: ${opts.slice(0, 40).map((x) => clean(x.text)).join(" | ")}`);
    if (o.disabled) throw new Error(`option ${q(clean(o.text))} is disabled`);
    el.focus();
    el.value = o.value;
    o.selected = true;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { what: describe(el), chosen: clean(o.text) };
  }

  function checkedOf(target) {
    const el = resolve(target);
    const input = el.tagName === "INPUT" ? el : el.querySelector("input[type=checkbox],input[type=radio]");
    if (input) return input.checked;
    const a = el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed");
    if (a === null) throw new Error(`${describe(el)} is not a checkbox, radio or switch`);
    return a === "true";
  }

  function scrollTo(where) {
    const se = document.scrollingElement || document.documentElement;
    if (where === "top") se.scrollTo({ top: 0, behavior: "instant" });
    else if (where === "bottom") se.scrollTo({ top: se.scrollHeight, behavior: "instant" });
    else resolve(where).scrollIntoView({ block: "center", behavior: "instant" });
    return { y: Math.round(se.scrollTop), max: Math.max(0, Math.round(se.scrollHeight - innerHeight)) };
  }

  function scrollInfo() {
    const se = document.scrollingElement || document.documentElement;
    return { y: Math.round(se.scrollTop), max: Math.max(0, Math.round(se.scrollHeight - innerHeight)) };
  }

  function exists(target) {
    try {
      if (typeof target === "string" && target.startsWith("text:")) {
        const want = clean(target.slice(5)).toLowerCase();
        return clean(document.body ? document.body.innerText : "").toLowerCase().includes(want);
      }
      const el = resolve(target);
      return visible(el);
    } catch {
      return false;
    }
  }

  // ── for the person using the board view ───────────────────────────────────
  /** A <select> under the pointer: its options, so the board can draw the dropdown (headless Chrome draws none). */
  function selectAt(x, y) {
    const hit = hitTest(x, y);
    const sel = hit && hit.closest && hit.closest("select");
    if (!sel || sel.multiple || sel.size > 1 || sel.disabled) return null;
    const r = sel.getBoundingClientRect();
    const off = frameOffset(sel);
    return {
      ref: `@${refOf(sel)}`,
      rect: { x: off.x + r.left, y: off.y + r.top, w: r.width, h: r.height },
      selected: sel.selectedIndex,
      options: [...sel.options].map((o) => ({ label: clean(o.text), disabled: o.disabled, group: o.parentElement && o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label : undefined })),
    };
  }

  function chooseIndex(ref, index) {
    const el = resolve(ref);
    if (el.tagName !== "SELECT") return false;
    el.focus();
    el.selectedIndex = index;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function cursorAt(x, y) {
    const hit = hitTest(x, y);
    if (!hit) return "default";
    const c = styleOf(hit).cursor;
    if (c && c !== "auto") return c;
    if (isTextInput(hit) || hit.isContentEditable) return "text";
    return "default";
  }

  function selectedText() {
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && typeof a.selectionStart === "number" && a.type !== "password") {
      return a.value.slice(a.selectionStart, a.selectionEnd);
    }
    return String(document.getSelection() || "");
  }

  globalThis.__ss = { snapshot, resolve, point, clickDirect, prepareFill, valueOf, choose, checkedOf, scrollTo, exists, selectAt, chooseIndex, cursorAt, selectedText, describe, scrollInfo };
})();
