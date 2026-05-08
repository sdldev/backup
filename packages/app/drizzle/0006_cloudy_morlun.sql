CREATE TYPE "public"."backup_format" AS ENUM('mysql_sql_gzip', 'postgres_custom');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('succeeded', 'deleted', 'expired');--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"database_source_id" uuid NOT NULL,
	"backup_job_id" uuid NOT NULL,
	"storage_config_id" uuid NOT NULL,
	"status" "backup_status" DEFAULT 'succeeded' NOT NULL,
	"format" "backup_format" NOT NULL,
	"object_key" text NOT NULL,
	"download_filename" text NOT NULL,
	"encrypted_size_bytes" bigint NOT NULL,
	"original_size_bytes" bigint,
	"checksum_sha256" text,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_database_source_id_database_sources_id_fk" FOREIGN KEY ("database_source_id") REFERENCES "public"."database_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_backup_job_id_backup_jobs_id_fk" FOREIGN KEY ("backup_job_id") REFERENCES "public"."backup_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_storage_config_id_backup_storage_configs_id_fk" FOREIGN KEY ("storage_config_id") REFERENCES "public"."backup_storage_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backups_workspace_id_idx" ON "backups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "backups_database_source_id_idx" ON "backups" USING btree ("database_source_id");--> statement-breakpoint
CREATE INDEX "backups_backup_job_id_idx" ON "backups" USING btree ("backup_job_id");--> statement-breakpoint
CREATE INDEX "backups_created_at_idx" ON "backups" USING btree ("created_at");