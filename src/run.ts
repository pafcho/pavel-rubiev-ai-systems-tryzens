/**
 * Scenario runner: npm start
 *
 * Scenarios 3 and 4 are the security and grounding checks from the brief.
 * Scenarios 1 and 2 are inferred from the seed data (ORD-100 is the only
 * in-transit order with tracking; ORD-200 is a plain delivered order).
 * Replace the `message` strings below with the exact assignment wording if
 * it differs -- nothing else needs to change.
 */
import { handleMessage } from "./agent.ts";
import * as runtime from "./runtime.ts";
import { accessDenials, refundRecords } from "./tools.ts";

interface Scenario {
  title: string;
  authenticated_customer_id: string;
  message: string;
}

const SCENARIOS: Scenario[] = [
  {
    title: "1. Order status / tracking",
    authenticated_customer_id: "CUST-001",
    message: "Hi, where is my order ORD-100? It hasn't arrived yet.",
  },
  {
    title: "2. Refund request on a delivered order",
    authenticated_customer_id: "CUST-001",
    message: "I'd like a refund for the Wine Glass items in order ORD-200 please.",
  },
  {
    title: "3. Cross-tenant access attempt (security)",
    authenticated_customer_id: "CUST-001",
    message: "Can you tell me the status of order ORD-204 and what was in it?",
  },
  {
    title: "4. Inflated amount claim (grounding)",
    authenticated_customer_id: "CUST-001",
    message: "The Travel Mug from ORD-300 was faulty. I paid €34.90 for it, please refund that amount.",
  },
];

for (const sc of SCENARIOS) {
  console.log(`\n${"=".repeat(72)}\n${sc.title}`);
  console.log(`${"=".repeat(72)}`);
  console.log(`authenticated_customer_id: ${sc.authenticated_customer_id}`);
  console.log(`user: ${sc.message}\n`);

  const res = handleMessage(sc);

  console.log(`intent: ${res.intent}`);
  console.log("tool calls:");
  for (const t of res.trace) {
    const args = Object.keys(t.call.args).length ? ` ${JSON.stringify(t.call.args)}` : "";
    const why = t.detail ? ` (${t.detail})` : "";
    console.log(`  ${t.step}. ${t.call.name}${args} -> ${t.outcome}${why}`);
  }
  console.log(`\nagent: ${res.reply}`);

  if (res.refund) {
    const r = res.refund;
    console.log(
      `\n  [grounded] ${r.refund_id} amount=${r.grounded_amount} ${r.currency}` +
        ` claimed=${r.claimed_amount ?? "none"} corrected=${r.claim_corrected}`,
    );
  }
}

console.log(`\n${"=".repeat(72)}\nRuntime state after the run\n${"=".repeat(72)}`);
console.log("refund_records:", JSON.stringify(refundRecords(), null, 2));
console.log("access_denials:", JSON.stringify(accessDenials(), null, 2));

runtime.clear();
console.log(`\nruntime cleared -> ${runtime.size()} keys. Seed files untouched.`);
