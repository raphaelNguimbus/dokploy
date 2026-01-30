ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "customImageName" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "customImageTags" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "autoVersionFromJson" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "internalHttps" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "enableLogRotation" boolean DEFAULT false NOT NULL;