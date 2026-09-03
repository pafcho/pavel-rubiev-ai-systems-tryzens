/**
 * The tool layer: the ONLY door between the agent and the commerce data.
 *
 * Two invariants are enforced here rather than in the agent, so that no
 * amount of clever prompting or intent misparsing can get around them:
 *
 *   1. Tenant isolation. Every order-scoped tool resolves the order through
 *      `resolveOwnedOrder`, which requires the order to belong to the
 *      authenticated customer. A foreign order is reported as `not_found` --
 *      the same answer as a nonexistent one, so ownership cannot be probed.
 *
 *   2. Monetary grounding. Refund amounts are computed from the immutable
 *      seed unit prices. An amount claimed in the user's message is recorded
 *      as an unverified claim and never used as the amount.
 */
import * as runtime from "./runtime.ts";
import * as seed from "./seed.ts";
import type { Customer, Order, OrderItem, Shipping } from "./types.ts";

export interface ToolContext {
  /** Established by the surrounding session, never by the message text. */
  authenticated_customer_id: string;
}

export type ToolError = "not_found" | "invalid_request";

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: ToolError; detail: string };

const ok = <T>(data: T): ToolResult<T> => ({ ok: true, data });
const fail = <T>(error: ToolError, detail: string): ToolResult<T> => ({ ok: false, error, detail });

/** Runtime keys used by this layer. */
export const REFUNDS_KEY = "refund_records";
export const DENIALS_KEY = "access_denials";

// --- money -------------------------------------------------------------
// Integer cents throughout; only converted back for display/storage.
const cents = (amount: number): number => Math.round(amount * 100);
const money = (c: number): number => c / 100;

// --- the isolation choke point -----------------------------------------

/**
 * Resolve an order the authenticated customer is allowed to see.
 * Returns null for "does not exist" and for "belongs to someone else"
 * alike; denials are recorded to the runtime audit log.
 */
function resolveOwnedOrder(ctx: ToolContext, orderId: string): Order | null {
  const order = seed.getOrder(orderId);
  if (!order) return null;
  if (order.customer_id !== ctx.authenticated_customer_id) {
    runtime.append(DENIALS_KEY, {
      reason: "tenant_mismatch",
      order_id: orderId,
      authenticated_customer_id: ctx.authenticated_customer_id,
      owner_customer_id: order.customer_id,
      at: new Date().toISOString(),
    });
    return null;
  }
  return order;
}

// --- grounded refund records -------------------------------------------

/** Shape owned by the agent layer; the runtime store stays schema-free. */
export interface RefundRecord {
  refund_id: string;
  order_id: string;
  customer_id: string;
  order_status: string;
  currency: string;
  lines: { item_id: string; item_name: string; quantity: number; unit_price: number; line_total: number }[];
  /** Computed from seed unit prices. This is the authoritative amount. */
  grounded_amount: number;
  /** What the message asserted, if anything. Recorded, never trusted. */
  claimed_amount: number | null;
  /** True when a claim was present and disagreed with the grounded amount. */
  claim_corrected: boolean;
  recorded_at: string;
}

let refundSeq = 0;

/**
 * What a refund covers. Explicit by design: an unmatched item must never
 * widen into a whole-order refund, so "everything" has to be asked for.
 */
export type RefundScope = { kind: "whole_order" } | { kind: "item"; query: string };

function matchItems(order: Order, scope: RefundScope): OrderItem[] {
  if (scope.kind === "whole_order") return [...order.items];
  const q = scope.query.trim().toLowerCase();
  return order.items.filter(
    (i) => i.item_id.toLowerCase() === q || i.name.toLowerCase().includes(q),
  );
}

// --- tool surface ------------------------------------------------------

export type ToolCall =
  | { name: "get_my_profile"; args: Record<string, never> }
  | { name: "list_my_orders"; args: Record<string, never> }
  | { name: "get_order"; args: { order_id: string } }
  | { name: "get_shipment_tracking"; args: { order_id: string } }
  | {
      name: "record_refund";
      args: { order_id: string; scope: RefundScope; claimed_amount?: number | null };
    };

export type ToolObservation =
  | { name: "get_my_profile"; result: ToolResult<Customer> }
  | { name: "list_my_orders"; result: ToolResult<{ orders: readonly Order[] }> }
  | { name: "get_order"; result: ToolResult<Order> }
  | { name: "get_shipment_tracking"; result: ToolResult<{ order_id: string; status: string } & Shipping> }
  | { name: "record_refund"; result: ToolResult<RefundRecord> };

/** Dispatch a tool call. Every branch is tenant-scoped by construction. */
export function callTool(ctx: ToolContext, call: ToolCall): ToolObservation {
  switch (call.name) {
    case "get_my_profile": {
      const customer = seed.getCustomer(ctx.authenticated_customer_id);
      return {
        name: call.name,
        result: customer ? ok(customer) : fail("not_found", "no such customer"),
      };
    }

    case "list_my_orders":
      return {
        name: call.name,
        // Scoped by the authenticated id, not by any argument.
        result: ok({ orders: seed.listOrdersByCustomer(ctx.authenticated_customer_id) }),
      };

    case "get_order": {
      const order = resolveOwnedOrder(ctx, call.args.order_id);
      return {
        name: call.name,
        result: order
          ? ok(order)
          : fail("not_found", `no order ${call.args.order_id} on this account`),
      };
    }

    case "get_shipment_tracking": {
      const order = resolveOwnedOrder(ctx, call.args.order_id);
      if (!order) {
        return {
          name: call.name,
          result: fail("not_found", `no order ${call.args.order_id} on this account`),
        };
      }
      if (!order.shipping) {
        return {
          name: call.name,
          result: fail("not_found", `order ${order.order_id} has no shipment record`),
        };
      }
      return {
        name: call.name,
        result: ok({ order_id: order.order_id, status: order.status, ...order.shipping }),
      };
    }

    case "record_refund": {
      const { order_id, scope, claimed_amount } = call.args;
      const order = resolveOwnedOrder(ctx, order_id);
      if (!order) {
        return { name: call.name, result: fail("not_found", `no order ${order_id} on this account`) };
      }

      const items = matchItems(order, scope);
      if (items.length === 0) {
        const what = scope.kind === "item" ? `"${scope.query}"` : "any item";
        return {
          name: call.name,
          result: fail("invalid_request", `no item matching ${what} on ${order.order_id}`),
        };
      }

      // Grounding: the amount comes from seed unit prices only.
      const lines = items.map((i) => ({
        item_id: i.item_id,
        item_name: i.name,
        quantity: i.quantity,
        unit_price: i.unit_price,
        line_total: money(cents(i.unit_price) * i.quantity),
      }));
      const groundedCents = items.reduce((sum, i) => sum + cents(i.unit_price) * i.quantity, 0);

      const record: RefundRecord = {
        refund_id: `REF-${++refundSeq}`,
        order_id: order.order_id,
        customer_id: order.customer_id,
        order_status: order.status,
        currency: order.currency,
        lines,
        grounded_amount: money(groundedCents),
        claimed_amount: claimed_amount ?? null,
        claim_corrected: claimed_amount != null && cents(claimed_amount) !== groundedCents,
        recorded_at: new Date().toISOString(),
      };

      runtime.append(REFUNDS_KEY, record);
      return { name: call.name, result: ok(record) };
    }
  }
}

export const refundRecords = (): RefundRecord[] => runtime.list<RefundRecord>(REFUNDS_KEY);
export const accessDenials = (): unknown[] => runtime.list(DENIALS_KEY);
