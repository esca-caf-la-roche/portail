# Compétition · Arkose

Le module staff `/competition` suit les ambassadeurs par saison et leur case
**Partenariat signé**, purement manuelle : aucun envoi, signature électronique
ou synchronisation externe. L'accès nécessite `allowedTiles: competition`,
y compris pour un administrateur. Aucune attribution automatique n'est faite.

## Données et opérations

Les sept colonnes utiles sont conservées : Nom, Prénom, Date de naissance,
Civilité, Catégories, Quels groupe, Email. Civilité, Catégorie et Groupe sont
des valeurs typées (listes fermées, aucune valeur libre) définies dans
`convex/competitionModel.ts` et proposées en `<select>` côté front. L'ancienne
colonne « Colonne 1 », sans aucun usage, a été retirée du modèle (voir
« Migration » plus bas). Nom, prénom et naissance
sont obligatoires. Une identité normalisée (nom, prénom, naissance) est unique
dans une saison. Les modifications et suppressions vérifient une révision pour
refuser les conflits. Une modification identique ne provoque aucune écriture.
Une saison contenant des ambassadeurs ne peut pas être supprimée.

La liste est paginée par 50 fiches. Recherche et filtres portent
uniquement sur la page affichée. L'export charge **toute la saison**, sans ces
filtres, uniquement au clic, par pages bornées. Il refuse au-delà de 2000 fiches
ou 100 appels sans produire de fichier partiel. Télécharger chaque lot proposé
de 200 fiches maximum : 201 fiches produisent deux fichiers, tous réimportables.
Les lectures paginées ne constituent pas une transaction unique ; éviter les
modifications concurrentes pendant la préparation. Les révisions restent
contrôlées à la réimportation. Changer de saison efface formulaire et import
en cours. L'export ajoute Partenariat signé, Saison, Identifiant et Révision ;
les cellules sont explicitement textuelles, jamais des formules.

L'import accepte une feuille XLSX non vide, 2 Mo maximum et 200 lignes.
Importer uniquement des fichiers de confiance : la limite de 2 Mo porte sur
le fichier compressé, pas sur son contenu décompressé. Le parseur navigateur
ne borne pas ce dernier ; une bombe ZIP peut encore saturer mémoire ou CPU.
Dates acceptées : cellule Excel date, AAAA-MM-JJ ou JJ/MM/AAAA. Les nombres
sans format date sont refusés. Une prévisualisation et une confirmation sont
obligatoires. La prévisualisation montre les sept champs et les valeurs avant /
après de chaque champ modifié, ainsi que les changements de signature.
Une valeur de Civilité, Catégorie ou Groupe hors liste est refusée à l'import.
L'ancienne colonne « Colonne 1 », encore présente dans d'anciens exports, est
acceptée mais ignorée.
Sans colonne de signature, une création est non signée et une
signature existante est conservée ; une colonne Oui/Non présente la remplace
explicitement. Aucun import ne supprime de fiche. Saison étrangère, doublon,
export périmé ou conflit depuis la prévisualisation refusent l'ensemble.

## Import initial technique (29 lignes source, 27 fiches uniques, 2026-27)

Après déploiement, le bootstrap est une opération technique authentifiée par les
credentials administratifs de la CLI Convex, sans compte applicatif choisi ou
inventé. Le bootstrap interne ne crée ni utilisateur, ni saison, ni droit et ne
lit aucun compte pour s'attribuer une identité. Ce n'est pas un endpoint client.
Les fiches initiales portent `updatedSource: bootstrap`, sans `updatedBy`.
Les mutations applicatives normales tracent toujours `updatedBy: ctx.userId`.
La provenance bootstrap reste conservée après une modification staff.
L'utilisateur configure ensuite les droits dans Configurations.

Préparer le payload sans réseau ni affichage de données personnelles :

```text
node scripts/competition-bootstrap.mjs <source.xlsx> <fichier-json-hors-depot>
```

