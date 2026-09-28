-- Supabase exposes the public schema through its REST API. Enable RLS with no
-- policies so the anon/authenticated keys can read nothing; the app connects as
-- the postgres role through DATABASE_URL, which bypasses RLS.
ALTER TABLE "pools" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evaluations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calibrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
