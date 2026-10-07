ALTER TABLE "service_credentials" ADD COLUMN "external_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "service_credentials_slug_external_idx" ON "service_credentials" USING btree ("slug","external_key");