Le script exige exactement les huit en-têtes d'origine de la source (dont
« Colonne 1 ») dans leur ordre et 29 lignes source donnant 27 identités
uniques. « Colonne 1 » est lue pour la détection de doublons mais n'est jamais
recopiée dans le payload (elle est retirée du modèle). Il retire seulement les
deux doublons dont les huit cellules source sont intégralement identiques : une
identité répétée avec un champ différent est refusée, même si la différence
n'est qu'un espace. Aucun nom ni email n'est journalisé. Il impose saison
`2026-27` et signature `false`. La destination doit
être hors dépôt et ne pas exister ; elle contient des données personnelles.
Sous Windows, contrôler aussi les ACL du dossier (le mode POSIX 0600 ne suffit
pas). Ne pas afficher ou archiver ce JSON dans des logs, puis le supprimer
après usage.

L'opérateur appelle `competition:bootstrapInitialSeason` avec le JSON en argument
via la CLI Convex (ajouter `--prod` seulement pour l'exécution PROD autorisée).
Ne pas utiliser `--push`. Masquer les sorties/erreurs brutes et ne restituer que
les compteurs `created` et `unchanged`. Ne jamais saisir le payload littéral
dans l'historique du terminal : lire le fichier dans une variable.

La mutation exige 27 identités distinctes (26 ou 28 sont refusées), sans ID/révision et toutes non
signées. Elle crée les fiches absentes et ne touche pas aux fiches strictement
identiques. Toute différence, signature déjà vraie ou fiche étrangère dans
la saison refuse atomiquement l'opération. Une répétition identique ne fait
aucune écriture. Les données des autres saisons ne sont pas modifiées.

## Migration — retrait de « Colonne 1 »

Le champ `competition_ambassadeurs.colonne1` est retiré du modèle applicatif
(import, export, formulaire, tableau) car il était vide partout et sans usage.
La suppression suit le cycle **widen → migrate → narrow** :

1. **Widen** (déploiement courant) : `colonne1` reste déclaré `v.optional` dans
   `convex/schema.ts`, marqué `DEPRECATED`, pour que les documents existants
   restent valides et que les nouvelles écritures (sans le champ) passent.
2. **Migrate** : lancer `migrations:migrateCompetitionSupprimerColonne1` sur DEV
   puis PROD (accord explicite requis) pour effacer la valeur existante.
   Contrôler ensuite qu'aucun document ne porte plus `colonne1`.
3. **Narrow** (déploiement ultérieur) : supprimer la ligne `colonne1` du schéma
   une fois tous les documents nettoyés.

Le retrait du champ du schéma ne peut pas être livré en même temps que la
migration : Convex refuse un déploiement si des documents existants portent un
champ absent du schéma.

## Validation manuelle restant nécessaire

1. Vérifier la tuile et route avec un staff autorisé puis un admin sans tuile.
2. Créer, modifier, cocher/décocher la signature et supprimer avec confirmation.
3. Modifier depuis deux onglets : la seconde sauvegarde doit signaler le conflit.
4. Importer le fichier initial, contrôler la prévisualisation, exporter puis
   réimporter : aucune modification ; essayer une saison étrangère et un doublon.
5. Changer de saison pendant une prévisualisation, recharger et vérifier
   l'isolation et la persistance ; tester clavier, mobile et pagination.

Tests automatisés : `convex/competition.test.ts` (CRUD, accès, saisons,
révisions, atomicité, idempotence, bootstrap),
`src/utils/competitionExcel.test.ts` (dates, colonnes, exports 51/200/201/2000,
refus 2001) et `src/utils/competitionXlsxRoundtrip.test.ts` (vrai XLSX écrit / lu
en mémoire : accents, vides, texte commençant par `=`, dates, ID et révision).
`src/utils/competitionBootstrapCli.test.ts` couvre le vrai script XLSX sur
29 lignes fictives avec deux doublons exacts, la conservation des sept champs
retenus (« Colonne 1 » ignorée), le résultat de 27 fiches, les comptes invalides
et les doublons divergents.
