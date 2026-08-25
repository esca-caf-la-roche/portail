# Module Samedis après-midi

Le module organise les permanences du samedi du club sur la saison globale. Il
sépare l'administration staff du calendrier simplifié destiné aux participants,
afin que ces derniers n'entrent jamais dans les autres tuiles du portail.

## Règles métier

- une saison fournit la période de début et de fin ; seuls les samedis compris
  dans cette période deviennent des créneaux ;
- un samedi accepte au plus une réservation et un participant peut réserver
  plusieurs samedis ; son compteur est le nombre de réservations de la saison ;
- un participant actif peut prendre une date libre et annuler uniquement sa
  propre réservation ; il ne voit pas l'identité de la personne qui occupe une
  autre date ;
- une date fériée, comprise dans les vacances scolaires ou bloquée manuellement
  est indisponible pour les participants ;
- un gestionnaire peut attribuer ou annuler une permanence pour une personne.
  Attribuer une date bloquée exige une confirmation explicite ;
- si une synchronisation officielle révèle qu'une réservation ordinaire est
  désormais sur une date bloquée, elle n'est pas supprimée silencieusement.
  L'agenda la signale « à régulariser » : le gestionnaire la maintient, ou
  l'annule.

Pour les vacances scolaires ordinaires, les dates officielles indiquent le
départ après les cours et la reprise des cours le matin. Seuls les samedis
strictement compris entre ces deux dates sont donc bloqués : le samedi de
départ reste disponible, une semaine complète bloque un samedi et deux semaines
complètes en bloquent deux. Une fermeture officielle ponctuelle publiée sur un
vendredi, comme le pont de l'Ascension 2027, bloque le samedi qui la suit ; une
fermeture ponctuelle publiée sur un samedi ne bloque pas ce samedi.

Les interfaces gestionnaire et participant présentent les samedis sous forme
d'agenda groupé par mois. Les badges « Jour férié », « Vacances scolaires » et
« Blocage du club » sont textuels et visuellement distincts ; la couleur n'est
pas la seule source d'information.

## Accès et routes

| Population | Route | Contrat d'accès |
|---|---|---|
| Participant | `/#/samedis` | Provider `samedi-otp`, fiche active dans `samedis_participants` |
| Gestionnaire | `/#/gestion-samedis` | Compte staff et `userSettings.allowedTiles` contenant `samedis` |

Le rôle `admin` ne remplace jamais la tuile. La visibilité du dashboard, la
route `RequireAccess` et tous les endpoints gestionnaires appliquent le même
contrat. Le participant créé par `samedi-otp` n'obtient ni `userSettings`, ni
profil Abonnements. Les détails et la limite connue du provider sont documentés
dans [3-authentification.md](3-authentification.md).

## Données et saison

Les tables `samedis_configurations`, `samedis_creneaux` et
`samedis_reservations` sont saisonnières et indexées par `saison`. Les créneaux
sont aussi indexés par saison et date pour conserver l'ordre chronologique.

Les fiches `samedis_participants` sont hors saison : une personne autorisée ne
doit pas être recréée chaque année. `samedis_notifications` est également hors
saison, car l'état d'un envoi et ses tentatives forment une trace opérationnelle
indépendante de la suppression d'une saison.

Supprimer une saison est refusé tant qu'elle contient des réservations. Une fois
celles-ci annulées, la configuration et les créneaux de cette saison peuvent
être supprimés avec elle.

## Calendrier officiel

Le gestionnaire lance **Vérifier le calendrier** après avoir défini ou modifié
la période. La réservation reste fermée tant que cette configuration n'a pas
été synchronisée avec succès.

La synchronisation lit deux sources publiques :

- l'API gouvernementale des jours fériés métropolitains, année par année ;
- le jeu de données du ministère de l'Éducation nationale
  `fr-en-calendrier-scolaire`, filtré sur Grenoble, académie de la zone A.

Elle est déclenchée à la demande et protégée par un verrou partagé. Le cache
d'une heure évite les appels automatiques répétés, mais le bouton gestionnaire
permet une actualisation manuelle immédiate ; seul un double appel dans les
trente secondes est refusé. Aucun cron n'est ajouté. Une panne conserve les
derniers blocages connus, affiche l'erreur au gestionnaire et laisse les
réservations fermées si la configuration courante n'a pas encore été validée.

