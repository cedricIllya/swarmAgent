DROP INDEX "service_credentials_tenant_slug_idx";--> statement-breakpoint
ALTER TABLE "service_credentials" ADD COLUMN "agent_id" text;--> statement-breakpoint
UPDATE "service_credentials" c
SET "agent_id" = c."connected_by_agent_id"
FROM "agents" a
WHERE a."id" = c."connected_by_agent_id" AND a."tenant_id" = c."tenant_id";--> statement-breakpoint
UPDATE "service_credentials" c
SET "agent_id" = (
	SELECT a."id" FROM "agents" a
	WHERE a."tenant_id" = c."tenant_id"
	ORDER BY (a."status" = 'running') DESC, a."created_at" ASC
	LIMIT 1
)
WHERE c."agent_id" IS NULL;--> statement-breakpoint
DELETE FROM "service_credentials" WHERE "agent_id" IS NULL;--> statement-breakpoint
ALTER TABLE "service_credentials" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_credentials_agent_slug_idx" ON "service_credentials" USING btree ("agent_id","slug");--> statement-breakpoint
CREATE INDEX "service_credentials_tenant_idx" ON "service_credentials" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "service_credentials" DROP COLUMN "connected_by_agent_id";
