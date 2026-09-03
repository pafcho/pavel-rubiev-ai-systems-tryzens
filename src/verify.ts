/**
 * Environment check only. Verifies four things and nothing else:
 *   1. seed data loads
 *   2. temporary runtime data can be stored and read back
 *   3. temporary runtime state can be cleared
 *   4. the seed files on disk are unchanged
 *
 * Run with: npm run verify
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runtime, seed } from "./index.ts";

const fingerprint = () =>
  Object.entries(seed.SEED_FILES).map(
    ([name, file]) => `${name}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`,
  );

const before = fingerprint();

// 1. seed data loads
assert.equal(seed.listCustomers().length, 2, "expected 2 seed customers");
assert.equal(seed.listOrders().length, 4, "expected 4 seed orders");
assert.equal(seed.getCustomer("CUST-001")?.name, "Anna Petrova");
assert.equal(seed.getOrder("ORD-200")?.items.length, 2);
assert.equal(seed.listOrdersByCustomer("CUST-001").length, 3);
console.log("ok  seed data loads");

// 2. temporary runtime data can be stored and read
runtime.set("note", { any: "shape" });
assert.deepEqual(runtime.get("note"), { any: "shape" });
runtime.append("log", "first");
runtime.append("log", "second");
assert.deepEqual(runtime.list("log"), ["first", "second"]);
assert.equal(runtime.size(), 2);
console.log("ok  runtime data stored and read back");

// 3. temporary runtime state can be cleared
runtime.clear();
assert.equal(runtime.size(), 0);
assert.equal(runtime.get("note"), undefined);
assert.deepEqual(runtime.list("log"), []);
console.log("ok  runtime state cleared");

// 4. seed files unchanged
assert.deepEqual(fingerprint(), before, "seed files were modified");
console.log("ok  seed files unchanged");

console.log("\nEnvironment ready.");
