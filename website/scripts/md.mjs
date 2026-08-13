// A small Markdown renderer for this site. Deliberately a subset — everything
// the content uses and nothing else, so there is no dependency to install and
// no surprising behaviour to debug.
//
// Supported:
//   # ## ### ####            headings (h2/h3 get ids + anchor links, and feed the TOC)
//   paragraphs, --- rules
//   - / * bullets, 1. ordered (one nesting level, two spaces)
//   | a | b |                tables with a --- separator row
//   ```lang … ```            fenced code, escaped, with a language label
//   > quote
//   :::note|tip|warn|danger  callouts, optional title after the type, closed by :::
//   !shot slug | caption     theme-aware screenshot figure
//   inline: `code`  **bold**  *italic*  [text](href)

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// Placeholder for an extracted code span. Uses a private-use character that
// cannot occur in the content, so ordinary prose ("in 3 places") is never
// mistaken for one.
const MARK = "";

/** Inline formatting. Code spans are extracted first so their contents are never
    re-parsed as bold/italic/links. */
function inline(src) {
  const codes = [];
  let s = src.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return MARK + (codes.length - 1) + MARK;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
    const ext = /^https?:/.test(href);
    return `<a href="${href}"${ext ? ' target="_blank" rel="noreferrer noopener"' : ""}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(new RegExp(MARK + "(\\d+)" + MARK, "g"), (_m, i) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

const CALLOUT_TITLES = { note: "Note", tip: "Tip", warn: "Important", danger: "Warning" };

/**
 * @param {string} src markdown body (frontmatter already stripped)
 * @param {(slug: string, caption: string) => string} renderShot
 * @returns {{ html: string, toc: {id:string,text:string,level:number}[], title: string }}
 */
export function render(src, renderShot, ids = new Set()) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const toc = [];
  let title = "";
  let i = 0;

  const uniqueId = (text) => {
    const base = slugify(text) || "section";
    let id = base;
    let n = 2;
    while (ids.has(id)) id = `${base}-${n++}`;
    ids.add(id);
    return id;
  };

  const isUl = (l) => /^[-*]\s+/.test(l);
  const isOl = (l) => /^\d+\.\s+/.test(l);
  const isSubUl = (l) => /^\s{2,}[-*]\s+/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // fenced code
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      out.push(
        `<div class="code"${lang ? ` data-lang="${esc(lang)}"` : ""}><pre><code>${esc(body.join("\n"))}</code></pre></div>`,
      );
      continue;
    }

    // callout
    const co = line.match(/^:::(note|tip|warn|danger)\s*(.*)$/);
    if (co) {
      const [, kind, rest] = co;
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(":::")) body.push(lines[i++]);
      i++;
      const inner = render(body.join("\n"), renderShot, ids).html;
      out.push(
        `<aside class="callout callout--${kind}"><p class="callout__t">${esc(rest || CALLOUT_TITLES[kind])}</p>${inner}</aside>`,
      );
      continue;
    }

    // screenshot
    const shot = line.match(/^!shot\s+([\w-]+)\s*(?:\|\s*(.*))?$/);
    if (shot) {
      out.push(renderShot(shot[1], shot[2] ? shot[2].trim() : ""));
      i++;
      continue;
    }

    // rule
    if (/^---+$/.test(line.trim())) {
      out.push("<hr />");
      i++;
      continue;
    }

    // raw HTML block — passed through verbatim until a blank line. Without this
    // a hand-written block (the home page's card grid) is escaped and rendered
    // as its own source.
    if (/^<(div|details|section|aside|figure|table|ul|ol|p|iframe)\b/.test(line.trim())) {
      const body = [];
      while (i < lines.length && lines[i].trim()) body.push(lines[i++]);
      out.push(body.join("\n"));
      continue;
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 1) {
        title = text;
        out.push(`<h1>${inline(text)}</h1>`);
      } else {
        const id = uniqueId(text);
        if (level <= 3) toc.push({ id, text: text.replace(/`/g, ""), level });
        out.push(
          `<h${level} id="${id}">${inline(text)}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`,
        );
      }
      i++;
      continue;
    }

    // table
    if (line.trim().startsWith("|") && lines[i + 1] && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (row) =>
        row
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) body.push(cells(lines[i++]));
      out.push(
        `<div class="tablewrap"><table><thead><tr>${head
          .map((c) => `<th>${inline(c)}</th>`)
          .join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    // blockquote
    if (line.startsWith("> ")) {
      const body = [];
      while (i < lines.length && lines[i].startsWith("> ")) body.push(lines[i++].slice(2));
      out.push(`<blockquote>${render(body.join("\n"), renderShot, ids).html}</blockquote>`);
      continue;
    }

    // lists (one nesting level, two-space indent)
    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const items = [];
      while (i < lines.length) {
        if (isSubUl(lines[i])) {
          const sub = [];
          while (i < lines.length && isSubUl(lines[i])) sub.push(lines[i++].trim().replace(/^[-*]\s+/, ""));
          items[items.length - 1] += `<ul>${sub.map((s) => `<li>${inline(s)}</li>`).join("")}</ul>`;
          continue;
        }
        if (isUl(lines[i]) || isOl(lines[i])) {
          items.push(inline(lines[i++].replace(/^([-*]|\d+\.)\s+/, "")));
          continue;
        }
        // A lazy continuation: a non-blank line under an item that starts
        // nothing else. Without this, wrapping a long bullet across two source
        // lines split it into a list plus a stray paragraph.
        if (
          items.length &&
          lines[i].trim() &&
          !lines[i].startsWith("```") &&
          !lines[i].startsWith(":::") &&
          !lines[i].startsWith("!shot") &&
          !lines[i].startsWith("> ") &&
          !/^(#{1,4})\s/.test(lines[i]) &&
          !/^---+$/.test(lines[i].trim()) &&
          !lines[i].trim().startsWith("|") &&
          !lines[i].trim().startsWith("<")
        ) {
          items[items.length - 1] += " " + inline(lines[i++].trim());
          continue;
        }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${it}</li>`).join("")}</${tag}>`);
      continue;
    }

    // paragraph
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith(":::") &&
      !lines[i].startsWith("!shot") &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim()) &&
      !lines[i].startsWith("> ") &&
      !isUl(lines[i]) &&
      !isOl(lines[i]) &&
      !lines[i].trim().startsWith("|")
    ) {
      para.push(lines[i++]);
    }
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    else i++; // never stall

    continue;
  }

  return { html: out.join("\n"), toc, title };
}

/** Strip and parse `---` frontmatter. */
export function frontmatter(src) {
  if (!src.startsWith("---")) return { meta: {}, body: src };
  const end = src.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: src };
  const head = src.slice(4, end);
  const body = src.slice(end + 4).replace(/^\n/, "");
  const meta = {};
  for (const line of head.split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body };
}

export { esc, inline };
