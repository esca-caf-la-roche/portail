# Planning des salariés du samedi

Ce module répartit les groupes du samedi entre les salariés du club tout en
conservant Google Calendar comme agenda opérationnel. Il répond à deux besoins
distincts : le staff pilote l'annuaire et les attributions ; les salariés
consultent le même planning et prennent eux-mêmes un samedi encore libre.

Le module est indépendant de la tuile **Samedis après-midi**, qui organise les
réservations de la salle, prêtée ou louée. Les deux parcours peuvent concerner les mêmes dates,
mais n'utilisent ni les mêmes personnes, ni les mêmes règles métier.

## Périmètre saisonnier

Une saison va du **1er septembre au 31 août** et porte un nom `AAAA-AA`, par
exemple `2026-27`. Le planning, les affectations, les opérations Google et les
alertes sont isolés par saison. Le sélecteur de saison est disponible dans les
deux interfaces.

L'annuaire salarié est volontairement transversal : un prénom, une adresse de
connexion et une ressource Google restent valables d'une saison à l'autre.
Lorsqu'une saison contient encore une affectation, sa suppression est refusée
pour éviter de perdre une inscription réelle. Après retrait des affectations,
les créneaux importés, états de synchronisation, opérations Google et alertes
de cette saison sont supprimés en cascade ; les alertes planifiées sont
annulées au préalable.

## Parcours gestionnaire

La tuile `planning_salaries_samedis` ouvre
`/#/gestion-planning-salaries-samedis`. Elle doit être cochée explicitement
dans **Configurations > Utilisateurs**, y compris pour un administrateur.

Depuis cet écran, un gestionnaire peut :

1. récupérer les ressources visibles par le compte Google du club, cocher
   celles à activer et renseigner uniquement leur adresse e-mail de connexion
   et de communication ;
2. désactiver une fiche sans effacer son historique saisonnier ;
3. synchroniser les samedis depuis Google Calendar ;
4. attribuer ou retirer un salarié pour un samedi entier ;
5. consulter les compteurs et l'état des traitements Google et e-mail ;
6. relancer manuellement une mise à jour de ressource ou une alerte en échec.

L'écran affiche également le lien partageable
`/#/planning-salaries-samedis`, prêt à être copié et transmis aux salariés.
Lorsqu'un membre du staff déjà connecté ouvre ce lien, il est redirigé vers
l'écran de gestion plutôt que vers le parcours de connexion salarié.

Une adresse ou une ressource Google ne peut appartenir qu'à une seule fiche.
Une adresse déjà rattachée à un compte du portail staff est refusée : un salarié
isolé ne doit pas acquérir indirectement des tuiles staff, et réciproquement.
Elle est également refusée si elle appartient déjà aux espaces Abonnements ou
Samedis après-midi ; ces parcours refusent symétriquement une adresse salariée.
La désactivation révoque la connexion dédiée et détache l'identité technique,
mais ne supprime ni la fiche ni les affectations historiques. Une désactivation
ou un changement de ressource est refusé tant qu'une affectation à venir existe.

L'inventaire Google est chargé uniquement à la demande et n'est pas stocké dans
Convex. Il reflète la `CalendarList` de `escalade@caflarochebonneville.fr` : une
ressource doit donc avoir été ajoutée au calendrier de ce compte pour être
proposée. L'ajout manuel reste disponible comme solution de secours. Le
libellé Google devient le prénom proposé et peut ensuite être corrigé avec
**Modifier**. Une sélection est enregistrée dans une transaction unique : si
une adresse est refusée, aucune des ressources cochées n'est activée. L'annuaire
est borné à 50 fiches et l'interface indique le nombre de places restantes.
La récupération est limitée côté serveur à deux appels par gestionnaire et dix
appels globaux par minute afin de protéger le quota Google partagé.

## Parcours salarié isolé

L'adresse à communiquer aux salariés est
`/#/planning-salaries-samedis`. Un salarié actif reçoit un code à six chiffres,
valable dix minutes, avec le provider `planning-salaries-otp`. La première
connexion relie son compte technique à sa fiche d'annuaire.

