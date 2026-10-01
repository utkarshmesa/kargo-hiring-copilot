"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// PRD §8.2: while the dashboard is open it calls /api/process-next in a loop, one CV per
// call, `concurrency` calls at a time. The daily cron drains anything left over.
// Other components ask for a drain with: window.dispatchEvent(new Event("kargo:drain")).
export default function QueueRunner({ concurrency }: { concurrency: number }) {
  const router = useRouter();
  const running = useRef(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const drain = async () => {
      if (running.current) return;
      running.current = true;
      let processedAny = false;
      const worker = async () => {
        for (;;) {
          const res = await fetch("/api/process-next", { method: "POST" }).catch(() => null);
          if (!res) return;
          const body = await res.json().catch(() => ({}));
          if (!body.processed) return;
          processedAny = true;
          setActive((n) => n + 1);
          window.dispatchEvent(new Event("kargo:processed"));
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      running.current = false;
      setActive(0);
      if (processedAny) router.refresh();
    };
    // Due emails go out while the dashboard is open (the scheduler covers the rest).
    const sendDue = () => fetch("/api/emails/send-due", { method: "POST" }).then((r) => r.json()).then((b) => b.sent && router.refresh()).catch(() => undefined);
    const tick = () => {
      drain();
      sendDue();
    };
    const first = setTimeout(tick, 500);
    const every = setInterval(tick, 30_000);
    window.addEventListener("kargo:drain", drain);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      window.removeEventListener("kargo:drain", drain);
    };
  }, [concurrency, router]);

  if (!active) return null;
  return (
    <div role="status" className="fixed right-4 bottom-4 rounded bg-zinc-900 px-3 py-2 text-xs text-white shadow">
      Processing CVs… {active} done this run
    </div>
  );
}
