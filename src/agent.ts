/**
 * Customer-support agent: a mock tool-calling loop.
 *
 * `plan()` stands in for the model. Each iteration it looks at the parsed
 * message plus the observations gathered so far and either emits one more
 * tool call or a final answer. Nothing is invented in the synthesis step --
 * every fact in the reply traces to a tool observation.
 */
import {
  callTool,
  type RefundRecord,
  type RefundScope,
  type ToolCall,
  type ToolContext,
  type ToolObservation,
} from "./tools.ts";
import type { Customer, Order, Shipping } from "./types.ts";

const MAX_STEPS = 8;

export type Intent = "order_status" | "refund" | "list_orders" | "unknown";

export interface AgentRequest {
  message: string;
  authenticated_customer_id: string;
}

export interface TraceEntry {
  step: number;
  call: ToolCall;
  outcome: "ok" | `error:${string}`;
  detail?: string;
}

export interface AgentResponse {
  reply: string;
  intent: Intent;
  trace: TraceEntry[];
  /** Present when a refund was recorded, for assertions and inspection. */
  refund: RefundRecord | null;
}

// --- message parsing (stand-in for model intent extraction) -------------

interface Parsed {
  raw: string;
  intent: Intent;
  order_id: string | null;
  /** A monetary figure asserted by the user. Recorded, never trusted. */
  claimed_amount: number | null;
}

const REFUND_WORDS = /\b(refund|money back|reimburse|reimbursement|credit me|my money)\b/i;
const STATUS_WORDS = /\b(where|status|tracking|track|arrive|arriving|deliver(y|ed)?|shipp(ed|ing))\b/i;
const LIST_WORDS = /\b(my orders|all orders|order history|what have i (bought|ordered))\b/i;

function parse(message: string): Parsed {
  const orderMatch = message.match(/\bORD-\d+\b/i);

  // Only figures carrying a currency marker count as monetary claims, so
  // order numbers and quantities are not mistaken for amounts.
  const amountMatch = message.match(
    /(?:€|eur\s*)(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur\b)/i,
  );
  const rawAmount = amountMatch?.[1] ?? amountMatch?.[2] ?? null;

  let intent: Intent = "unknown";
  if (REFUND_WORDS.test(message)) intent = "refund";
  else if (STATUS_WORDS.test(message)) intent = "order_status";
  else if (LIST_WORDS.test(message)) intent = "list_orders";

  return {
    raw: message,
    intent,
    order_id: orderMatch ? orderMatch[0].toUpperCase() : null,
    claimed_amount: rawAmount ? Number(rawAmount.replace(",", ".")) : null,
  };
}

const WHOLE_ORDER_WORDS = /\b(whole|entire|full|in full|everything|all items|all of it)\b/i;

/**
 * Work out what a refund should cover, using the order's real item names.
 * Returns null when the message names no item we can match and does not ask
 * for the whole order -- the agent then asks instead of assuming a scope.
 */
function resolveScope(order: Order, message: string): RefundScope | null {
  const haystack = message.toLowerCase();
  const hit = order.items.find((i) => haystack.includes(i.name.toLowerCase()));
  if (hit) return { kind: "item", query: hit.name };
  if (WHOLE_ORDER_WORDS.test(message)) return { kind: "whole_order" };
  return null;
}

// --- loop state ---------------------------------------------------------

interface State {
  profile: Customer | null;
  profileTried: boolean;
  order: Order | null;
  orderDenied: boolean;
  myOrders: readonly Order[] | null;
  tracking: (Shipping & { order_id: string; status: string }) | null;
  trackingFailed: boolean;
  refund: RefundRecord | null;
  refundError: string | null;
}

type Action = { type: "call"; call: ToolCall } | { type: "final" };

function plan(p: Parsed, s: State): Action {
  // Always establish who is asking, scoped to the authenticated id.
  if (!s.profileTried) return { type: "call", call: { name: "get_my_profile", args: {} } };

  if (p.intent === "refund") {
    if (!p.order_id) {
      if (!s.myOrders) return { type: "call", call: { name: "list_my_orders", args: {} } };
      return { type: "final" };
    }
    if (!s.order && !s.orderDenied) {
      return { type: "call", call: { name: "get_order", args: { order_id: p.order_id } } };
    }
    if (s.order && !s.refund && !s.refundError) {
      const scope = resolveScope(s.order, p.raw);
      // Ambiguous scope is a question, not a guess.
      if (!scope) return { type: "final" };
      return {
        type: "call",
        call: {
          name: "record_refund",
          args: { order_id: s.order.order_id, scope, claimed_amount: p.claimed_amount },
        },
      };
    }
    return { type: "final" };
  }

  if (p.intent === "order_status") {
    if (!p.order_id) {
      if (!s.myOrders) return { type: "call", call: { name: "list_my_orders", args: {} } };
      return { type: "final" };
    }
    if (!s.order && !s.orderDenied) {
      return { type: "call", call: { name: "get_order", args: { order_id: p.order_id } } };
    }
    if (s.order?.shipping && !s.tracking && !s.trackingFailed) {
      return {
        type: "call",
        call: { name: "get_shipment_tracking", args: { order_id: s.order.order_id } },
      };
    }
    return { type: "final" };
  }

  // list_orders and unknown: show what the customer actually has.
  if (!s.myOrders) return { type: "call", call: { name: "list_my_orders", args: {} } };
  return { type: "final" };
}

