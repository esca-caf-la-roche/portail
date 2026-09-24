# Budget prévisionnel

Ce document décrit le contrat métier de l'onglet « Répartition des recettes ».
Il complète l'architecture générale sans dupliquer le fonctionnement des autres
onglets du Budget.

## Parcours staff

Depuis la tuile **Budget prévisionnel**, choisir la saison puis ouvrir l'onglet
**Répartition des recettes**. L'écran présente :

- un camembert de toutes les recettes prévisionnelles positives, regroupées par
  analytique ;
- une carte **Cours mineurs** et une carte **Cours adultes** qui affichent la
  recette maximale, la dépense salariale, le résultat et le résultat par
  participant ;
- un avertissement lorsqu'un ancien cours n'est pas encore classé comme
  `mineurs` ou `adultes` ;
- la saisie des effectifs réellement inscrits en cours pour les membres du staff
  autorisés sur la tuile.

Les corrections de public se font dans l'onglet **Planning des cours**. Le
public cible est une propriété du type de cours : sa modification est propagée
à tous les créneaux portant le même nom dans la saison.

## Sources et calculs

Tous les calculs utilisent exclusivement la saison sélectionnée.

### Camembert des recettes

Le camembert part des lignes de `previsionnels` dont le montant est strictement
positif. Il additionne les lignes qui partagent la même analytique, y compris
les recettes saisies manuellement. Les montants nuls et les dépenses ne sont
pas représentés.

Ce choix répond à une question de composition des entrées attendues, et non de
solde budgétaire : les dépenses restent consultables dans le prévisionnel.

### Recettes des cours

Pour chaque public, la recette maximale est calculée sur chaque créneau :

```text
recette du créneau = tarif annuel du type × capacité maximale
recette du public = somme des recettes de ses créneaux
```

Il s'agit d'une capacité théorique, pas du montant encaissé ni du nombre réel
d'inscrits. Un type proposé sur plusieurs créneaux contribue donc une fois par
créneau.

### Dépense salariale

Le coût employeur complet est recalculé avec les paramètres de paie de la
saison. Pour chaque salarié :

```text
heures de cours payées = durée hebdomadaire × semaines du moniteur × 1,25
heures annuelles du calcul = heures de cours payées + 5 h de réunion + heures supplémentaires
```

Le coefficient `1,25` couvre les quinze minutes de préparation par heure de
cours. Le coût employeur produit par le calcul de paie inclut le brut, les
cotisations patronales et les autres paramètres employeur configurés pour la
saison. Ce coût complet est ensuite ventilé entre mineurs et adultes au prorata
des heures de cours payées du salarié. Les heures de réunion et les heures
supplémentaires sont ainsi réparties avec le reste de son coût.

Si les paramètres de paie, la masse salariale ou les heures ventilables manquent,
l'écran conserve les recettes mais affiche le coût et le résultat comme
indisponibles. Une donnée absente ne doit jamais être interprétée comme un coût
nul.

### Résultat par participant

```text
résultat du public = recette maximale - coût employeur ventilé
résultat par participant = résultat du public / effectif réel saisi
```

Les effectifs mineurs et adultes sont saisis pour la saison et arrondis à un
entier positif ou nul. Le ratio n'est pas calculé lorsque l'effectif est absent
ou nul, afin d'éviter une division trompeuse. Il mesure le résultat théorique
rapporté à l'effectif réel ; il ne transforme pas la recette maximale en recette
encaissée.

## Cours historiques et migration

Le champ `cours.publicCible` est volontairement optionnel pendant la migration
des saisons existantes. La stratégie suit **widen → migrate → narrow** :

1. accepter le nouveau champ sans invalider les documents historiques ;
2. inspecter les cours en lots avec `inspectCoursPublicCible` ;
3. exécuter `migrateCoursPublicCible` d'abord en DEV, puis en PROD après
   validation explicite ; la migration idempotente ne classe que les noms sans
   ambiguïté et ne remplace jamais une correction manuelle ;
4. corriger dans **Planning des cours** les noms ambigus restés non classés ;
5. rendre le champ obligatoire seulement dans un déploiement ultérieur, après
   inspection complète des deux environnements.

Un cours non classé reste visible dans l'avertissement avec son nombre de
créneaux, ses heures et sa recette potentielle. Il est exclu des cartes mineurs
et adultes : cette mise à l'écart explicite évite de fausser silencieusement un
des deux publics.

Les champs d'effectifs réels dans `budgetEffectifs` restent eux aussi optionnels
pour les saisons historiques. Leur absence affiche un ratio indisponible et ne
déclenche aucun remplissage arbitraire.

## Droits et saison

La fonctionnalité respecte le contrat de la tuile `budget` :

- la tuile doit figurer dans `userSettings.allowedTiles` pour ouvrir la route et
  lire les agrégats via `budgetRecettes.getRepartition` ;
- le rôle administrateur ne donne aucun passe-droit lorsque la tuile est absente ;
- la mutation de persistance des effectifs et son formulaire exigent eux aussi
  la tuile `budget` ;
- toutes les lectures et écritures sont indexées ou rattachées à la saison
  sélectionnée ; un changement de saison ne doit jamais réutiliser les effectifs
  ni les calculs de la précédente.

Les scénarios de validation et les commandes associées sont centralisés dans
[9-tests.md](9-tests.md#scénarios-ciblés--répartition-des-recettes-du-budget).
