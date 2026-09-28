import Link from "next/link";
import QueueRunner from "@/components/queue-runner";
import CalibrationBanner from "./calibration-banner";

const TABS = [
  { href: "/shortlist", label: "Shortlist" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/upload", label: "Upload" },
  { href: "/settings", label: "Settings" },
] as const;

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="min-h-screen">
      <header className="border-b bg-white">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="font-semibold">Kargo Hiring Copilot</span>
          {TABS.map((t) => (
            <Link key={t.href} href={t.href} className="text-sm text-zinc-700 hover:text-zinc-950 hover:underline">
              {t.label}
            </Link>
          ))}
          <form method="post" action="/api/auth/logout" className="ml-auto">
            <button type="submit" className="text-sm text-zinc-600 hover:underline">
              Log out
            </button>
          </form>
        </nav>
      </header>
      <CalibrationBanner />
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <QueueRunner concurrency={Math.max(1, Math.min(4, Number(process.env.GEMINI_CONCURRENCY ?? 2) || 2))} />
    </div>
  );
}
