export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form method="post" action="/api/auth/login" className="w-full max-w-sm space-y-4 rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Kargo Hiring Copilot</h1>
        <label className="block text-sm">
          Password
          <input
            type="password"
            name="password"
            required
            autoFocus
            autoComplete="current-password"
            className="mt-1 block w-full rounded border px-3 py-2"
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            Wrong password.
          </p>
        ) : null}
        <button type="submit" className="w-full rounded bg-zinc-900 px-3 py-2 text-white hover:bg-zinc-700">
          Log in
        </button>
      </form>
    </main>
  );
}
