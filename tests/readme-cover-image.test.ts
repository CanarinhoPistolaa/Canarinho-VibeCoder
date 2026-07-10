import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const readmePath = resolve(__dirname, "..", "README.md");
const content = readFileSync(readmePath, "utf-8");

describe("README.md cover image", () => {
  it("has canarinho.png image after the # canarinho title", () => {
    // The image should appear right after the H1 title, before the tagline
    const titleIndex = content.indexOf("# Canarinho VibeCoder");
    assert.ok(titleIndex >= 0, "should have # Canarinho VibeCoder title");
    const afterTitle = content.slice(titleIndex);
    const imageIndex = afterTitle.indexOf("www/assets/canarinho.png");
    assert.ok(imageIndex >= 0, "should have canarinho.png image after title");
    const taglineIndex = afterTitle.indexOf("Build your agent team in");
    assert.ok(taglineIndex >= 0, "should have tagline after title");
    assert.ok(imageIndex < taglineIndex, "image should appear before tagline paragraph");
  });

  it("uses correct src path www/assets/canarinho.png", () => {
    assert.ok(
      content.includes('src="www/assets/canarinho.png"'),
      "image src should be www/assets/canarinho.png"
    );
  });

  it("has alt text 'canarinho logo' for accessibility", () => {
    assert.ok(
      content.includes('alt="Canarinho VibeCoder logo"'),
      "image should have alt='Canarinho VibeCoder logo'"
    );
  });

  it("renders at controlled size with width attribute", () => {
    // Should use a width attribute for size control (not 256px natural size)
    const imgTag = content.match(/<img[^>]*src="www\/assets\/canarinho\.png"[^>]*>/);
    assert.ok(imgTag, "should have img tag for canarinho.png");
    assert.ok(
      /width="18\d"/.test(imgTag[0]),
      "image should have width attribute between 180-189 (appropriate cover size)"
    );
  });

  it("has blank line before and after image for proper markdown rendering", () => {
    // Image should be surrounded by blank lines in the markdown source
    const lines = content.split("\n");
    const titleLineIdx = lines.findIndex(l => l === "# Canarinho VibeCoder");
    assert.ok(titleLineIdx >= 0, "should find # Canarinho VibeCoder title line");
    // Line after title should be blank
    assert.strictEqual(
      lines[titleLineIdx + 1],
      "",
      "blank line expected after # Canarinho VibeCoder title"
    );
    // Image line
    const imgLineIdx = lines.findIndex(l => l.includes('www/assets/canarinho.png'));
    assert.ok(imgLineIdx >= 0, "should find image line");
    assert.ok(
      imgLineIdx > titleLineIdx,
      "image should be after title"
    );
    // Line after image should be blank
    assert.strictEqual(
      lines[imgLineIdx + 1],
      "",
      "blank line expected after image for proper markdown rendering"
    );
  });

  it("image is centered using align='center'", () => {
    assert.ok(
      content.includes('align="center"'),
      "cover image should be centered"
    );
  });
});
