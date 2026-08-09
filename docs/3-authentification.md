# Authentification par OTP avec Convex Auth

La sécurité repose sur `@convex-dev/auth` et deux providers OTP à 6 chiffres :

| Population | Provider | Création du compte | Espace accessible |
|---|---|---|---|
| Staff et bénévoles | `google-otp` | Email créé au préalable par un administrateur | Tuiles attribuées dans `userSettings.allowedTiles` |
| Abonnés publics | `abo-otp` | Auto-inscription | Parcours isolé `/#/abonnements` |

L'auto-inscription publique ne concerne donc que le module Abonnements. Elle ne
crée aucun `userSettings` et ne donne accès à aucune tuile staff. Voir
[5-module-abonnements.md](5-module-abonnements.md) pour ce parcours.

## Connexion du staff

1. **Vérification de l'adresse email** :
   - L'utilisateur saisit son adresse email dans le formulaire de connexion.
   - Le frontend appelle directement `signIn("google-otp", { email })` de
     `@convex-dev/auth`. Il ne vérifie pas publiquement si l'adresse appartient
     au staff, afin de ne pas permettre l'énumération des comptes.
   - Côté serveur, la demande est limitée par adresse canonique. Une adresse
     absente ou au-delà du quota reçoit le même échec générique qu'un code
     incorrect ou expiré.

2. **Génération et envoi du code OTP** :
   - Le serveur génère un code OTP aléatoire sécurisé à 6 chiffres avec une validité de 10 minutes.
   - La callback d'authentification vérifie côté serveur que l'adresse correspond
     à un utilisateur staff avant de créer une session. La décision est prise
     avant l'envoi, puis l'e-mail est planifié par une action interne.
   - L'action Node.js interne `internal.email.sendOTP` est exécutée pour envoyer l'e-mail :
     - **Mode Production / SMTP** : Si les variables d'environnement `EMAIL_SENDER` et `EMAIL_PASSWORD` (mot de passe d'application Google) sont définies, l'e-mail contenant l'OTP est envoyé directement via Gmail.
     - **Configuration absente** : Si les variables ne sont pas définies, l'envoi échoue explicitement. Le code OTP n'est jamais écrit dans les logs ; les secrets SMTP doivent donc être configurés aussi sur le déploiement DEV utilisé pour les essais d'authentification.

3. **Vérification et Session** :
   - L'utilisateur saisit le code reçu.
   - Le frontend appelle `signIn("google-otp", { email, code })`.
   - La callback `createOrUpdateUser` intercepte l'inscription/connexion pour s'assurer que l'email correspond bien à un utilisateur pré-enregistré dans la table `users`. Si l'utilisateur n'existe pas, l'authentification échoue (interdiction de création de compte à la volée).
   - En cas de succès, `@convex-dev/auth` gère les jetons et l'état de session.

## Connexion des abonnés publics

Le provider `abo-otp` envoie également un code valable 10 minutes, avec la boîte
mail dédiée aux abonnements. Sa callback crée ou retrouve l'utilisateur puis
crée, si nécessaire, un profil `abo_profiles` de rôle `utilisateur`. Son quota
est distinct de celui du staff. Lorsqu'un ancien dossier public a été regroupé
dans une résolution de conflit, l'ancienne adresse ne devient jamais un alias :
la demande de code reste neutre, mais la vérification refuse ensuite l'accès et
oriente vers l'e-mail privé de résolution.

L'absence de `userSettings` empêche ce compte d'accéder au tableau de bord et
aux modules staff. Les autorisations du domaine Abonnements sont dérivées côté
serveur par `convex/abo/auth.ts`.

## Gestion des accès staff

Toutes les routes staff sont encapsulées dans le composant `Layout.tsx`.
Le statut de l'authentification est vérifié via `useConvexAuth()` fourni par
Convex. Si l'utilisateur n'est pas connecté (`isAuthenticated === false`), il
est redirigé vers `/login`.

`RequireAccess` vérifie ensuite la tuile demandée, et les helpers Convex répètent
ce contrôle côté backend. Le rôle administrateur n'accorde pas automatiquement
les tuiles : il est réservé à la page Configurations.
