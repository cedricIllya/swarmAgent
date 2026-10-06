ALTER TABLE "agents" ADD COLUMN "usage_cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "usage_prompt_tokens" bigint;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "usage_completion_tokens" bigint;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "usage_at" timestamp with time zone;
