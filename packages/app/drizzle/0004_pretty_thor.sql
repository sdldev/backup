CREATE TYPE "public"."backup_job_stage" AS ENUM('queued', 'connected', 'dumping', 'compressing', 'encrypting', 'uploading', 'verifying', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."backup_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."backup_job_trigger" AS ENUM('manual', 'scheduled');--> statement-breakpoint
CREATE TABLE "backup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"database_source_id" uuid NOT NULL,
	"trigger" "backup_job_trigger" NOT NULL,
	"requested_by_user_id" uuid,
	"status" "backup_job_status" DEFAULT 'queued' NOT NULL,
	"stage" "backup_job_stage" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"error_category" text,
	"user_error_message" text,
	"internal_error_ref" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"cancel_requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_database_source_id_database_sources_id_fk" FOREIGN KEY ("database_source_id") REFERENCES "public"."database_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_cancel_requested_by_user_id_users_id_fk" FOREIGN KEY ("cancel_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_jobs_workspace_id_idx" ON "backup_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "backup_jobs_database_source_id_idx" ON "backup_jobs" USING btree ("database_source_id");--> statement-breakpoint
CREATE INDEX "backup_jobs_created_at_idx" ON "backup_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_jobs_one_active_per_source_uidx" ON "backup_jobs" USING btree ("database_source_id") WHERE "backup_jobs"."status" in ('queued', 'running');