import { readModelsForCwd } from "@/worker/models";


export async function GET(req: Request) {
  const { status, data } = await readModelsForCwd(new URL(req.url).searchParams.get("cwd"));
  return Response.json(data, { status });
}