Ce compte ne reçoit aucun `userSettings` : il n'apparaît pas dans le portail
staff, ne voit aucune autre tuile et est redirigé vers son mini-portail dédié
s'il tente d'ouvrir une route staff. Inversement, la création d'une fiche
salarié refuse une adresse déjà utilisée par le staff. Les demandes de code
sont limitées globalement et par adresse ; les messages de l'interface ne
confirment pas si une adresse figure dans l'annuaire.

Le salarié voit les prénoms et les inscriptions de toute l'équipe. Il peut
prendre un samedi libre — ce qui couvre tous ses événements — et retirer sa
propre inscription. Il ne doit pas
modifier l'inscription d'un autre salarié. Cette dernière règle doit être
contrôlée côté serveur et pas seulement par l'absence de bouton dans
l'interface.

Dans les vues gestionnaire et salarié, les cartes des samedis sont regroupées
par mois afin de rendre le planning saisonnier plus facile à parcourir sans
modifier l'unité métier de l'affectation, qui reste la date entière.

## Créneaux Google et affectations

La synchronisation lit exclusivement, dans les bornes de la saison :

- le calendrier de la ressource temporaire **À déterminer** ;
- chaque calendrier de ressource renseigné dans l'annuaire salarié, y compris
  ceux des fiches inactives pour conserver l'historique.

Aucun calendrier général et aucune variable `GOOGLE_CALENDAR_ID` ne sont
utilisés. Seuls sont importés les événements qui :

- tombent un samedi en heure de Paris ;
- sont présents dans l'un de ces calendriers de ressources.

Le libellé de chaque événement devient le nom du groupe. Plusieurs événements
le même samedi restent affichés séparément, mais ils partagent obligatoirement
une seule affectation : un salarié inscrit prend tous les événements de cette
date. L'absence d'affectation du samedi signifie **À déterminer** pour
l'ensemble de la date. L'identifiant technique de cette ressource temporaire est
`c_1885o4bj2rlv4gijgd278pfg9rub0@resource.calendar.google.com` ; il doit rester
cantonné à la configuration et à la documentation technique.

La synchronisation est déclenchée à la demande par un gestionnaire, sans cron.
Un verrou serveur de dix minutes empêche deux lectures concurrentes et un délai
de fraîcheur d'une heure évite les relectures répétées, y compris depuis le
bouton de gestion. La lecture Google est bornée à cinq pages de 250 événements
et l'import à 400 créneaux utiles par saison. Une erreur conserve le dernier
état Convex connu. Une occurrence retirée de Google est purgée du cache avec
son affectation devenue sans objet.

Google peut également être la source d'une affectation lorsque tous les
événements du samedi sont présents dans le même calendrier de ressource salarié.
Un mélange de ressources sur une même date n'est jamais arbitré automatiquement :
le samedi reste à déterminer jusqu'à ce qu'une personne le prenne, ce qui remet
alors tous ses événements sur la même ressource. Une opération locale en cours
reste prioritaire afin qu'une lecture Google ne l'écrase pas avant sa fin.

## Compteurs

Les compteurs sont calculés depuis le planning de la saison :

- **samedis** compte les dates distinctes attribuées à une ressource ;
- **À déterminer** compte les dates qui n'ont pas encore de salarié.

Ils sont visibles par les gestionnaires et par les salariés. Ils décrivent la
répartition du planning, pas un relevé contractuel d'heures travaillées.

## Mise à jour d'une ressource et reprise sur erreur

Une attribution est d'abord enregistrée dans Convex pour la date, puis une
opération asynchrone remplace, dans chacun des événements Google du samedi, la
ressource gérée précédente par la ressource du salarié. Les autres participants sont
préservés et aucun e-mail de mise à jour Google n'est envoyé. Un retrait suit
le chemin inverse et replace la ressource **À déterminer**.

Cette séparation forme une saga : l'écran peut momentanément afficher
**Mise à jour Google en cours** après l'enregistrement local. Le traitement
tente l'appel immédiatement, puis au maximum deux reprises automatiques avec
un délai croissant d'une puis deux minutes. Après trois échecs, le gestionnaire
voit l'erreur et peut la relancer ; la relance remet le compteur de tentatives à
zéro. Une nouvelle attribution du même samedi est refusée tant qu'une de ses
mises à jour Google n'est pas terminée.

## Rappel urgent du lundi

