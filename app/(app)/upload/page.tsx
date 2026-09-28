import UploadClient from "./upload-client";

export default function UploadPage() {
  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">Upload CVs</h1>
      <UploadClient />
    </section>
  );
}
