import { buildApiKeyProviderList, buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts. The Models panel also reads
// the API-key list from here, so both come from one credential snapshot.
export async function GET() {
  const inputs = await collectProviderListingInputs();
  const oauthProviders = buildOAuthProviderList(inputs);
  return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders: buildApiKeyProviderList(inputs) });
}
