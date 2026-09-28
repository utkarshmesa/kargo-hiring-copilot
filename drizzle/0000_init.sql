CREATE TYPE "public"."decision_action" AS ENUM('advance', 'decline', 'hold');--> statement-breakpoint
CREATE TYPE "public"."eligibility" AS ENUM('stated_yes', 'stated_no', 'unstated');--> statement-breakpoint
CREATE TYPE "public"."email_kind" AS ENUM('advance', 'decline', 'hold', 'nudge', 'digest');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('pending', 'scheduled', 'sent', 'delivered', 'bounced', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."eval_status" AS ENUM('queued', 'processing', 'scored', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."pipeline_status" AS ENUM('scored', 'advanced', 'booked', 'interviewed', 'offer', 'declined', 'hold', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."role_applied" AS ENUM('PM', 'SPM', 'NOT_SURE');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('PM', 'SPM');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('A', 'B', 'C', 'D', 'R');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rubric_hash" text NOT NULL,
	"config_hash" text NOT NULL,
	"model_id" text NOT NULL,
	"passed" boolean NOT NULL,
	"results_json" jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"record_key" text,
	"file_name" text,
	"display_name" text,
	"email" text,
	"phone" text,
	"urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"eligibility_relocate" "eligibility" DEFAULT 'unstated' NOT NULL,
	"extractor_json" jsonb,
	"linked_candidate_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"no_contact" boolean DEFAULT false NOT NULL,
	"legacy" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"action" "decision_action" NOT NULL,
	"reason" text,
	"hold_until" date,
	"invite_line_final" text,
	"recommended_tier" "tier",
	"prev_pipeline_status" "pipeline_status" NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid,
	"evaluation_id" uuid,
	"kind" "email_kind" NOT NULL,
	"resend_id" text,
	"scheduled_at" timestamp with time zone,
	"status" "email_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emails_decision_required" CHECK (("emails"."kind" = 'digest') = ("emails"."decision_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"role_applied" "role_applied" NOT NULL,
	"role_title_final" "role",
	"file_path" text,
	"status" "eval_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"transient_retries" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"visible_text_hash" text,
	"redacted_profile_text" text,
	"redacted_profile_json" jsonb,
	"experience_json" jsonb,
	"run_scores_json" jsonb,
	"dims_final_json" jsonb,
	"pm_total" real,
	"spm_total" real,
	"core_score" real,
	"best_fit_role" "role",
	"tier" "tier",
	"tier_reason" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"brief_json" jsonb,
	"model_id" text,
	"rubric_hash" text,
	"config_hash" text,
	"redaction_log_json" jsonb,
	"pipeline_status" "pipeline_status",
	"pipeline_status_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scored_at" timestamp with time zone,
	CONSTRAINT "needs_review_is_tier_r" CHECK ("evaluations"."status" <> 'needs_review' OR "evaluations"."tier" IS NOT DISTINCT FROM 'R')
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"role_scope" text DEFAULT 'PM/SPM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"config_json" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"rubric_hash" text NOT NULL,
	"locked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidates_record_key_idx" ON "candidates" USING btree ("pool_id","record_key");--> statement-breakpoint
CREATE INDEX "decisions_evaluation_idx" ON "decisions" USING btree ("evaluation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_decision_kind_uq" ON "emails" USING btree ("decision_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_idempotency_key_uq" ON "emails" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "emails_resend_id_idx" ON "emails" USING btree ("resend_id");--> statement-breakpoint
CREATE INDEX "evaluations_queue_idx" ON "evaluations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "evaluations_pool_idx" ON "evaluations" USING btree ("pool_id");