## Gestion quotidienne

Depuis `/#/gestion-samedis`, un gestionnaire :

1. sélectionne la saison globale puis définit la période ;
2. synchronise les jours fériés et vacances de Grenoble ;
3. ajoute les participants autorisés par nom et e-mail, ou désactive un accès ;
4. suit le compteur individuel et l'état libre, attribué ou indisponible de
   chaque date dans l'agenda ;
5. ouvre les actions avancées d'un samedi pour poser un blocage manuel ;
6. traite les réservations signalées à régulariser ;
7. relance, si nécessaire, une synthèse e-mail en échec.

Modifier la période peut retirer les samedis non réservés qui sortent du nouvel
intervalle ; l'interface demande confirmation. Une date portant une réservation
n'est pas retirée automatiquement.

## Notifications de modification

Chaque modification métier crée d'abord une entrée dans une outbox Convex, puis
planifie son envoi SMTP immédiat vers l'adresse fixe de synthèse du club. Sont
concernés la configuration, les participants, les créneaux, les réservations,
les régularisations et la synchronisation du calendrier.

L'enregistrement métier ne dépend pas de la disponibilité SMTP. Un échec est
conservé avec son nombre de tentatives ; le serveur effectue jusqu'à trois
essais avec délai croissant. La page gestionnaire affiche les cinquante derniers
échecs et permet une relance manuelle. Les variables SMTP restent des secrets
Convex et ne doivent pas être placées dans le frontend ou la documentation.

## Checklist de validation manuelle

1. attribuer la tuile `samedis` à un compte staff, vérifier la tuile, la route
   gestionnaire et les endpoints ; retirer la tuile puis vérifier le refus,
   y compris si le compte conserve le rôle admin ;
2. créer une période couvrant plusieurs mois, vérifier que seuls les samedis
   apparaissent, dans l'ordre et groupés par mois ; réduire ensuite la période
   et contrôler la confirmation ainsi que la conservation d'une date réservée ;
3. lancer la synchronisation, vérifier les badges explicites pour un jour férié
   et des vacances de Grenoble. Vérifier que le premier samedi, lorsque les
   vacances commencent après les cours, reste disponible ; relancer ensuite
   dans l'heure : aucun second appel externe ne doit partir ;
4. simuler une panne des sources officielles : le dernier calendrier connu doit
   rester visible, l'erreur doit apparaître et une configuration non validée ne
   doit accepter aucune réservation ;
5. ajouter un participant, se connecter sur `/#/samedis` avec `samedi-otp`,
   réserver une date libre puis l'annuler. Le compteur doit suivre et l'identité
   d'un autre réservant ne doit jamais être exposée ;
6. désactiver ce participant et vérifier le refus de la connexion et des
   mutations. Essayer une adresse inconnue : aucun compte ne doit être créé et
   l'interface doit rester générique ; contrôler séparément la limite réseau
   documentée dans [3-authentification.md](3-authentification.md) ;
7. faire réserver simultanément la même date par deux personnes : une seule
   réservation doit réussir ; vérifier qu'une personne ne peut annuler que sa
   propre réservation ;
8. depuis l'agenda staff, attribuer une date libre. Sur une date fériée, de
   vacances ou bloquée manuellement, vérifier que le forçage est confirmé sans
   demander de motif ;
9. créer une réservation ordinaire, puis synchroniser un blocage officiel sur
   cette date. Elle doit rester présente avec l'alerte de régularisation ; tester
   les deux sorties : annulation ou maintien explicite ;
10. provoquer un échec SMTP : la modification métier doit rester enregistrée,
    l'échec doit apparaître dans la page de gestion et **Réessayer** doit relancer
    l'outbox sans rejouer la modification ;
11. changer de saison et vérifier l'isolation des configurations, créneaux,
    réservations et compteurs, tout en conservant la liste des participants ;
12. contrôler l'agenda au clavier, sur mobile et sur desktop : libellés de
    blocage lisibles, actions tactiles, formulaires et messages d'erreur.

Les appels aux API officielles et au SMTP doivent être simulés dans les tests
automatisés. Aucun test local ne doit dépendre des données ou secrets de
production.
