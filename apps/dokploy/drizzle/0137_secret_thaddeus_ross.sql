ALTER TABLE "application" ADD COLUMN "customImageName" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "customImageTags" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "autoVersionFromJson" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "internalHttps" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "enableLogRotation" boolean DEFAULT false NOT NULL;