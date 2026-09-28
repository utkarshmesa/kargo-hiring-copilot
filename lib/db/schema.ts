// Data model: PRD §7. Identity lives only in `candidates`. Nothing in `evaluations`
// (redacted profile, run scores, brief) may contain identity.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const roleAppliedEnum = pgEnum("role_applied", ["PM", "SPM", "NOT_SURE"]);
export const roleEnum = pgEnum("role", ["PM", "SPM"]);
export const evalStatusEnum = pgEnum("eval_status", ["queued", "processing", "scored", "needs_review", "failed"]);
export const pipelineStatusEnum = pgEnum("pipeline_status", [
  "scored",
  "advanced",
  "booked",
  "interviewed",
  "offer",
  "declined",
  "hold",
  "withdrawn",
]);
export const tierEnum = pgEnum("tier", ["A", "B", "C", "D", "R"]);
export const eligibilityEnum = pgEnum("eligibility", ["stated_yes", "stated_no", "unstated"]);
export const decisionActionEnum = pgEnum("decision_action", ["advance", "decline", "hold"]);
export const emailKindEnum = pgEnum("email_kind", ["advance", "decline", "hold", "nudge", "digest"]);
// `pending` = row reserved before the Resend call, so the unique index is taken first.
export const emailStatusEnum = pgEnum("email_status", [
  "pending",
  "scheduled",
  "sent",
  "delivered",
  "bounced",
  "cancelled",
  "failed",
]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const pools = pgTable("pools", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  roleScope: text("role_scope").notNull().default("PM/SPM"),
  createdAt: createdAt(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  configJson: jsonb("config_json").notNull(),
  configHash: text("config_hash").notNull(),
  rubricHash: text("rubric_hash").notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
});

export const candidates = pgTable(
  "candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id),
    recordKey: text("record_key"),
    fileName: text("file_name"),
    displayName: text("display_name"),
    email: text("email"),
    phone: text("phone"),
    urls: text("urls").array().notNull().default(sql`'{}'::text[]`),
    eligibilityRelocate: eligibilityEnum("eligibility_relocate").notNull().default("unstated"),
    extractorJson: jsonb("extractor_json"),
    linkedCandidateIds: uuid("linked_candidate_ids").array().notNull().default(sql`'{}'::uuid[]`),
    noContact: boolean("no_contact").notNull().default(false),
    legacy: boolean("legacy").notNull().default(false),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("candidates_record_key_idx").on(t.poolId, t.recordKey)],
);

export const evaluations = pgTable(
  "evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id),
    roleApplied: roleAppliedEnum("role_applied").notNull(),
    roleTitleFinal: roleEnum("role_title_final"),
    filePath: text("file_path"),
    status: evalStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    transientRetries: integer("transient_retries").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastError: text("last_error"),
    visibleTextHash: text("visible_text_hash"),
    redactedProfileText: text("redacted_profile_text"),
    redactedProfileJson: jsonb("redacted_profile_json"),
    experienceJson: jsonb("experience_json"),
    runScoresJson: jsonb("run_scores_json"),
    dimsFinalJson: jsonb("dims_final_json"),
    pmTotal: real("pm_total"),
    spmTotal: real("spm_total"),
    coreScore: real("core_score"),
    bestFitRole: roleEnum("best_fit_role"),
    tier: tierEnum("tier"),
    tierReason: text("tier_reason"),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    briefJson: jsonb("brief_json"),
    modelId: text("model_id"),
    rubricHash: text("rubric_hash"),
    configHash: text("config_hash"),
    redactionLogJson: jsonb("redaction_log_json"),
    pipelineStatus: pipelineStatusEnum("pipeline_status"),
    pipelineStatusAt: timestamp("pipeline_status_at", { withTimezone: true }),
    createdAt: createdAt(),
    scoredAt: timestamp("scored_at", { withTimezone: true }),
  },
  (t) => [
    index("evaluations_queue_idx").on(t.status, t.createdAt),
    index("evaluations_pool_idx").on(t.poolId),
    // needs_review always means tier R (rubric §8).
    check("needs_review_is_tier_r", sql`${t.status} <> 'needs_review' OR ${t.tier} IS NOT DISTINCT FROM 'R'`),
  ],
);

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id),
    action: decisionActionEnum("action").notNull(),
    reason: text("reason"),
    holdUntil: date("hold_until"),
    inviteLineFinal: text("invite_line_final"),
    recommendedTier: tierEnum("recommended_tier"),
    prevPipelineStatus: pipelineStatusEnum("prev_pipeline_status").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
  },
  (t) => [index("decisions_evaluation_idx").on(t.evaluationId)],
);

export const emails = pgTable(
  "emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionId: uuid("decision_id").references(() => decisions.id),
    evaluationId: uuid("evaluation_id").references(() => evaluations.id),
    kind: emailKindEnum("kind").notNull(),
    resendId: text("resend_id"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    status: emailStatusEnum("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // The Cut: one email of each kind per decision, ever.
    uniqueIndex("emails_decision_kind_uq").on(t.decisionId, t.kind),
    // Digests have no decision; this stops a second digest for the same day.
    uniqueIndex("emails_idempotency_key_uq").on(t.idempotencyKey),
    index("emails_resend_id_idx").on(t.resendId),
    // decision_id is null only for the digest.
    check("emails_decision_required", sql`(${t.kind} = 'digest') = (${t.decisionId} IS NULL)`),
  ],
);

export const calibrations = pgTable("calibrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  rubricHash: text("rubric_hash").notNull(),
  configHash: text("config_hash").notNull(),
  modelId: text("model_id").notNull(),
  passed: boolean("passed").notNull(),
  resultsJson: jsonb("results_json").notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  targetId: text("target_id"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});
