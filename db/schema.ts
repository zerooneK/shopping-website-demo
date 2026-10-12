import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const conditionEnum = pgEnum("item_condition", [
  "like_new",
  "good",
  "fair",
]);
export const categoryEnum = pgEnum("item_category", [
  "fashion",
  "books",
  "home",
  "tech",
  "other",
]);
export const itemStatusEnum = pgEnum("item_status", [
  "available",
  "reserved",
  "sold",
  "hidden",
]);
export const deliveryMethodEnum = pgEnum("delivery_method", ["pickup", "post"]);
export const orderStatusEnum = pgEnum("order_status", [
  "pending_payment",
  "awaiting_review",
  "confirmed",
  "shipped",
  "completed",
  "rejected",
  "expired",
  "cancelled",
]);
export const actorEnum = pgEnum("event_actor", ["customer", "admin", "system"]);

export type ItemImage = {
  url: string;
  alt: string;
  credit?: { name: string; url: string };
};

export const items = pgTable(
  "items",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    // ตำหนิ: ห้ามว่าง (บังคับด้วย NOT NULL + CHECK ความยาว > 0)
    flaws: text("flaws").notNull(),
    condition: conditionEnum("condition").notNull(),
    category: categoryEnum("category").notNull(),
    price: integer("price").notNull(),
    images: jsonb("images").$type<ItemImage[]>().notNull().default([]),
    status: itemStatusEnum("status").notNull().default("available"),
    reservedUntil: timestamp("reserved_until", { withTimezone: true }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("items_status_idx").on(t.status),
    check("items_flaws_not_empty", sql`length(trim(${t.flaws})) > 0`),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    token: text("token").notNull().unique(),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id),
    amount: integer("amount").notNull(),
    shippingFee: integer("shipping_fee").notNull().default(0),
    customerName: text("customer_name").notNull(),
    phone: text("phone").notNull(),
    deliveryMethod: deliveryMethodEnum("delivery_method").notNull(),
    address: text("address"),
    note: text("note"),
    status: orderStatusEnum("status").notNull().default("pending_payment"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    slipPath: text("slip_path"),
    slipUploadedAt: timestamp("slip_uploaded_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    trackingNo: text("tracking_no"),
    rejectReason: text("reject_reason"),
    demoSessionId: text("demo_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("orders_status_created_idx").on(t.status, t.createdAt),
    index("orders_item_idx").on(t.itemId),
  ],
);

export const orderEvents = pgTable("order_events", {
  id: serial("id").primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  actor: actorEnum("actor").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderEvent = typeof orderEvents.$inferSelect;
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type ItemStatus = (typeof itemStatusEnum.enumValues)[number];
export type DeliveryMethod = (typeof deliveryMethodEnum.enumValues)[number];

