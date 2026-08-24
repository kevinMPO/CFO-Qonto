// ---------------------------------------------------------------------------
// engine — point d'entrée public du moteur déterministe.
//
// Le calcul vit dans `./core`. Ce ré-export garde l'import historique
// `@/lib/engine` stable (analyze route, API moteur, tests) après l'extraction
// du moteur dans son propre dossier.
// ---------------------------------------------------------------------------

export * from "./core";
