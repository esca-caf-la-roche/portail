# Compétition · Arkose

Le module staff `/competition` suit les ambassadeurs par saison et leur case
**Partenariat signé**. L'accès nécessite `allowedTiles: competition`, y compris
pour un administrateur.

## Signatures Arkose

Le bouton **Importer les signatures Arkose** appelle à la demande le webhook
`https://n8n.jpcloudkit.fr/webhook/partenariat-arkose` en GET, avec les mêmes
identifiants Basic Auth Convex que les règlements DocuSeal
(`ABO_REGLEMENTS_WEBHOOK_USER` et `ABO_REGLEMENTS_WEBHOOK_PASSWORD`). Aucun
secret ne passe au navigateur, aucune synchronisation automatique ni cron n'est
créé. La réponse attend un tableau JSON d'objets `{ NOM, Prénom }`, limité à
1 000 entrées et 1 Mo. Les clés sont reconnues sans différence de casse ni
d'accent (`NOM`/`Nom`/`nom`, `Prénom`/`PRENOM`/`prenom`) ; un objet qui fournit
plus d'un alias pour le même champ est refusé.

Un nom/prénom normalisé qui correspond à un unique ambassadeur de la saison le
marque signé automatiquement. Une absence de correspondance ou un homonyme est
placé dans la file **Signatures Arkose à rapprocher**. Le staff peut alors lier
une signature à un ou plusieurs ambassadeurs, notamment lorsqu'un adulte signe
pour plusieurs enfants. Les imports rejoués sont idempotents. Les signatures et
leurs liaisons sont des données dérivées supprimées en cascade avec la saison,
après retrait obligatoire des ambassadeurs.

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
filtres, uniquement au clic et par pages bornées, puis télécharge en un clic un
unique fichier **CSV** (séparateur point-virgule et BOM UTF-8, format attendu par
Excel francophone). Il refuse au-delà de 2000 fiches ou 100 appels sans produire
de fichier partiel. Les lectures paginées ne constituent pas une transaction
unique ; éviter les modifications concurrentes pendant la préparation. Les
révisions restent contrôlées à la réimportation. Changer de saison efface
formulaire et import en cours. L'export ajoute Partenariat signé, Saison,
Identifiant et Révision ; les cellules sont explicitement textuelles et une
valeur commençant par `=`, `+`, `-` ou `@` est préfixée d'une apostrophe
(anti-injection de formule Excel), retirée à la réimportation.

L'import accepte une feuille XLSX non vide (source Arkose d'origine) ou un CSV
produit par l'export, 2 Mo maximum et 200 lignes. Un export de plus de 200 fiches
doit donc être découpé manuellement pour être réimporté en une fois.
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

Le champ `competition_ambassadeurs.colonne1`, vide partout et sans usage, a été
retiré du modèle applicatif (import, export, formulaire, tableau) et du schéma
Convex. La suppression a suivi le cycle **widen → migrate → narrow** :

1. **Widen** : `colonne1` est resté déclaré `v.optional` dans
   `convex/schema.ts` le temps de la migration.
2. **Migrate** : `migrations:migrateCompetitionSupprimerColonne1` a effacé la
   valeur sur les 28 documents PROD (2026-10-08), puis le contrôle a confirmé
   qu'aucun document ne portait plus `colonne1`.
3. **Narrow** : la ligne `colonne1` a été retirée du schéma et le code de
   migration supprimé.

Le retrait du champ du schéma n'a pas pu être livré en même temps que la
migration : Convex refuse un déploiement si des documents existants portent un
champ absent du schéma. L'ancienne colonne reste, elle, acceptée puis ignorée à
l'import des anciens fichiers XLSX.

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
`src/utils/competitionExcel.test.ts` (dates, colonnes, exports CSV
51/200/201/2000, refus 2001, injection de formule, échappement) et
`src/utils/competitionXlsxImport.test.ts` (vrai XLSX lu en mémoire : accents,
texte commençant par `=`, vraie cellule date, ID et révision).
`src/utils/competitionBootstrapCli.test.ts` couvre le vrai script XLSX sur
29 lignes fictives avec deux doublons exacts, la conservation des sept champs
retenus (« Colonne 1 » ignorée), le résultat de 27 fiches, les comptes invalides
et les doublons divergents.