Pour chaque samedi sans salarié affecté, une alerte
unique est planifiée **le lundi précédent à 09 h, heure de Paris**. Si la
réconciliation a lieu après cette échéance mais avant la fin du samedi, elle est
programmée immédiatement ; aucun message historique ne part pour une date déjà
passée. L'alerte est annulée avant envoi dès qu'un salarié prend la date entière.
Une tâche issue de l'ancien horaire J-7 qui se déclenche trop tôt est différée
automatiquement au lundi 09 h.

Le message :

- est envoyé à `escalade@caflarochebonneville.fr` comme destinataire principal ;
- place les adresses de tous les salariés actifs en CCI, afin de ne pas exposer
  l'annuaire à chacun ;
- liste tous les groupes du samedi concerné ;
- utilise la boîte SMTP générale déjà configurée par `EMAIL_SENDER` et
  `EMAIL_PASSWORD`. En production, `EMAIL_SENDER` doit correspondre à
  `escalade@caflarochebonneville.fr` pour respecter l'identité d'envoi attendue.

L'envoi est tenté au maximum trois fois selon le même rythme immédiat, une
minute puis deux minutes. Un échec persistant apparaît dans l'écran de gestion
et peut être relancé. Le même transport SMTP sert aux codes OTP du module.

Il n'existe pas de balayage périodique : la planification des alertes est
réconciliée après une synchronisation Google et après une affectation ou un
retrait. Une modification faite directement dans Google doit donc être suivie
d'une synchronisation du module pour mettre à jour les alertes.

## Configuration Convex et Google

La lecture et l'écriture utilisent deux identités distinctes. Le compte de
service existant lit les événements des calendriers de ressources ; un OAuth utilisateur
autorisé par `escalade@caflarochebonneville.fr` modifie les participants avec
les mêmes droits que cette boîte dans Google Calendar et liste ses calendriers
de ressources visibles.

| Variable | Usage |
|---|---|
| `GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL` | Adresse du compte de service Google déjà utilisé pour Drive |
| `GOOGLE_DRIVE_PRIVATE_KEY` | Clé privée de ce compte de service |
| `GOOGLE_CALENDAR_OAUTH_CLIENT_ID` | Client OAuth du projet Google Cloud |
| `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET` | Secret de ce client OAuth |
| `GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN` | Autorisation hors-ligne accordée par la boîte du club |
| `EMAIL_SENDER` | Compte SMTP général du portail et adresse d'expédition |
| `EMAIL_PASSWORD` | Mot de passe d'application de cette boîte SMTP |

Côté Google :

1. l'API Google Calendar doit être activée dans le projet Google Cloud du
   compte de service existant ;
2. configurer l'écran de consentement OAuth avec une audience interne, puis
   créer un client OAuth de type « Application de bureau » ou un client Web
   possédant une URI de redirection HTTP locale ;
3. télécharger le fichier JSON de ce client sans copier son secret dans un
   terminal, une conversation ou le dépôt ;
4. depuis la racine du projet, exécuter la commande suivante en remplaçant le
   chemin par celui du fichier téléchargé :

   ```powershell
   npm run google-calendar:oauth -- --both "C:\chemin\client_secret.json"
   ```

   Le script ouvre uniquement le callback local déclaré par le client, demande de se
   connecter avec `escalade@caflarochebonneville.fr`, vérifie cette identité et
   enregistre les mêmes secrets dans les déploiements Convex DEV et PROD. Le seul
   périmètre métier demandé est
   `https://www.googleapis.com/auth/calendar.events` et
   `https://www.googleapis.com/auth/calendar.calendarlist.readonly` ;
5. supprimer ensuite le fichier JSON téléchargé ou le conserver dans un coffre
   à secrets hors du dépôt ;
6. partager en lecture avec le compte de service la ressource **À déterminer**
   et chaque ressource de l'annuaire ;
7. vérifier que `escalade@caflarochebonneville.fr` peut modifier les événements
   sur leur calendrier organisateur. Si un cours est organisé par un autre
   calendrier, cette boîte doit y avoir le droit « Modifier les événements » ;
8. tester sur un événement non critique que le remplacement d'une ressource est
   accepté sans notification (`sendUpdates: none`).

