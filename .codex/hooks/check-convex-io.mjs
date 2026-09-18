#!/usr/bin/env node

import { readFileSync } from "node:fs";

function lireStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

const event = lireStdin();
const patch = event?.tool_input?.command ?? "";
if (!patch.includes("*** Begin Patch")) process.exit(0);

const endpointsCouteux = new Set([
  "api.abo.licencesEnCours.getElevesLicenceInvalide",
  "api.abo.compteur.getElevesEnCours",
]);

const lignes = patch.split(/\r?\n/);
const erreurs = [];
let fichier = null;

for (let i = 0; i < lignes.length; i++) {
  const entete = lignes[i].match(/^\*\*\* (?:Add|Update) File: (.+)$/);
  if (entete) {
    fichier = entete[1].replaceAll("\\", "/");
    continue;
  }
  if (!fichier || !lignes[i].startsWith("+") || lignes[i].startsWith("+++")) continue;
  const ajout = lignes[i].slice(1);
  const contexte = lignes.slice(Math.max(0, i - 10), i + 1).join("\n");

  if (
    /(^|\/)convex\//.test(fichier) &&
    /\.(?:collect|take)\s*\(/.test(ajout) &&
    !/\.withIndex\s*\(/.test(contexte) &&
    !/\/\/\s*IO-BOUNDED\s*:/.test(contexte)
  ) {
    erreurs.push(
      `${fichier}: nouveau parcours complet sans index ni commentaire ` +
      "`// IO-BOUNDED: <raison et volume maximal>`.",
    );
  }

  if (
    /(^|\/)src\//.test(fichier) &&
    /Date\.now\s*\(/.test(ajout) &&
    /useQuery\s*\(/.test(contexte) &&
    !/\/\/\s*IO-STABLE-TIME\s*:/.test(contexte)
  ) {
    erreurs.push(
      `${fichier}: Date.now() ne doit pas créer un nouvel argument useQuery à chaque rendu. ` +
      "Utilisez une valeur stable/arrondie ou justifiez `// IO-STABLE-TIME:`.",
    );
  }

  if (/(^|\/)src\//.test(fichier) && /useQuery\s*\(/.test(ajout)) {
    const fenetre = lignes.slice(i, Math.min(lignes.length, i + 8)).join("\n");
    for (const endpoint of endpointsCouteux) {
      if (fenetre.includes(endpoint)) {
        erreurs.push(
          `${fichier}: ${endpoint} est un endpoint coûteux ; utilisez ` +
          "useQueryPonctuelle avec arguments stables et rafraîchissement explicite.",
        );
      }
    }
  }

  if (
    /(^|\/)src\/hooks\/useQueryPonctuelle\.ts$/.test(fichier) &&
    /window\.addEventListener\(\"focus\"/.test(ajout) &&
    !/refreshOnFocus/.test(contexte)
  ) {
    erreurs.push(
      `${fichier}: un rafraîchissement au focus doit rester opt-in pour protéger les listes coûteuses.`,
    );
  }
}

if (erreurs.length > 0) {
  console.error(`BUDGET DATABASE I/O CONVEX\n\n${erreurs.join("\n\n")}`);
  process.exit(2);
}
