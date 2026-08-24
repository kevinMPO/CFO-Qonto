// ---------------------------------------------------------------------------
// handler.ts — la colle HTTP de l'API moteur : auth → débit → parse strict →
// calcul. Séparée de `api.ts` (pure, testable sans Next) pour que la logique
// reste unitairement testable et que ce fichier ne porte QUE le transport.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import type { z } from "zod";

import { authenticateEngine } from "./api";
import { reponseTropDeRequetes, verifierDebit } from "@/lib/api/rate-limit";

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * Exécute une route de l'API moteur. Ordre volontaire :
 *   1. AUTH d'abord — un anonyme ne doit même pas consommer de quota.
 *   2. DÉBIT ensuite, indexé sur le jeton (pas l'IP) : 60/min par jeton.
 *   3. PARSE STRICT — une clé inconnue ou un type faux = 400, jamais un calcul
 *      sur une charge douteuse.
 *   4. CALCUL déterministe. Toute exception → 500 générique (rien ne fuite).
 */
export async function handleEngine<S extends z.ZodTypeAny>(
  req: Request,
  schema: S,
  compute: (input: z.infer<S>) => unknown,
): Promise<Response> {
  const auth = authenticateEngine(req);
  if (!auth.ok) return noStore(NextResponse.json({ error: auth.code }, { status: auth.status }));

  const debit = await verifierDebit(req, "engine", undefined, Date.now(), auth.token);
  if (!debit.autorise) return reponseTropDeRequetes(debit);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return noStore(NextResponse.json({ error: "invalid_json" }, { status: 400 }));
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return noStore(
      NextResponse.json(
        {
          error: "invalid_body",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        { status: 400 },
      ),
    );
  }

  try {
    return noStore(NextResponse.json(compute(parsed.data), { status: 200 }));
  } catch (err) {
    console.error("[argentier][engine-api] calcul impossible :", err);
    return noStore(NextResponse.json({ error: "engine_error" }, { status: 500 }));
  }
}
