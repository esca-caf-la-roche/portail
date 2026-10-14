# Compétition · Arkose

Le module staff `/competition` suit les ambassadeurs par saison et leur case
**Partenariat signé**. L'accès nécessite `allowedTiles: competition`, y compris
pour un administrateur.

## Signatures Arkose

Le bouton **Synchroniser avec Arkose** appelle à la demande le webhook
`https://n8n.jpcloudkit.fr/webhook/partenariat-arkose` en GET, avec les mêmes
identifiants Basic Auth Convex que les règlements DocuSeal
(`ABO_REGLEMENTS_WEBHOOK_USER` et `ABO_REGLEMENTS_WEBHOOK_PASSWORD`). Aucun
secret ne passe au navigateur, aucune synchronisation automatique ni cron n'est
créé. La réponse attend un tableau JSON d'objets `{ NOM, Prénom, email?, lien? }`, limité à
1 000 entrées et 1 Mo. Les clés sont reconnues sans différence de casse ni
d'accent (`NOM`/`Nom`/`nom`, `Prénom`/`PRENOM`/`prenom`) ; un objet qui fournit
plus d'un alias pour le même champ est refusé.

L'email optionnel est celui du **signataire**, extrait par n8n de l'objet du
message DocuSeal (« complété par … »), et non celui de l'expéditeur DocuSeal.
Il est normalisé et affiché sous l'identité dans **Signataire reçu**. Une ancienne
signature sans email reste valide ; un import ultérieur avec une adresse non vide
remplace l'adresse stockée (elle est réputée provenir du signataire) sans changer
les liaisons ni le statut. L'absence ou une valeur vide dans un nouvel import
n'efface jamais une adresse connue. Deux emails différents pour la même identité
dans une réponse sont refusés comme ambigus.

Le lien optionnel est l'URL **Google Drive** du PDF signé déposé par n8n
(accepte `lien`, `lienPdf` ou `lien_pdf`). Il doit être une URL `https://`. n8n partage le
fichier en **lecteur** pour toute personne disposant du lien (non indexable) puis
renvoie `webViewLink`. Le portail affiche « Ouvrir le PDF signé » sous le nom du
signataire. Le partage s'applique au fichier de la saison courante et seulement
aux signatures importées après l'ajout de cette étape : les signatures déjà
présentes n'ont pas de lien. Un lien non vide remplace le lien stocké ;
l'absence n'efface jamais un lien connu.

Un nom/prénom normalisé qui correspond à un unique ambassadeur de la saison le
marque signé automatiquement. Une absence de correspondance ou un homonyme est
placé dans la file **Signatures Arkose à rapprocher**. Le staff peut alors lier
une signature à un ou plusieurs ambassadeurs, notamment lorsqu'un adulte signe
pour plusieurs enfants. Le choix des ambassadeurs utilise une recherche locale
et un sélecteur compact : les élèves choisis restent visibles et peuvent être
retirés avant confirmation. Les élèves déjà liés ne sont pas reproposés et une
signature est limitée à 20 ambassadeurs au total, même après plusieurs ajouts.
Les imports rejoués sont idempotents. Une signature sans correspondance (par
exemple un test) peut être **masquée** : elle sort de la file par défaut et les
imports suivants l'ignorent sans la supprimer. Le staff peut afficher les
signatures masquées puis les réafficher ; une signature liée doit d'abord être
déliée. Les signatures et leurs liaisons sont des données dérivées supprimées
en cascade avec la saison, après retrait obligatoire des ambassadeurs.

La file affiche seulement les signatures **à rapprocher** par défaut. Une
signature reliée, automatiquement ou manuellement, disparaît de cette vue sans
être supprimée ni passer au statut « masquée ». **Afficher les signatures
reliées** permet de consulter et corriger les liaisons ; **Afficher les
signatures masquées** est une option indépendante. Si la dernière liaison est
retirée, la signature revient dans la file à rapprocher.

Le workflow n8n traite au plus **5 messages non lus par appel** et répond après
la fin du lot (ou `[]` si aucun message ne reste). S'il reste des messages,
relancer la synchronisation. Les deux entrées de la fusion PDF/identité doivent
provenir de la même itération. Le marquage Gmail « lu » après le dépôt Drive
n'est pas un accusé de réception Convex : si le portail n'a pas reçu le résultat,
un rattrapage manuel demeure nécessaire. Les emails des messages historiques
déjà lus ne sont donc pas récupérés automatiquement par cette évolution.

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

## Affichage responsive

La page s'adapte à la largeur de l'écran et à celle de ses panneaux :

- **768px** : en-tête, statistiques (grille), barre d'outils, en-tête de liste,
  bloc de synchronisation Arkose et pagination passent en pile, et les boutons
  prennent toute la largeur.
- **62,5em de largeur disponible dans le panneau** (1000px à taille normale) : les trois tableaux
  (liste, file Arkose, prévisualisation d'import)
  deviennent des fiches empilées. Chaque cellule porte son libellé dans un
  attribut `data-label` repris par `td::before`, et le `<thead>` est masqué
  visuellement sans quitter l'arbre d'accessibilité. Une container query tient
  compte des marges et du padding, même sur un écran de bureau. Le seuil en
  `em` augmente avec la taille du texte pour conserver des fiches lisibles.

Comme `display: block` fait disparaître les rôles implicites de tableau, les
éléments portent des rôles ARIA explicites (`table`, `rowgroup`, `row`,
`columnheader` avec `scope="col"`, `cell`) : les en-têtes de colonne restent
annoncés en mode fiche. Les tableaux conservés sur les grands panneaux utilisent
`table-layout: fixed` et leurs textes longs reviennent à la ligne : aucun
conteneur de défilement horizontal n'est utilisé. `min-width: 0` sur les enfants
de `.competition-page` autorise leur rétrécissement, et le champ de fichier
fantôme est exclu de la règle de largeur générale des inputs.

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
6. Vérifier l'email reçu sous le nom du signataire ; une ancienne signature sans
   email ne doit pas afficher une adresse inventée. Rechercher un ambassadeur,
   en ajouter plusieurs, changer la recherche puis retirer un choix : la
   sélection doit être conservée et utilisable au clavier et sur mobile.
7. Relier une signature : elle doit sortir de la file par défaut. Afficher les
   signatures reliées, retirer sa dernière liaison : elle doit revenir dans la
   file. Vérifier que l'option des signatures masquées reste indépendante.

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
