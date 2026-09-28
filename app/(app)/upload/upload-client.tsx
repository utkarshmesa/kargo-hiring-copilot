"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Role = "PM" | "SPM" | "NOT_SURE";
type Row = {
  id: string;
  fileName: string | null;
  roleApplied: Role;
  status: "queued" | "processing" | "scored" | "needs_review" | "failed";
  prepared: boolean;
  tier: string | null;
  tierReason: string | null;
  flags: string[];
  lastError: string | null;
};
type LocalUpload = { name: string; state: "uploading" | "error"; message?: string };

const ROLE_LABEL: Record<Role, string> = { PM: "PM", SPM: "Senior PM", NOT_SURE: "Not sure" };

function chip(r: Row): { label: string; className: string } {
  if (r.status === "queued" && r.prepared) return { label: "redacted · waiting for calibration", className: "bg-sky-100 text-sky-900" };
  switch (r.status) {
    case "queued":
      return { label: "queued", className: "bg-zinc-100 text-zinc-800" };
    case "processing":
      return { label: "processing", className: "bg-amber-100 text-amber-900" };
    case "scored":
      return { label: `scored · tier ${r.tier}`, className: "bg-emerald-100 text-emerald-900" };
    case "needs_review":
      return { label: `needs review · ${r.tierReason}`, className: "bg-orange-100 text-orange-900" };
    case "failed":
      return { label: "failed", className: "bg-red-100 text-red-900" };
  }
}

export default function UploadClient({ concurrency }: { concurrency: number }) {
  const [role, setRole] = useState<Role>("PM");
  const [legacy, setLegacy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [uploads, setUploads] = useState<LocalUpload[]>([]);
  const [draining, setDraining] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const drainingRef = useRef(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/evaluations", { cache: "no-store" });
    if (res.ok) setRows((await res.json()).evaluations);
  }, []);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = setInterval(refresh, 3000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh]);

  // Calls /api/process-next until the queue is empty, `concurrency` workers at a time.
  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    setDraining(true);
    const worker = async () => {
      for (;;) {
        const res = await fetch("/api/process-next", { method: "POST" }).catch(() => null);
        if (!res) return;
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) setNotice("Scoring is blocked until calibration passes. CVs are parsed and redacted meanwhile.");
        if (!body.processed) return;
        refresh();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    drainingRef.current = false;
    setDraining(false);
    refresh();
  }, [concurrency, refresh]);

  useEffect(() => {
    if (rows.some((r) => r.status === "queued" && !r.prepared)) drain();
  }, [rows, drain]);

  async function uploadOne(file: File) {
    const name = file.name;
    setUploads((u) => [...u, { name, state: "uploading" }]);
    const fail = (message: string) =>
      setUploads((u) => u.map((x) => (x.name === name ? { ...x, state: "error", message } : x)));
    try {
      const tokenRes = await fetch("/api/upload/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: name, size: file.size }),
      });
      const token = await tokenRes.json();
      if (!tokenRes.ok) return fail(token.error ?? "upload refused");

      // Straight from the browser to private storage.
      const form = new FormData();
      form.append("cacheControl", "3600");
      form.append("", file);
      const put = await fetch(token.signedUrl, { method: "PUT", body: form, headers: { "x-upsert": "false" } });
      if (!put.ok) return fail(`storage rejected the file (${put.status})`);

      const reg = await fetch("/api/upload/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: token.path, ticket: token.ticket, fileName: name, roleApplied: role, legacy }),
      });
      if (!reg.ok) return fail((await reg.json()).error ?? "register failed");
      setUploads((u) => u.filter((x) => x.name !== name));
    } catch {
      fail("network error");
    }
  }

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    const files = Array.from(list);
    const bad = files.filter((f) => !/\.(docx|pdf)$/i.test(f.name));
    for (const f of bad) setUploads((u) => [...u, { name: f.name, state: "error", message: "only .docx and .pdf are supported" }]);
    const good = files.filter((f) => !bad.includes(f));
    for (let i = 0; i < good.length; i += 4) await Promise.all(good.slice(i, i + 4).map(uploadOne));
    await refresh();
    drain();
  }

  async function retry(id: string) {
    await fetch("/api/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ evaluationId: id }) });
    await refresh();
    drain();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4 rounded-lg border bg-white p-4">
        <label className="text-sm">
          Role applied for (applies to this batch)
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="mt-1 block rounded border px-2 py-1.5">
            <option value="PM">Product Manager</option>
            <option value="SPM">Senior Product Manager</option>
            <option value="NOT_SURE">Not sure (score both, rank by the higher)</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={legacy} onChange={(e) => setLegacy(e.target.checked)} />
          Legacy (applied before this system; emails open with an apology)
        </label>
      </div>

      <label
        className="block cursor-pointer rounded-lg border-2 border-dashed bg-white p-8 text-center text-sm text-zinc-600 hover:border-zinc-400"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onFiles(e.dataTransfer.files);
        }}
      >
        Drop DOCX or PDF files here, or click to choose (max 10 MB each)
        <input type="file" multiple accept=".docx,.pdf" className="sr-only" onChange={(e) => onFiles(e.target.files)} />
      </label>

      {notice ? <p className="rounded border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">{notice}</p> : null}

      {uploads.length ? (
        <ul className="space-y-1 text-sm">
          {uploads.map((u) => (
            <li key={u.name}>
              {u.name}: {u.state === "uploading" ? "uploading…" : <span className="text-red-700">{u.message}</span>}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="rounded-lg border bg-white">
        <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
          <span>
            {rows.length} CVs in this pool{draining ? " · processing…" : ""}
          </span>
          <button type="button" onClick={drain} className="rounded border px-2 py-1 hover:bg-zinc-50">
            Process queue
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="px-4 py-2 font-medium">File</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Flags</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const c = chip(r);
              return (
                <tr key={r.id} className="border-t">
                  <td className="px-4 py-2">
                    <Link href={`/candidates/${r.id}`} className="hover:underline">
                      {r.fileName ?? r.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{ROLE_LABEL[r.roleApplied]}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs ${c.className}`}>{c.label}</span>
                    {r.status === "failed" && r.lastError ? <span className="ml-2 text-xs text-zinc-500">{r.lastError}</span> : null}
                  </td>
                  <td className="px-4 py-2 text-xs">{r.flags.join(", ")}</td>
                  <td className="px-4 py-2 text-right">
                    {r.status === "failed" ? (
                      <button type="button" onClick={() => retry(r.id)} className="rounded border px-2 py-1 text-xs hover:bg-zinc-50">
                        Retry
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
