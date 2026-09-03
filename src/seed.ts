import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Customer, Order } from "./types.ts";

const SEED_DIR = join(import.meta.dirname, "..", "seed");

export const SEED_FILES = {
  customers: join(SEED_DIR, "customers.json"),
  orders: join(SEED_DIR, "orders.json"),
} as const;

/** Recursively freeze so the loaded seed cannot be mutated at runtime. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function load<T>(file: string): readonly T[] {
  return deepFreeze(JSON.parse(readFileSync(file, "utf8")) as T[]);
}

// Read once at import time. The files are never written to.
const customers = load<Customer>(SEED_FILES.customers);
const orders = load<Order>(SEED_FILES.orders);

export const listCustomers = (): readonly Customer[] => customers;

export const getCustomer = (customerId: string): Customer | undefined =>
  customers.find((c) => c.customer_id === customerId);

export const listOrders = (): readonly Order[] => orders;

export const getOrder = (orderId: string): Order | undefined =>
  orders.find((o) => o.order_id === orderId);

export const listOrdersByCustomer = (customerId: string): readonly Order[] =>
  orders.filter((o) => o.customer_id === customerId);
