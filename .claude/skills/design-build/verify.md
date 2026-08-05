# Verification recipes

Copy-paste measurement passes for Phase 3 of `design-build`. Run them through
Chrome DevTools MCP (`evaluate_script`) against two pages: the rendered design
and the running app.

```bash
# reference: the design handoff, live
cd <handoff>/project && python3 -m http.server 5310

# subject: the app
npm run dev -- --port 5320
```

Open both, then measure. The design page is authoritative for every number.

---

## 1. Geometry

Extract from the **design** first — never hand-type expected values from
reading CSS, and beware ambiguous selectors (in the Canopy handoff `.pt` is
both a pane tab *and* a service-chip port; scope to `.ptabs .pt`).

```js
() => {
  const g = (sel, ...props) => {
    const el = document.querySelector(sel);
    if (!el) return `${sel}: absent`;
    const c = getComputedStyle(el);
    return Object.fromEntries(props.map(p => [p, c[p]]));
  };
  return {
    bar:  g('.wtbar', 'height', 'paddingLeft'),
    chip: g('.svc', 'height', 'paddingLeft', 'gap', 'borderRadius'),
    // …one entry per element you implemented
  };
}
```

Then assert in the **app**, tolerating sub-pixel noise:

```js
() => {
  const DESIGN = { '.cxs-wtbar': {height:'36px', paddingLeft:'10px'} /* … */ };
  const bad = [];
  for (const [sel, want] of Object.entries(DESIGN)) {
    const el = document.querySelector(sel);
    if (!el) { bad.push(`${sel} NOT RENDERED`); continue; }
    const c = getComputedStyle(el);
    for (const [p, exp] of Object.entries(want))
      if (Math.abs(parseFloat(c[p]) - parseFloat(exp)) >= 0.6)
        bad.push(`${sel}{${p}} design ${exp} ours ${c[p]}`);
  }
  return bad.length ? bad : 'ALL MATCH';
}
```

**`NOT RENDERED` is a failure, not a pass.** Force the surface open first.

### Stated alignment rules

Per-element numbers can all pass while a stated rule breaks. Assert the rule
itself:

```js
() => {
  const px = s => getComputedStyle(document.querySelector(s)).paddingLeft;
  const g = ['.cxs-wtbar','.cxs-rail','.cx-tabs','.cxs-ltool','.cx-log'].map(px);
  return new Set(g).size === 1 ? `aligned at ${g[0]}` : `MISALIGNED: ${g}`;
}
```

---

## 2. Inventory

**The pass that catches missing content.** Walk every flow in the design,
capture what each surface renders, then do the same in the app and compare
lists — not counts.

```js
async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  for (const f of [...document.querySelectorAll('.flow')]) {
    f.click(); await sleep(450);
    const m = document.querySelector('.mod');       // app: '.cx-modal'
    if (!m) continue;
    out[f.textContent.trim()] = {
      title:        m.querySelector('.mt b')?.textContent,
      width:        getComputedStyle(m).width,
      footButtons:  [...m.querySelectorAll('.mf .btn')].map(b => b.textContent.trim()),
      footHint:     m.querySelector('.mf .hint')?.textContent.trim(),
      sectionLabels:[...m.querySelectorAll('.flab')].map(l => l.textContent.trim()),
      checkboxes:   [...m.querySelectorAll('.chk .ct b')].map(b => b.textContent.trim()),
      actionRows:   [...m.querySelectorAll('.act-i')].map(b => b.textContent.trim()),
      kvKeys:       [...m.querySelectorAll('.kv dt')].map(d => d.textContent.trim()),
      steps:        [...m.querySelectorAll('.step .tx')].map(s => s.textContent.trim()),
      inputs:       m.querySelectorAll('input,textarea,select').length,
    };
  }
  return out;
}
```

Menus and popovers need the same treatment — count **rows and separators**:

```js
() => {
  const pop = document.querySelector('.cx-pop[role="menu"]');
  return {
    width: Math.round(pop.getBoundingClientRect().width),
    separators: pop.querySelectorAll('.cx-pop__sep').length,
    items: [...pop.querySelectorAll('.cx-pop__item')].map(b => b.textContent.trim()),
  };
}
```

> A dialog that will not close wedges this walk and every later surface reports
> the stuck one's contents. If several results look identical, suspect that
> before suspecting the app.

---

## 3. Tokens

Declared-vs-present:

```bash
cat <handoff>/tokens/*.css | grep -oE "^\s*--[a-z0-9-]+:" | tr -d ' :' | sort -u > /tmp/d.txt
grep -oE "^\s*--[a-z0-9-]+:" src/styles/tokens.css | tr -d ' :' | sort -u > /tmp/o.txt
comm -23 /tmp/d.txt /tmp/o.txt          # missing from ours
```

Resolution — a `var()` typo falls back silently, so prove they resolve:

```js
() => {
  const rs = getComputedStyle(document.documentElement);
  return ['--sp-row','--fs-body','--h-ib','--r-md','--action-primary']
    .filter(v => !rs.getPropertyValue(v).trim());   // empty array = all resolve
}
```

Literal audit — run before making any claim about coverage:

```bash
grep -ohE "rgba?\([0-9., ]+\)|#[0-9a-fA-F]{3,8}\b" src/styles/*.css | sort | uniq -c
grep -nE "^\s+[a-z-]+: *[^;]*[0-9]+px" src/styles/canopy-shell.css | grep -v "var(--"
```

---

## 4. Interaction

Existence is not usability.

```js
// visible, not merely present — a clipped menu still "opens"
() => {
  const el = document.querySelector('.cx-pop[role="menu"]');
  const r = el.getBoundingClientRect();
  const hit = (x,y) => { const t = document.elementFromPoint(x,y); return !!t && el.contains(t); };
  return hit(r.left+4, r.top+4) && hit(r.right-4, r.bottom-4) && hit(r.left+r.width/2, r.bottom-4);
}
```

```js
// a trigger must be able to close what it opened
async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t = document.querySelector('.cxs-attn');
  t.click(); await sleep(300);
  const opened = !!document.querySelector('.cxs-attnpop');
  t.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); t.click(); await sleep(300);
  return { opened, closes: !document.querySelector('.cxs-attnpop') };
}
```

```js
// keyboard reveals and inert regions
() => ({
  rowActionsOnFocus: (() => {
    const r = document.querySelector('.cxs-rowact');
    const before = getComputedStyle(r).opacity;
    r.querySelector('button')?.focus();
    return before === '0' && getComputedStyle(r).opacity === '1';
  })(),
  collapsedIsInert: document.querySelector('.cxs-side.is-hidden')?.hasAttribute('inert'),
})
```

Cross-target actions — prove the effect landed **and did not leak**:

```js
// act on worktree B while A is selected; B gains the session, A gains nothing
```

---

## Reporting

State what you measured **and what you did not**. "The modals match" is only
true for the properties in your spec and the surfaces you could open. Name the
dialogs you could not reach and why.

Two apparent mismatches are usually the test, not the code — check the design
before fixing: modifier-driven sizes (`narrow` → 440px) and deliberate
per-instance overrides (a title input at `--fs-md`).
