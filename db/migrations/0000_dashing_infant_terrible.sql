CREATE TYPE "public"."event_actor" AS ENUM('customer', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."item_category" AS ENUM('fashion', 'books', 'home', 'tech', 'other');--> statement-breakpoint
CREATE TYPE "public"."item_condition" AS ENUM('like_new', 'good', 'fair');--> statement-breakpoint
CREATE TYPE "public"."delivery_method" AS ENUM('pickup', 'post');--> statement-breakpoint
CREATE TYPE "public"."item_status" AS ENUM('available', 'reserved', 'sold', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'awaiting_review', 'confirmed', 'shipped', 'completed', 'rejected', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "items" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"flaws" text NOT NULL,
	"condition" "item_condition" NOT NULL,
	"category" "item_category" NOT NULL,
	"price" integer NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "item_status" DEFAULT 'available' NOT NULL,
	"reserved_until" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_code_unique" UNIQUE("code"),
	CONSTRAINT "items_flaws_not_empty" CHECK (length(trim("items"."flaws")) > 0)
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" "event_actor" NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"item_id" integer NOT NULL,
	"amount" integer NOT NULL,
	"shipping_fee" integer DEFAULT 0 NOT NULL,
	"customer_name" text NOT NULL,
	"phone" text NOT NULL,
	"delivery_method" "delivery_method" NOT NULL,
	"address" text,
	"note" text,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"slip_path" text,
	"slip_uploaded_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"tracking_no" text,
	"reject_reason" text,
	"demo_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_status_idx" ON "items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "orders_item_idx" ON "orders" USING btree ("item_id");