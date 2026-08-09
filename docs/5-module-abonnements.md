# Module « Abonnements escalade »

Portage de l'outil autonome `abo-esca-new/` (Vanilla JS + Supabase) **entièrement
sur Convex**. Gère les nouvelles inscriptions aux créneaux autonomes d'escalade
(350 places) : demande multi-personnes gatée par vagues, suivi d'avancement,
espace admin (validation, compteur, anomalies, licences, règlements signés,
tests d'autonomie),
paiements HelloAsso, scraping du site club, emails transactionnels, messagerie.

## Deux populations, une seule base

| Population | Auth | Accès | Identifiant technique |
|---|---|---|---|
| **Staff / bénévoles** | provider `google-otp` (email pré-créé par un admin) | Espace admin `/#/gestion-abonnements` (tuile du tableau de bord) **si** la tuile `abonnements` est cochée dans *Configurations > Utilisateurs* | `userSettings.allowedTiles` inclut `"abonnements"` |
| **Abonnés publics** | provider `abo-otp` (auto-inscription OTP, boîte mail dédiée) | Espace isolé `/#/abonnements` uniquement (aucune mention compta) | ligne `abo_profiles` (role `utilisateur`) ; peut coexister avec un `userSettings` pour la demande personnelle d'un staff |

🔒 **Cloisonnement** : `getAboIdentity` (`convex/abo/auth.ts`) dérive le rôle admin
**exclusivement** de `userSettings.allowedTiles` — le rôle `"admin"` compta ne
donne aucun passe-droit. Un abonné public sans `userSettings` n'a aucun accès aux
tuiles compta ; le `Layout` le redirige vers `/abonnements`. Un staff qui dépose
une demande conserve ses droits staff ; au reset, seules ses données publiques
de campagne et son profil public sont purgés.

### Résolution d'un conflit de licence entre deux dossiers

Un conflit peut être détecté lors de l'association manuelle d'une licence ou
relu dans la liste des conflits. L'admin ouvre directement un écran unique avec
les deux e-mails et, pour chaque dossier, uniquement les noms, prénoms et
licences des personnes. Les informations du site du club ne sont jamais
arbitrées : la licence reste la clé de rapprochement avec le snapshot externe.

L'admin choisit de conserver les deux dossiers, seulement le dossier A ou
seulement le dossier B, puis affecte chaque personne finale à un dossier
conservé. La personne présente deux fois pour la même licence n'apparaît qu'une
fois dans la répartition finale. Chaque personne doit appartenir à exactement un
dossier et chaque dossier conservé doit contenir au moins une personne.

Si les deux dossiers restent, leurs messages, journaux d'e-mails et comptes
restent séparés. Si un dossier est supprimé, ses personnes et ses dépendances
liées au dossier sont transférées vers l'autre. L'historique attaché au
propriétaire reste avec lui lorsque son compte staff est conservé. Une ligne durable de
`abo_fusions_dossiers` conserve le mode de résolution, la répartition, les
volumes déplacés et l'identité du staff, sans snapshot complet.

Le compte d'un dossier supprimé suit une règle de sécurité liée à sa population :

- pour un compte exclusivement public devenu inutile, le dossier, les sessions
  et les identités d'authentification sont supprimés. Le profil public est
  supprimé ; seul le `user` reste comme ancre technique inactive jusqu'à la
  purge du reset annuel. Son ancien e-mail est inscrit dans
  `abo_fusion_redirections_email`.
  Cette entrée est une
  interdiction de connexion `abo-otp`, pas un alias d'authentification : la
  tentative est refusée par un message générique, sans révéler l'e-mail
  de destination ni ouvrir l'autre compte. L'adresse à utiliser est communiquée dans
  l'email de résolution. Lors d'une chaîne A → B → C, les entrées qui pointaient
  vers B sont mises à jour en interne vers C ;
- un compte qui possède des accès staff est conservé avec `userSettings`, ses
  sessions et ses comptes d'authentification. La résolution ne doit jamais dégrader
  ses droits staff.

Deux notifications indépendantes, une par e-mail de dossier, sont planifiées et
suivies dans `abo_fusion_notifications`. Le statut, le nombre de tentatives et
un éventuel échec sont conservés pour le suivi interne ; aucun endpoint
applicatif ne propose de relance. L'audit et les notifications restent hors
saison. Le marqueur d'ancien e-mail, lui, est limité à la campagne courante et
est purgé lors du reset Abonnements — sans dépendre de la saison comptable.
Enfin, aucune écriture ni action distante n'est effectuée sur le site du club :
son snapshot demeure une source externe strictement en lecture seule.

## Règles de campagne et site du club

Le portail et le site du club sont séparés. Le portail lit le snapshot
`abo_abonnes_scrap`, mais ne crée, ne modifie et ne supprime jamais une
inscription sur le site : le staff y intervient manuellement puis synchronise.
Un ancien abonné N-1, rapproché de façon unique par nom et prénom normalisés,
est redirigé vers le site du club. En vague 2, la licence doit figurer dans le
snapshot des élèves en cours ; cette priorité de dépôt ne rend jamais conforme
une inscription déjà présente sur le site.

Pour empêcher les recherches de noms en série sans alourdir ce parcours, le
serveur limite chaque compte connecté à **20 personnes vérifiées sur 10
minutes**. Les tentatives qui aboutissent à une redirection ou à une
correspondance ambiguë sont bien comptabilisées. Au-delà, le portail demande de
patienter quelques minutes.

La décision est portée par personne. La vague de dépôt est conservée comme
information de priorité, sans échéance de décision : après l'ouverture de vague
3, le staff peut toujours décider les demandes déposées précédemment. Les
inscriptions lues sur le site sont rangées dans une catégorie exclusive :
**validée** (N-1 certain ou demande portail validée), **non validée** (aucun
droit N-1 certain et aucune demande portail validée), **bloquée** (le site
porte explicitement ce statut) ou **inconnue** (ancienne donnée booléenne
insuffisante). Les rapprochements ambigus restent à vérifier manuellement.

Le compteur public et la jauge staff affichent les inscriptions du site aux
statuts `Oui` et `Non`, puis les demandes portail validées qui ne sont pas
encore sur le site. Une ligne est comptée comme **Bloquée** uniquement lorsque
le site porte explicitement ce statut. Le plafond qui protège la validation des
demandes conserve son calcul métier plus strict.

Le champ du site **Abonnement valide ?** est lu sans le réduire : `Oui`, `Non`
et `Bloqué`. Après une évolution de ce champ, une synchronisation complète est
nécessaire ; les anciennes lignes dont le statut était seulement connu comme
« non Oui » sont temporairement exclues du compteur plutôt que mal classées.

La transition de données suit un déploiement *widen–migrate–narrow* : déployer
d'abord le schéma compatible avec les booléens historiques, exécuter ensuite
les migrations internes `migrations:migrateAboAbonnesScrapStatut` et
`migrations:migrateAboAbonnesArchiveStatut`, vérifier qu'il ne reste aucun
booléen avec les inspections paginées associées, puis seulement retirer les
booléens du schéma lors d'un déploiement ultérieur. Une valeur historique
`false` devient `inconnu`, jamais `non` ni `bloque`.

Les adresses historiques de `users` suivent la même discipline : exécuter
d'abord l'inspection interne paginée
`migrations:inspectUsersEmailCanonique`, traiter manuellement tout compteur
`invalide` ou `conflit`, puis lancer
`migrations:migrateUsersEmailCanonique`. Cette migration ne fusionne et ne
supprime aucun compte ; elle refuse aussi de choisir arbitrairement entre deux
anciennes variantes équivalentes. La laisser aller à son terme — une relance
reprend un lot interrompu — puis rejouer l'inspection : `a_normaliser` doit être
à zéro avant la suite de la mise en production.

Le compteur public lit un agrégat sans donnée nominative, recalculé après les
opérations métier qui peuvent modifier la jauge. En l'absence initiale de cet
agrégat, un calcul de transition borné permet de servir l'iframe.

La **réinitialisation annuelle** est plus restrictive que la gestion courante :
elle exige la tuile `abonnements`, le rôle d'administrateur général et
l'autorisation nominative `canResetAboSeason`, accordée dans
*Configurations > Utilisateurs et Accès*. Cette dernière est désactivée par
défaut, y compris pour les comptes existants. Un administrateur général peut
l'activer pour son propre compte ou pour un autre administrateur éligible.

## Variables d'environnement (dashboard Convex → *Settings > Environment Variables*)

> ⚠️ Ces variables se posent **côté Convex** (pas dans `.env.local`, qui ne sert
> qu'au front). Sans secrets email, l'envoi échoue explicitement, y compris en
> DEV : aucun OTP ni contenu d'email n'est écrit dans les logs Convex. Pour la
> prod : `npx convex env set NOM valeur --prod`.

### Spécifiques au module Abonnements

| Variable | Rôle | Obligatoire |
|---|---|---|
| `EMAIL_SENDER_ABO` | Adresse d'envoi des emails abonnés (OTP `abo-otp` + transactionnels). **Boîte distincte** de l'OTP compta. | Oui pour tout envoi |
| `EMAIL_PASSWORD_ABO` | Mot de passe / app-password de la boîte abo. | Oui pour tout envoi |
| `CLUB_BASE_URL` | URL de base du site club (scraping abonnés + export élèves en cours). | Oui pour le scraping |
| `CLUB_USERNAME` | Identifiant d'authentification AJAX au site club. | Oui pour le scraping |
| `CLUB_PASSWORD` | Mot de passe du site club. | Oui pour le scraping |
| `CLUB_ENCADRANTS` | Liste d'encadrants (override du défaut) pour l'export des cours. | Non |
| `IMPORT_SAISON` | Force la saison sportive (sinon déduite ~septembre). | Non |
| `LICENCES_USER` | Basic Auth de l'export annuaire FFCAM (`export_licence.php`). | Oui pour l'import annuaire |
| `LICENCES_PASSWORD` | Mot de passe de l'export annuaire. | Oui pour l'import annuaire |
| `ABO_REGLEMENTS_DRIVE_ID` | Identifiant du Drive partagé contenant les règlements signés. | Oui pour la recherche staff |
| `ABO_REGLEMENTS_DRIVE_ROOT_FOLDER_ID` | Identifiant du dossier racine des règlements dans ce Drive. | Oui pour la recherche staff |
| `ABO_REGLEMENTS_WEBHOOK_URL` | URL serveur du webhook n8n qui renvoie les règlements déjà déposés dans Drive. | Oui pour la synchronisation des signatures |
| `ABO_REGLEMENTS_WEBHOOK_USER` | Utilisateur Basic Auth du webhook n8n. | Oui pour la synchronisation des signatures |
| `ABO_REGLEMENTS_WEBHOOK_PASSWORD` | Mot de passe Basic Auth du webhook n8n. | Oui pour la synchronisation des signatures |

Le webhook n8n prend en charge Gmail, le PDF signé et son dépôt Drive. Convex
ne reçoit que le nom, le prénom et l'identifiant Drive. La recherche historique
dans Drive réutilise `GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL` et
`GOOGLE_DRIVE_PRIVATE_KEY` ; le compte de service doit avoir accès au Drive et
au dossier racine configurés.

Le **lien HelloAsso du formulaire abonnements** n'est PAS une variable
d'environnement : il se configure dans l'UI admin (*Configuration*) et est stocké
dans `abo_app_config` (clé `helloasso_lien`) + une ligne `helloasso_links`.

## Suivi des paiements Abonnements

L'onglet *Paiements* importe uniquement le formulaire HelloAsso configuré pour
les Abonnements. Son compteur de synchronisation ne couvre donc jamais les
formulaires des cours. Les commandes et transactions HelloAsso sont conservées
dans le cache partagé, mais la décision manuelle de l'équipe (`À traiter`,
`Traité`, `Remboursé`, `En attente`, commentaire et auteur) est stockée dans
`abo_paiements_suivi` et reste strictement propre aux Abonnements.

En l'absence de décision manuelle, une commande Abonnements est affichée *À
traiter*. Les statuts historiques des paiements cours ne sont ni lus ni copiés.
Un remboursement détecté par HelloAsso est comparé à la décision Abonnements
pour signaler les divergences à traiter par l'administrateur sur le site du club.

### Partagées avec la compta (déjà en place)

`HELLOASSO_CLIENT_ID`, `HELLOASSO_CLIENT_SECRET` (mêmes credentials que
« paiement des cours » ; le module abo filtre sur le lien du formulaire abo),
`EMAIL_SENDER` / `EMAIL_PASSWORD` (OTP compta), `CONVEX_SITE_URL`.

🔒 Aucun de ces secrets n'est journalisé : le scraper ne logue que le *host* et
des compteurs (jamais cookies, credentials, HTML, noms ou licences).

## Synchronisations à la demande (`convex/abo/sync.ts`)

`convex/crons.ts` est volontairement vide. Les anciens crons périodiques ont été
remplacés par des synchronisations déclenchées au chargement des pages utiles,
avec un verrou anti-rejeu partagé côté serveur. Une même source n'est
resynchronisée qu'une fois par fenêtre, environ 60 minutes par défaut et
configurable avec `SYNC_TTL_MINUTES`.

| Déclencheur | Action | Sources |
|---|---|---|
| Validation des paiements des cours | `api.abo.sync.syncPourPaiements` | HelloAsso |
| Espace admin Abonnements | `api.abo.sync.syncPourAbo` | HelloAsso → site club → annuaire → élèves |
| Tuile Licences élèves en cours | `api.abo.sync.syncPourLicencesCours` | Annuaire → élèves |

L'ordre des sources est intentionnel : les données HelloAsso doivent être
disponibles avant le matching des personnes.

Le scrap des abonnés est un **snapshot complet** : après une collecte réussie
et non vide, les lignes absentes de la liste reçue sont supprimées du cache
local `abo_abonnes_scrap`. Cela ne modifie jamais le site du club. Une liste
vide, illisible ou en erreur n'entraîne aucune purge.
Les dossiers déposés dans le portail sont conservés ; seules leurs confirmations
issues du site sont retirées jusqu'à une nouvelle présence dans le snapshot.

L'annuaire FFCAM des licences suit le même principe de snapshot : une licence
absente d'un export réussi et non vide est retirée du cache `abo_licences`, sans
modifier les licences déjà attribuées aux personnes ni leurs dossiers. Cette
source est limitée à une synchronisation toutes les 12 heures (au plus deux
passages sur 24 heures), y compris depuis le bouton administratif.

Le bouton admin « Synchroniser le site club » appelle toujours
`api.abo.scrap.synchroniserClub` avec une garde `aboRole === "admin"`. Chacun des
deux boutons manuels (site club et paiements Abonnements) a son verrou serveur
de cinq minutes, partagé entre tous les administrateurs et leurs onglets. En cas
d'échec, le verrou concerné est restauré pour autoriser une nouvelle tentative
immédiate.

## Plafond d'admissions et décisions de dossier

Le plafond de la campagne est une garde appliquée **dans la transaction serveur**
qui traite la décision. Une validation normale reste possible tant que son effet
ne fait pas dépasser le plafond : la dernière place peut donc porter l'occupation
exactement au plafond. Lorsque l'occupation est déjà au plafond, une tentative
de validation est automatiquement transformée en **liste d'attente**. Cette
vérification transactionnelle empêche que deux administrateurs, ou deux onglets,
valident simultanément une même dernière place.

Un admin Abonnements peut toutefois choisir explicitement **« Valider malgré le
plafond »** dans l'interface. La **liste d'attente** et le **refus** restent aussi
des décisions manuelles possibles, y compris lorsqu'une place est disponible.
Chaque décision met à jour le statut individuel de la personne. L'e-mail de
statut est piloté au niveau du dossier : il n'est planifié que lorsque le statut
global du dossier bascule. Ainsi, dans un dossier multi-personnes déjà validé,
la mise automatique d'une autre personne en liste d'attente met bien à jour son
statut individuel sans garantir l'envoi d'un e-mail de liste d'attente.

L'occupation utilisée par cette garde est calculée à partir du snapshot
synchronisé du site du club. Elle ne reflète donc pas nécessairement une
inscription, une annulation ou un autre changement externe qui n'a pas encore
été synchronisé. Avant une décision sensible, actualiser ce snapshot et vérifier
que la synchronisation a abouti.

Le compteur public est un agrégat événementiel : il est recalculé après les
synchronisations et les mutations métier qui peuvent modifier la jauge, sans
cron périodique. Lors du premier déploiement de cette table, exécuter une fois
la fonction interne `abo/compteur:rafraichirCompteurPublic` après la migration,
puis vérifier la présence du singleton `cle = "courant"` avant d'ouvrir
l'iframe publique. Le calcul borné de transition ne doit pas devenir le régime
normal.

## Règlements intérieurs signés

Une personne validée voit une étape dédiée avec le lien DocuSeal
`https://docuseal.com/d/6GFLQa478G3Qwv`. La signature ne valide pas
immédiatement l'étape : le suivi prévient qu'un membre du staff doit encore
confirmer la liaison et qu'un délai est normal.

À l'ouverture de l'onglet et quand le staff clique **Synchroniser les
règlements**, Convex appelle le webhook n8n authentifié. Celui-ci renvoie un
tableau léger `{ NOM, Prénom, id-drive }` pour les PDF déjà classés dans Drive.
Chaque identifiant Drive est enregistré de manière idempotente ; il n'y a ni
stockage PDF dans Convex, ni cron, ni verrou temporel.

Le nouveau fichier Drive apparaît dans **Nouveaux règlements à rapprocher**. Le portail
propose des licences exactes ou proches, mais seul le choix confirmé par un
membre du staff crée la liaison définitive. À cette confirmation, le nom
officiel de la licence confirme l'archive métier. La recherche manuelle dans Drive
reste disponible comme repli pour un document historique déjà classé.
La recherche approchée ne lit l'annuaire qu'après un clic sur le règlement. Si
les propositions ne suffisent pas, le staff peut rechercher avec un nom, un
prénom ou un fragment. Une erreur HTTP ou JSON du webhook est affichée comme
une erreur immédiate de synchronisation et ne crée aucune ligne métier.

Le règlement lié entre dans la file **À enregistrer** avec un lien vers son PDF
Drive. Après l'avoir enregistré manuellement sur le site du club, le staff le
marque **Enregistré sur le site** dans le portail. Ce statut est un suivi
interne ; le portail n'écrit jamais sur le site du club.

`abo_reglements_imports` conserve la file légère renvoyée par n8n, dédupliquée
par identifiant Drive. `abo_reglements_signes` reste l'archive métier définitive créée
après validation de la licence. Les deux tables sont permanentes et hors saison. La version
`6GFLQa478G3Qwv` distingue le formulaire courant : une licence ne peut être
liée qu'une fois à cette version, et le reset de campagne ne purge pas
l'archive.

## Rendez-vous de test d'autonomie

Une personne dont la demande est **validée** peut réserver un créneau de test,
même si sa licence, son âge ou le besoin de test ne sont pas encore connus. La
réservation est alors un **RDV provisoire** : elle évite de retarder la prise de
rendez-vous sur la seule attente des données du site du club.

Après une synchronisation réussie du site, la réévaluation ne s'appuie que sur
une **licence exactement identique**. Un rapprochement par nom et prénom ne
peut ni confirmer ni annuler un rendez-vous. Lorsque les données ainsi
retrouvées indiquent qu'un test est requis et que la personne a au moins 16 ans,
le RDV est confirmé. Lorsqu'elles indiquent que le test n'est pas requis, qu'il
est déjà validé ou que l'âge est inférieur à 16 ans, le RDV est annulé et la
personne est prévenue. Si ces conditions restent inconnues, la réservation est
conservée jusqu'au jour J.

Un rappel est planifié pour chaque réservation active à J-1 ; pour un créneau
dans moins de 24 heures, il part immédiatement. Son objet indique explicitement
qu'il s'agit d'un rappel de test d'autonomie et demande d'imprimer le
formulaire. Le formulaire n'est pas joint : il est à récupérer dans l'espace
sécurisé du demandeur. Ce mécanisme utilise une tâche différée attachée à la
réservation, jamais un cron périodique. Les créneaux, réservations, rappels et
réévaluations restent disponibles hors saison.

Les destinataires sont validés comme adresses uniques à l'entrée de
l'authentification puis de nouveau dans les actions SMTP. Les listes de
destinataires, noms d'affichage et injections d'en-têtes sont refusés, y compris
si une ancienne donnée malformée subsiste en base. Les liens de finalisation
sont HTTPS ; `inscription_lien` est limité au domaine officiel
`caflarochebonneville.fr` et à ses sous-domaines.

## Checklist de validation e2e (à exécuter en dev une fois les secrets posés)

Cocher au fur et à mesure. La plupart nécessitent des secrets et/ou un
déploiement `npx.cmd convex dev` actif.

- [ ] **Auth/isolation 🔒** : configurer le SMTP DEV, puis email non-staff → OTP abo → n'ouvre
  QUE `/abonnements` ; `/` et les endpoints admin refusent. Staff avec tuile
  cochée → tuile visible + `/gestion-abonnements`.
- [ ] **Parcours vagues** : configurer `vague2_debut`/`vague3_debut` + peupler
  `abo_eleves_en_cours` → demande selon la vague → visible admin → validation →
  le suivi bascule sur les étapes de finalisation.
- [ ] **Plafond d'admissions** : régler un plafond, valider jusqu'à l'atteindre,
  puis tenter une validation avec deux sessions admin : la tentative au plafond
  bascule en liste d'attente avec son statut individuel. Vérifier l'e-mail
  uniquement lorsqu'il y a changement du statut global du dossier, notamment
  dans le cas d'un dossier multi-personnes ; vérifier aussi que « Valider malgré
  le plafond » reste une action explicite et que liste d'attente et refus peuvent
  toujours être choisis manuellement.
- [ ] **Licences** : importer un annuaire de test → personne sans licence obtient
  des candidats ; résolution auto (match exact) + validation manuelle la retirent
  de la file. Créer aussi un conflit entre deux dossiers : vérifier l'écran
  unique, répartir les personnes en conservant les deux dossiers, puis répéter en
  supprimant A et en supprimant B. Contrôler l'unicité de la licence, l'absence
  de personne sans dossier, les réservations et les dépendances de dossier.
  Couvrir l'accès public supprimé puis refusé par `abo-otp`, le compte staff
  conservé et les deux notifications planifiées,
  sans aucune modification du site club.
- [ ] **Test d'autonomie** : créer des créneaux (plusieurs admins) → tranches
  40/60 min à capacité cumulée ; une demande validée, sans licence, âge ni
  autonomie connus, réserve un RDV provisoire ; réserver/annuler ; supprimer un
  créneau surbooké → délogement LIFO + email `test_annule`.
- [ ] **Réévaluation et rappel du test** : après un scrap, seul un match de
  licence exact confirme un RDV lorsque le test est requis et l'âge est d'au
  moins 16 ans, ou l'annule lorsque les conditions connues ne le permettent pas.
  Sans conditions connues, le RDV reste actif. Vérifier le rappel à J-1, ou
  immédiat sous 24 h, son objet explicite et son lien vers le formulaire à
  imprimer dans l'espace sécurisé ; vérifier aussi le même parcours hors saison.
- [ ] **Formulaire du test** : depuis le suivi d'une personne validée, télécharger
  le PDF pré-rempli (date Europe/Paris, nom, prénom, licence) ; vérifier le
  rendu après réouverture et le cas d'une licence absente.
- [ ] **Règlement signé** : ouvrir DocuSeal depuis le suivi public et vérifier
  que l'étape reste en attente avant intervention du staff. Dans l'onglet
  Règlements, rechercher manuellement le PDF Drive, choisir la licence après
  recherche nom/prénom, confirmer la liaison, ouvrir le fichier depuis la file
  À enregistrer puis le marquer enregistré sur le site. Vérifier les doublons
  de fichier et de licence/version, le refus sans tuile `abonnements`, ainsi que
  la conservation après reset de campagne.
- [ ] **Compteur/anomalies** : peupler scrap/archive/élèves/validées → total
  affiché sans double comptage, bloqués exclus ; le plafond de validation reste
  distinct. L'iframe `/#/compteur` affiche les nombres **sans connexion**.
- [ ] **HelloAsso abo** : configurer le lien → sync remonte les paiements du
  formulaire abo ; statut manuel persistant ; désaccord local↔HA signalé.
- [ ] **Scraping club** : poser `CLUB_*` → « Synchroniser le site club » remonte
  les abonnés (`abo_abonnes_scrap`) et fait avancer les `etape_*` ; import élèves
  alimente `abo_eleves_en_cours` (badge « en cours »).
- [ ] **Reset saison** : archive N-1, vide scrap/paiements-abo/élèves/créneaux,
  réservations et journal d'e-mails, purge les comptes publics par lots,
  conserve les staff, **l'archive permanente des scans de tests et celle des
  règlements signés** ; nouveau lien + vagues réinitialisées.
- [ ] **Emails** : validation → email `validation` unique (pas de renvoi au
  re-scrap) ; demande → `accuse` ; création/annulation de créneau → `test_annule`.
- [ ] **Messagerie 🔒** : message instantané des deux côtés (réactivité Convex) ;
  un owner ne voit que son fil. L'espace admin affiche un compteur temps réel et
  une boîte de réception « Messages » qui priorise les conversations non lues ;
  l'ouverture du fil permet de les lire et d'y répondre. Un email
  `nouveau_message` prévient l'abonné d'une réponse administrative.
- [ ] **Non-régression compta** : login staff `google-otp` inchangé ; tuiles
  Comptabilité/Paiements/Budget intactes ; table `dossiers` (cours) non impactée.

## Nettoyage final

Les dossiers `abo-esca-new/` et `abo-esca-new/supabase/` servent uniquement de
**spécification** (contrats RPC, codes d'erreur `P0010`–`P0013`, migrations SQL,
modèle de données). Ils sont **non suivis par git** — leur suppression est
irréversible. À supprimer **une fois la checklist e2e ci-dessus validée**.
