ALTER TABLE "application" ADD COLUMN "customImageName" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "customImageTags" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "autoVersionFromJson" boolean DEFAULT false NOT NULL;