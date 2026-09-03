/** Shapes of the immutable seed data. Nothing here describes refunds. */

export interface Customer {
  customer_id: string;
  name: string;
  email: string;
}

export interface OrderItem {
  item_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  return_status?: string;
}

export interface Shipping {
  carrier: string;
  tracking_number: string;
}

export interface Order {
  order_id: string;
  customer_id: string;
  status: string;
  currency: string;
  total: number;
  items: OrderItem[];
  shipping?: Shipping;
}
