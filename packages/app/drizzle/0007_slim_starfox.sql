CREATE TYPE "public"."download_request_status" AS ENUM('created', 'used', 'expired');--> statement-breakpoint
CREATE TABLE "download_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"backup_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" "download_request_status" DEFAULT 'created' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "download_requests_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "download_requests" ADD CONSTRAINT "download_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_requests" ADD CONSTRAINT "download_requests_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_requests" ADD CONSTRAINT "download_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_requests" ADD CONSTRAINT "download_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "download_requests_workspace_id_idx" ON "download_requests" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "download_requests_backup_id_idx" ON "download_requests" USING btree ("backup_id");--> statement-breakpoint
CREATE INDEX "download_requests_expires_at_idx" ON "download_requests" USING btree ("expires_at");