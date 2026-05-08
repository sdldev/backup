CREATE TYPE "public"."connection_test_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."database_engine" AS ENUM('mysql', 'postgresql');--> statement-breakpoint
CREATE TYPE "public"."database_source_health" AS ENUM('healthy', 'warning', 'failing', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."database_source_state" AS ENUM('enabled', 'disabled', 'deleted');--> statement-breakpoint
CREATE TABLE "database_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"engine" "database_engine" NOT NULL,
	"display_name" text NOT NULL,
	"technical_database_name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"username" text NOT NULL,
	"encrypted_password" text,
	"credential_fingerprint" text,
	"ssl_mode" text DEFAULT 'require' NOT NULL,
	"state" "database_source_state" DEFAULT 'disabled' NOT NULL,
	"health" "database_source_health" DEFAULT 'unknown' NOT NULL,
	"retention_days" integer DEFAULT 7 NOT NULL,
	"last_connection_test_at" timestamp with time zone,
	"last_connection_test_status" "connection_test_status",
	"last_successful_backup_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"soft_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "database_sources" ADD CONSTRAINT "database_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_sources" ADD CONSTRAINT "database_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_sources" ADD CONSTRAINT "database_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_sources_workspace_id_idx" ON "database_sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "database_sources_project_id_idx" ON "database_sources" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "database_sources_active_display_name_per_project_uidx" ON "database_sources" USING btree ("project_id","display_name") WHERE "database_sources"."soft_deleted_at" is null;