La lecture est faite directement par le compte de service, exclusivement dans
les calendriers de ressources configurés dans l'annuaire et dans **À
déterminer**. Pour modifier les participants, le module utilise la copie
organisatrice de l'événement et l'OAuth hors-ligne de la boîte du club. Cette
solution ne demande ni rôle super-administrateur ni délégation au niveau du
domaine. Si l'autorisation est révoquée ou expire, il faut relancer le script de
configuration et remplacer uniquement le jeton de renouvellement.

## Limites et risques connus

- Sans cron de rattrapage, un planning jamais synchronisé ou une modification
  externe non resynchronisée ne peut pas produire le rappel du lundi attendu.
- Les événements absents de tous les calendriers de ressources gérés sont
  ignorés, tout comme les jours autres que le samedi.
- La synchronisation est volontairement bornée ; au-delà de 400 créneaux utiles
  ou de cinq pages Google, elle échoue en conservant les données précédentes.
- Une affectation locale peut être visible avant sa confirmation Google. Le
  statut et les files d'échec doivent être surveillés par un gestionnaire.
- Le secret du compte de service, le jeton OAuth et le mot de passe SMTP donnent
  accès à des systèmes externes : ils doivent rester dans les variables Convex
  et être révoqués en cas d'exposition.
- La version actuelle de Convex Auth ne rend pas parfaitement indistinguables
  les adresses autorisées et inconnues au niveau réseau ; cette limite est la
  même que pour le parcours Samedis et justifie de ne pas présenter le rate
  limiting comme une protection complète contre l'énumération.

## Checklist de validation manuelle

- [ ] Attribuer la tuile à un gestionnaire, puis vérifier la tuile, la route et
  le refus complet pour un staff sans cette tuile, y compris administrateur.
- [ ] Récupérer les ressources Google, en cocher une, saisir son e-mail puis
  vérifier son activation ; contrôler aussi le secours d'ajout manuel.
- [ ] Vérifier l'unicité de l'e-mail et de la ressource,
  puis vérifier le refus d'une adresse déjà utilisée par le portail staff.
- [ ] Se connecter avec `planning-salaries-otp`, contrôler l'isolement des
  autres tuiles, la redirection depuis une route staff et la révocation après
  désactivation de la fiche.
- [ ] Depuis la gestion, copier le lien partageable, l'ouvrir comme salarié non
  connecté, puis l'ouvrir avec une session staff active et vérifier la
  redirection vers la gestion.
- [ ] Changer de saison et vérifier les bornes du 1er septembre au 31 août ainsi
  que l'absence de mélange entre saisons.
- [ ] Synchroniser un samedi avec deux groupes et contrôler qu'une seule
  affectation est proposée pour toute la date.
- [ ] Vérifier sur les vues gestionnaire et salarié que les cartes sont
  regroupées sous le bon mois et restent dans l'ordre chronologique.
- [ ] Avec deux salariés, vérifier que chacun voit l'inscription de l'autre,
  peut prendre un samedi libre et retirer uniquement sa propre inscription.
- [ ] Affecter puis retirer un salarié et vérifier dans tous les événements
  Google du samedi le remplacement de ressource, la conservation des autres participants et
  l'absence d'e-mail Google.
- [ ] Simuler une erreur Google, contrôler les trois tentatives, l'état en
  erreur, la conservation de l'affectation locale et la relance manuelle.
- [ ] Révoquer temporairement l'autorisation OAuth, vérifier qu'une écriture
  échoue sans exposer le jeton, puis reconnecter la boîte du club.
- [ ] Laisser un samedi sans salarié, vérifier la planification le lundi précédent à 09 h de
  Paris, le destinataire principal, les salariés actifs en CCI et la liste de
  tous les groupes.
- [ ] Affecter le samedi avant l'échéance et vérifier l'annulation de l'alerte ;
  simuler ensuite une panne SMTP et tester la relance.
- [ ] Tenter de supprimer une saison contenant une affectation, puis retirer
  les affectations et vérifier la cascade des seules données saisonnières.
- [ ] Vérifier au clavier et sur mobile le sélecteur de saison, les boutons de
  prise/retrait, l'annuaire, les états de chargement et les messages d'erreur ;
  sur mobile, contrôler aussi que le badge de synchronisation ne déborde pas
  de son conteneur.
