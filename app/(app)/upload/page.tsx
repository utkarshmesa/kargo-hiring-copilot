import UploadClient from "./upload-client";

export const dynamic = "force-dynamic";

export default function UploadPage() {
  const concurrency = Math.max(1, Math.min(4, Number(process.env.GEMINI_CONCURRENCY ?? 2) || 2));
  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">Upload CVs</h1>
      <UploadClient concurrency={concurrency} />
    </section>
  );
}
