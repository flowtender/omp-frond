import { isApiRequestAllowed } from "@/lib/request-security";
import { fetchProviderUsage } from "@/lib/provider-usage";


const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/provider-usage?provider=&model=&session= — the subscription quota of
// the account the session's model runs on. omp caches the provider reports for
// five minutes, so polling this does not reach the provider each time.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  const params = new URL(req.url).searchParams;
  const provider = params.get("provider");
  if (!provider) {
    return Response.json({ error: "provider is required" }, { status: 400, headers: NO_STORE });
  }
  try {
    const usage = await fetchProviderUsage(provider, params.get("model") ?? undefined, params.get("session") ?? undefined, req.signal);
    return Response.json({ usage }, { headers: NO_STORE });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers: NO_STORE });
  }
}
