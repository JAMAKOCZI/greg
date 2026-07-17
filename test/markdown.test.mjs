import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  highlightCode,
  renderMarkdown,
} from "../public/markdown.js";

describe("escapeHtml", () => {
  it("escapes angle brackets and ampersands", () => {
    assert.equal(escapeHtml("<script>&"), "&lt;script&gt;&amp;");
  });
});

describe("renderMarkdown", () => {
  it("renders paragraphs and bold", () => {
    const html = renderMarkdown("Hello **world**");
    assert.match(html, /<p class="md-p">/);
    assert.match(html, /<strong>world<\/strong>/);
  });

  it("renders fenced code with language", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    assert.match(html, /md-pre/);
    assert.match(html, /md-code-lang">js</);
    assert.match(html, /md-tok-keyword/);
    assert.match(html, /const/);
  });

  it("does not pass through raw HTML", () => {
    const html = renderMarkdown("Click <img src=x onerror=alert(1)>");
    assert.equal(html.includes("<img"), false);
    assert.match(html, /&lt;img/);
  });

  it("renders GFM tables", () => {
    const md = `| A | B |
| --- | --- |
| 1 | 2 |`;
    const html = renderMarkdown(md);
    assert.match(html, /<table class="md-table">/);
    assert.match(html, /<th>/);
    assert.match(html, /<td>/);
  });

  it("renders lists and headings", () => {
    const html = renderMarkdown("## Title\n\n- one\n- two");
    assert.match(html, /<h2 class="md-h md-h2">/);
    assert.match(html, /<ul class="md-list">/);
    assert.match(html, /<li>/);
  });

  it("renders ### headings without blank lines before lists", () => {
    const md = `### Poprawki treści i typografii
- item one
### HTML i dostępność
text
### CSS
more`;
    const html = renderMarkdown(md);
    assert.match(html, /<h3 class="md-h md-h3">Poprawki treści i typografii<\/h3>/);
    assert.match(html, /<h3 class="md-h md-h3">HTML i dostępność<\/h3>/);
    assert.match(html, /<h3 class="md-h md-h3">CSS<\/h3>/);
    assert.match(html, /<ul class="md-list">/);
  });

  it("renders inline code", () => {
    const html = renderMarkdown("Use `foo()` here");
    assert.match(html, /md-inline-code/);
    assert.match(html, /foo\(\)/);
  });
});

describe("highlightCode", () => {
  it("highlights js keywords and strings", () => {
    const h = highlightCode('const s = "hi";', "js");
    assert.match(h, /md-tok-keyword/);
    assert.match(h, /md-tok-string/);
  });
});
