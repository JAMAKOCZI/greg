/**
 * Lightweight GFM-ish markdown → safe HTML for Greg agent bubbles.
 * No raw HTML passthrough. Zero npm deps.
 */

const KEYWORDS = {
  js: "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return static super switch this throw try typeof var void while with yield async await of from as",
  ts: "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return static super switch this throw try typeof var void while with yield async await of from as type interface enum implements private public protected readonly abstract declare namespace module satisfies",
  jsx: "break case catch class const continue default do else export extends finally for function if import in let new return super switch this throw try typeof var while yield async await of from as",
  tsx: "break case catch class const continue default do else export extends finally for function if import in let new return super switch this throw try typeof var while yield async await of from as type interface enum",
  py: "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
  python: "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
  rs: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while yield",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while yield",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil",
  java: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null",
  sh: "if then else elif fi for while do done case esac in function select time until true false",
  bash: "if then else elif fi for while do done case esac in function select time until true false",
  json: "true false null",
  css: "important media supports keyframes from to",
  html: "",
  sql: "select from where and or not null as join left right inner outer on group by order limit insert into values update set delete create table index alter drop distinct having union all primary key foreign references",
};

/**
 * Escape for HTML text nodes / attributes.
 * @param {string} s
 */
export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * True when markdown is empty or only decorative (`---`, blank lines).
 * Used to drop hollow agent bubbles that paint as bare horizontal bars.
 * @param {unknown} md
 * @returns {boolean}
 */
