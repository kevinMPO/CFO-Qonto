// ---------------------------------------------------------------------------
// handler.ts — la colle HTTP de l'API moteur : auth → débit → parse strict →
// calcul. Séparée de `api.ts` (pure, testable sans Next) pour que la logique
// reste unitairement testable et que ce fichier ne porte QUE le transport.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import type { z } from "zod";

import { authenticateEngine } from "./api";
import { reponseTropDeRequetes, verifierDebit } from "@/lib/api/rate-limit";
import { octetsVersTexte } from "@/lib/encodage";

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** Plafond du corps : 5000 tx ~ quelques centaines de Ko, on laisse 2 Mo de marge. */
const MAX_BODY_BYTES = 2_000_000;

/**
 * Lit le corps en BORNANT l'allocation AVANT tout parse. `req.json()` bufferise
 * puis parse la totalité du corps d'abord : les limites Zod (.max, .strict) ne
 * s'appliquent qu'après et ne protègent pas la mémoire. On coupe donc en amont,
 * y compris pour un envoi « chunked » sans Content-Length. `null` = trop gros.
 */
async function readCappedText(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  const reader = req.body?.getReader();
  if (!reader) {
    const t = await req.text();
    return t.length > MAX_BODY_BYTES ? null : t;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return octetsVersTexte(buf);
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

  const text = await readCappedText(req);
  if (text === null) {
    return noStore(NextResponse.json({ error: "payload_too_large" }, { status: 413 }));
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
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
