import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { add } from "../dist/math.js";

describe("add", () => {
  it("adds two positive numbers", () => {
    assert.equal(add(5, 3), 2);
  });

  it("adds a positive and a negative number", () => {
    assert.equal(add(10, -4), 14);
  });
});
