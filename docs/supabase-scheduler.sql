-- Sends due candidate emails every minute (Vercel Hobby cron only runs once a day).
-- Run once in Supabase → SQL Editor after replacing <APP_URL> with the production URL,
-- e.g. https://kargo-hiring-copilot-orpin.vercel.app
--
-- Authentication: Supabase generates a random token and keeps it in Vault. The app reads
-- the same Vault secret over its database connection (lib/scheduler-token.ts), so the
-- token is never copied anywhere. Calling /api/emails/send-due often is safe: each email
-- is claimed with one conditional UPDATE and only already-due emails can be sent.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'kargo_scheduler_token', 'Bearer token for /api/emails/send-due')
where not exists (select 1 from vault.secrets where name = 'kargo_scheduler_token');

select cron.schedule(
  'kargo-send-due-emails',
  '* * * * *',
  $$
  select net.http_post(
    url := '<APP_URL>/api/emails/send-due',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kargo_scheduler_token')
    ),
    timeout_milliseconds := 55000
  );
  $$
);

-- Check it:   select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
--             select status_code, content from net._http_response order by created desc limit 5;
-- Stop it:    select cron.unschedule('kargo-send-due-emails');
