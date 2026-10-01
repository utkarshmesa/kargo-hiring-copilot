-- Sends due candidate emails every minute (Vercel Hobby cron only runs once a day).
-- Run once in Supabase → SQL Editor, after replacing the two placeholders:
--   <APP_URL>      your production URL, e.g. https://kargo-hiring-copilot.vercel.app
--   <CRON_SECRET>  the same value as CRON_SECRET in Vercel
-- Calling /api/emails/send-due often is safe: each email is claimed with one conditional
-- UPDATE, so it can never be sent twice.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Keep the secret out of the job definition.
select vault.create_secret('<CRON_SECRET>', 'kargo_cron_secret');

select cron.schedule(
  'kargo-send-due-emails',
  '* * * * *',
  $$
  select net.http_post(
    url := '<APP_URL>/api/emails/send-due',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kargo_cron_secret')
    ),
    timeout_milliseconds := 55000
  );
  $$
);

-- Check it:   select * from cron.job_run_details order by start_time desc limit 5;
-- Stop it:    select cron.unschedule('kargo-send-due-emails');