function absorb(s: State, obs: ToolObservation): void {
  switch (obs.name) {
    case "get_my_profile":
      s.profileTried = true;
      if (obs.result.ok) s.profile = obs.result.data;
      break;
    case "list_my_orders":
      if (obs.result.ok) s.myOrders = obs.result.data.orders;
      break;
    case "get_order":
      if (obs.result.ok) s.order = obs.result.data;
      else s.orderDenied = true;
      break;
    case "get_shipment_tracking":
      if (obs.result.ok) s.tracking = obs.result.data;
      else s.trackingFailed = true;
      break;
    case "record_refund":
      if (obs.result.ok) s.refund = obs.result.data;
      else s.refundError = obs.result.detail;
      break;
  }
}

// --- response synthesis -------------------------------------------------

const SYMBOLS: Record<string, string> = { EUR: "€", GBP: "£", USD: "$" };
const fmt = (amount: number, currency: string): string =>
  `${SYMBOLS[currency] ?? currency + " "}${amount.toFixed(2)}`;

const STATUS_TEXT: Record<string, string> = {
  in_transit: "on its way to you",
  delivered: "delivered",
  returned: "returned",
};

function greet(s: State): string {
  return s.profile ? `Hi ${s.profile.name.split(" ")[0]},` : "Hi,";
}

function orderList(orders: readonly Order[]): string {
  return orders
    .map((o) => `  - ${o.order_id}: ${fmt(o.total, o.currency)}, ${STATUS_TEXT[o.status] ?? o.status}`)
    .join("\n");
}

function synthesize(p: Parsed, s: State): string {
  const hi = greet(s);

  // Not found / not yours -- deliberately indistinguishable.
  if (s.orderDenied) {
    return `${hi} I can't find an order ${p.order_id} on your account, so I'm not able to look it up. If you have the confirmation email, could you double-check the order number? I'm happy to go through the orders on your account instead.`;
  }

  if (s.refund) {
    const r = s.refund;
    const items = r.lines
      .map((l) => `${l.quantity} x ${l.item_name} at ${fmt(l.unit_price, r.currency)}`)
      .join(", ");
    const correction = r.claim_corrected
      ? ` You mentioned ${fmt(r.claimed_amount!, r.currency)}, but the price we have on record for that order is ${fmt(r.grounded_amount, r.currency)}, so that's the figure I've used.`
      : "";
    return `${hi} I've logged a refund request for ${r.order_id} (${r.refund_id}) covering ${items}, for a total of ${fmt(r.grounded_amount, r.currency)}.${correction} You'll get a confirmation once it's been processed.`;
  }

  // Refund intent on a real order, but nothing was recorded: either the named
  // item is not on the order, or no scope could be determined. Ask.
  if (p.intent === "refund" && s.order) {
    const o = s.order;
    const names = o.items.map((i) => `${i.name} (${fmt(i.unit_price, o.currency)})`).join(", ");
    return `${hi} I couldn't match that to an item on ${o.order_id}. That order contains: ${names}. Which of those would you like refunded, or would you like the whole order?`;
  }

  if (s.tracking) {
    const t = s.tracking;
    return `${hi} order ${t.order_id} is ${STATUS_TEXT[t.status] ?? t.status}. It's with ${t.carrier}, tracking number ${t.tracking_number}, so you can follow it directly with them. Anything else I can check?`;
  }

  if (s.order) {
    const o = s.order;
    const noTracking = s.trackingFailed ? " I don't have a tracking record against it." : "";
    return `${hi} order ${o.order_id} (${fmt(o.total, o.currency)}) is currently ${STATUS_TEXT[o.status] ?? o.status}.${noTracking} Let me know if you'd like anything else on it.`;
  }

  if (s.myOrders) {
    if (s.myOrders.length === 0) return `${hi} I don't see any orders on your account.`;
    const ask =
      p.intent === "refund"
        ? "Which of these would you like refunded?"
        : "Which one would you like me to look at?";
    return `${hi} here are the orders on your account:\n${orderList(s.myOrders)}\n${ask}`;
  }

  return `${hi} I wasn't able to look that up. Could you give me the order number?`;
}

// --- entry point --------------------------------------------------------

export function handleMessage(req: AgentRequest): AgentResponse {
  const ctx: ToolContext = { authenticated_customer_id: req.authenticated_customer_id };
  const p = parse(req.message);
  const s: State = {
    profile: null,
    profileTried: false,
    order: null,
    orderDenied: false,
    myOrders: null,
    tracking: null,
    trackingFailed: false,
    refund: null,
    refundError: null,
  };
  const trace: TraceEntry[] = [];

  for (let step = 1; step <= MAX_STEPS; step++) {
    const action = plan(p, s);
    if (action.type === "final") break;

    const obs = callTool(ctx, action.call);
    trace.push({
      step,
      call: action.call,
      outcome: obs.result.ok ? "ok" : `error:${obs.result.error}`,
      detail: obs.result.ok ? undefined : obs.result.detail,
    });
    absorb(s, obs);
  }

  return { reply: synthesize(p, s), intent: p.intent, trace, refund: s.refund };
}
