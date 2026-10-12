ALTER TABLE "orders" ADD COLUMN "client_ip_hash" text;--> statement-breakpoint
CREATE INDEX "orders_ip_created_idx" ON "orders" USING btree ("client_ip_hash","created_at");