export function isDecorativeOnlyMarkdown(md) {
  const lines = String(md ?? "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return true;
  return lines.every((l) => /^[-*_]{3,}$/.test(l));
}

/**
 * @param {string} md
 * @param {{ streaming?: boolean }} [opts]
 * @returns {string} HTML
 */
export function renderMarkdown(md, opts = {}) {
  const src = String(md ?? "").replace(/\r\n/g, "\n");
  if (!src) return "";

  const blocks = [];
  /** @type {string[]} */
  const codeStore = [];
  /** @type {string[]} */
  const tableStore = [];

  // Extract fenced code blocks first
  let text = src.replace(
    /^```([^\n`]*)\n([\s\S]*?)```/gm,
    (_m, lang, code) => {
      const i = codeStore.length;
      codeStore.push(
        renderCodeBlock(String(lang || "").trim(), code.replace(/\n$/, "")),
      );
      return `\n\n%%CODE${i}%%\n\n`;
    },
  );

  // Unclosed fence while streaming — show as pre
  if (opts.streaming) {
    text = text.replace(/^```([^\n`]*)\n([\s\S]*)$/m, (_m, lang, code) => {
      const i = codeStore.length;
      codeStore.push(
        renderCodeBlock(String(lang || "").trim(), code, { open: true }),
      );
      return `\n\n%%CODE${i}%%\n\n`;
    });
  }

  // Tables (GFM simple) — last row may omit trailing newline
  text = text.replace(
    /(?:^|\n)(\|[^\n]+\|(?:\n\|[^\n]+\|)+)/g,
    (m, tableBlock) => {
      const html = renderTable(tableBlock.trim());
      if (!html) return m;
      const i = tableStore.length;
      tableStore.push(html);
      return `\n\n%%TABLE${i}%%\n\n`;
    },
  );

  // Line-oriented parse so headings/lists work without blank lines between
  // (agents often emit "### Title\n- item" as one tight block).
  const lines = text.split("\n");
  /** @type {string[]} */
  let para = [];
  /** @type {string[]} */
  let listBuf = [];
  /** @type {string[]} */
  let quoteBuf = [];

  const flushPara = () => {
    if (!para.length) return;
    const body = para.join("\n").trim();
    para = [];
    if (!body) return;
    const html = body
      .split("\n")
      .map((line) => inlineMarkdown(line))
      .join("<br />\n");
    blocks.push(`<p class="md-p">${html}</p>`);
  };
  const flushList = () => {
    if (!listBuf.length) return;
    blocks.push(renderList(listBuf.join("\n")));
    listBuf = [];
  };
  const flushQuote = () => {
    if (!quoteBuf.length) return;
    const quote = quoteBuf.map((l) => l.replace(/^>\s?/, "")).join("\n");
    blocks.push(
      `<blockquote class="md-quote">${inlineMarkdown(quote)}</blockquote>`,
    );
    quoteBuf = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    const codeMatch = trimmed.match(/^%%CODE(\d+)%%$/);
    if (codeMatch) {
      flushAll();
      blocks.push(codeStore[Number(codeMatch[1])] || "");
      continue;
    }
    const tableMatch = trimmed.match(/^%%TABLE(\d+)%%$/);
    if (tableMatch) {
      flushAll();
      blocks.push(tableStore[Number(tableMatch[1])] || "");
      continue;
    }

    if (!trimmed) {
      flushAll();
      continue;
    }

    // Bare thematic breaks (`---`, `***`) become full-width <hr> bars in the
    // chat column — often the only thing between tools and look like empty
    // horizontal lines. Skip them; blank lines already separate sections.
    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushAll();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      blocks.push(
        `<h${level} class="md-h md-h${level}">${inlineMarkdown(heading[2])}</h${level}>`,
      );
      continue;
    }

    if (/^>\s?/.test(line) || (quoteBuf.length && /^>\s?/.test(trimmed))) {
      flushPara();
      flushList();
      quoteBuf.push(line);
      continue;
    }
    if (quoteBuf.length) flushQuote();

    if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
      flushPara();
      listBuf.push(line);
      continue;
    }
    // Continuation of list item (indented)
    if (listBuf.length && /^\s{2,}\S/.test(line)) {
      listBuf.push(line);
      continue;
    }
    if (listBuf.length) flushList();

    para.push(line);
  }
  flushAll();

  return blocks.join("\n");
}

/**
 * Fill a .md-body element; preserves role sibling.
 * @param {HTMLElement} bodyEl
 * @param {string} md
 * @param {{ streaming?: boolean }} [opts]
 */
export function setMarkdownBody(bodyEl, md, opts = {}) {
  bodyEl.innerHTML = renderMarkdown(md, opts);
  enhanceCodeBlocks(bodyEl);
}

/**
 * @param {HTMLElement} root
 */
function enhanceCodeBlocks(root) {
  for (const pre of root.querySelectorAll("pre.md-pre")) {
    if (pre.dataset.enhanced) continue;
    pre.dataset.enhanced = "1";
    const btn = pre.querySelector(".md-copy");
    if (!btn) continue;
    btn.addEventListener("click", async () => {
      const code = pre.querySelector("code")?.textContent || "";
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.textContent = "Copy";
        }, 1200);
      } catch {
        btn.textContent = "Failed";
        setTimeout(() => {
          btn.textContent = "Copy";
        }, 1200);
      }
    });
  }
}

// ── blocks ────────────────────────────────────────────────────────────

/**
 * @param {string} lang
 * @param {string} code
 * @param {{ open?: boolean }} [opts]
 */
function renderCodeBlock(lang, code, opts = {}) {
  const label = lang || "code";
  const highlighted = highlightCode(code, lang);
  const openNote = opts.open
    ? `<span class="md-code-open">streaming…</span>`
    : "";
  return `<pre class="md-pre" data-lang="${escapeHtml(label)}"><div class="md-code-head"><span class="md-code-lang">${escapeHtml(label)}</span>${openNote}<button type="button" class="md-copy" title="Copy code">Copy</button></div><code class="md-code language-${escapeHtml(label)}">${highlighted}</code></pre>`;
}

/**
 * @param {string} block
 */
function renderTable(block) {
  const rows = block
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  if (rows.length < 2) return null;

  const split = (row) =>
    row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const header = split(rows[0]);
  const sep = rows[1];
  if (!/^\|?[\s:|-]+\|[\s:|-]+/.test(sep) && !/^[\s:|-]+$/.test(sep.replace(/\|/g, ""))) {
    // not a table separator
    if (!sep.includes("---")) return null;
  }

  const bodyRows = rows.slice(2).map(split);
  let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
  for (const h of header) {
    html += `<th>${inlineMarkdown(h)}</th>`;
  }
  html += "</tr></thead><tbody>";
  for (const row of bodyRows) {
    html += "<tr>";
    for (let i = 0; i < header.length; i++) {
      html += `<td>${inlineMarkdown(row[i] ?? "")}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table></div>";
  return html;
}

/**
 * @param {string} text
 */
function renderList(text) {
  const lines = text.split("\n");
  const ordered = /^\d+\.\s/.test(lines[0].trim());
  const tag = ordered ? "ol" : "ul";
  let html = `<${tag} class="md-list">`;
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (m) html += `<li>${inlineMarkdown(m[1])}</li>`;
    else if (line.trim()) html += `<li>${inlineMarkdown(line.trim())}</li>`;
  }
  html += `</${tag}>`;
  return html;
}

// ── inline ────────────────────────────────────────────────────────────

/**
 * @param {string} text
 */
function inlineMarkdown(text) {
  let s = escapeHtml(text);

  // inline code first (protect from other transforms)
  /** @type {string[]} */
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    const i = codes.length;
    codes.push(
      `<code class="md-inline-code">${code}</code>`, // already escaped
    );
    return `%%IC${i}%%`;
  });

  // bold / italic
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/_([^_]+)_/g, "<em>$1</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // links [text](url)
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );

  // bare urls
  s = s.replace(
    /(?<!["'=])(https?:\/\/[^\s<]+)/g,
    '<a class="md-link" href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );

  s = s.replace(/%%IC(\d+)%%/g, (_m, i) => codes[Number(i)] || "");
  return s;
}

// ── highlight ─────────────────────────────────────────────────────────

/**
 * @param {string} code
 * @param {string} lang
 */
export function highlightCode(code, lang) {
  const raw = String(code);
  const key = normalizeLang(lang);
  const kw = KEYWORDS[key];
  if (!kw && key !== "json" && key !== "html" && key !== "css" && key !== "diff") {
    return escapeHtml(raw);
  }

  // Tokenize roughly: strings, comments, then keywords/numbers
  const tokens = [];
  let i = 0;
  const push = (type, value) => {
    if (value) tokens.push({ type, value });
  };

  while (i < raw.length) {
    // line comment
    if (
      (key === "js" ||
        key === "ts" ||
        key === "jsx" ||
        key === "tsx" ||
        key === "rs" ||
        key === "rust" ||
        key === "go" ||
        key === "java" ||
        key === "css") &&
      raw.startsWith("//", i)
    ) {
      const end = raw.indexOf("\n", i);
      const endIdx = end === -1 ? raw.length : end;
      push("comment", raw.slice(i, endIdx));
      i = endIdx;
      continue;
    }
    if (
      (key === "py" || key === "python" || key === "sh" || key === "bash") &&
      raw[i] === "#" &&
      (i === 0 || raw[i - 1] === "\n" || /\s/.test(raw[i - 1]))
    ) {
      const end = raw.indexOf("\n", i);
      const endIdx = end === -1 ? raw.length : end;
      push("comment", raw.slice(i, endIdx));
      i = endIdx;
      continue;
    }
    // block comment
    if (raw.startsWith("/*", i)) {
      const end = raw.indexOf("*/", i + 2);
      const endIdx = end === -1 ? raw.length : end + 2;
      push("comment", raw.slice(i, endIdx));
      i = endIdx;
      continue;
    }
    // strings
    if (raw[i] === '"' || raw[i] === "'" || raw[i] === "`") {
      const q = raw[i];
      let j = i + 1;
      while (j < raw.length) {
        if (raw[j] === "\\") {
          j += 2;
          continue;
        }
        if (raw[j] === q) {
          j++;
          break;
        }
        j++;
      }
      push("string", raw.slice(i, j));
      i = j;
      continue;
    }
    // word
    if (/[A-Za-z_$]/.test(raw[i])) {
      let j = i + 1;
      while (j < raw.length && /[A-Za-z0-9_$]/.test(raw[j])) j++;
      const word = raw.slice(i, j);
      const kwSet = new Set((kw || "").split(/\s+/).filter(Boolean));
      if (kwSet.has(word)) push("keyword", word);
      else push("plain", word);
      i = j;
      continue;
    }
    // number
    if (/[0-9]/.test(raw[i])) {
      let j = i + 1;
      while (j < raw.length && /[0-9.xXa-fA-F_]/.test(raw[j])) j++;
      push("number", raw.slice(i, j));
      i = j;
      continue;
    }
    // punct / other
    push("plain", raw[i]);
    i++;
  }

  return tokens
    .map((t) => {
      const e = escapeHtml(t.value);
      if (t.type === "plain") return e;
      return `<span class="md-tok md-tok-${t.type}">${e}</span>`;
    })
    .join("");
}

/**
 * @param {string} lang
 */
function normalizeLang(lang) {
  const l = String(lang || "")
    .toLowerCase()
    .trim();
  if (l === "javascript" || l === "mjs" || l === "cjs") return "js";
  if (l === "typescript") return "ts";
  if (l === "shell" || l === "zsh" || l === "shellscript") return "bash";
  if (l === "yml") return "yaml";
  return l;
}
