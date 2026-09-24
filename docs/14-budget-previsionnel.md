# Budget prévisionnel

Ce document décrit le contrat métier de l'onglet « Répartition des recettes ».
Il complète l'architecture générale sans dupliquer le fonctionnement des autres
onglets du Budget.

## Parcours staff

Depuis la tuile **Budget prévisionnel**, choisir la saison puis ouvrir l'onglet
**Répartition des recettes**. L'écran présente :

- un camembert de toutes les recettes prévisionnelles positives, regroupées par
  analytique ;
- une carte **ESC01 — Cours mineurs** et une carte **ESC02 — Cours adultes** qui
  affichent la recette maximale, la dépense salariale, le résultat et le
  résultat par participant à capacité pleine.

Aucune donnée propre à cet onglet n'est à renseigner. Le détail reprend
directement les analytiques déjà affectées aux types de cours dans l'onglet
**Planning des cours**.

## Sources et calculs

Tous les calculs utilisent exclusivement la saison sélectionnée.

### Camembert des recettes

Le camembert part des lignes de `previsionnels` dont le montant est strictement
positif. Il additionne les lignes qui partagent la même analytique, y compris
les recettes saisies manuellement. Les montants nuls et les dépenses ne sont
pas représentés.

Ce choix répond à une question de composition des entrées attendues, et non de
solde budgétaire : les dépenses restent consultables dans le prévisionnel.

### Périmètre des cours et participants

Le code placé au début du nom de l'analytique du planning détermine le périmètre :

| Analytique | Carte |
|---|---|
| `ESC01` (par exemple `ESC01 : Cours mineurs`) | Cours mineurs |
| `ESC02` (par exemple `ESC02 : Cours adultes`) | Cours adultes |

Les cours rattachés à une autre analytique restent représentés dans le
camembert lorsqu'ils alimentent une recette prévisionnelle positive, mais ils
n'apparaissent dans aucune de ces deux cartes. Il n'existe ni déduction à
partir du nom du cours, ni classement manuel parallèle.

Le calcul suppose tous les créneaux remplis. Pour chaque analytique :

```text
recette du créneau = tarif annuel du type × capacité maximale
recette de l'analytique = somme des recettes de ses créneaux
participants de l'analytique = somme des capacités maximales de ses créneaux
```

Il s'agit d'une projection à capacité pleine, pas du montant encaissé ni du
nombre réel d'inscrits. Un type proposé sur plusieurs créneaux contribue donc
une fois par créneau. Le nombre de participants n'est ni saisi ni persisté pour
ce calcul : il est toujours déduit des capacités du planning.

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
saison. Ce coût complet est ensuite ventilé entre les analytiques au prorata
des heures de cours payées du salarié. Les heures de réunion et les heures
supplémentaires sont ainsi réparties avec le reste de son coût. Les autres
analytiques restent dans le dénominateur de cette ventilation, afin que les
cartes `ESC01` et `ESC02` ne s'attribuent pas le coût de cours hors périmètre.

Si les paramètres de paie, la masse salariale ou les heures ventilables manquent,
l'écran conserve les recettes mais affiche le coût et le résultat comme
indisponibles. Une donnée absente ne doit jamais être interprétée comme un coût
nul.

### Résultat par participant

```text
résultat de l'analytique = recette maximale - coût employeur ventilé
résultat par participant = résultat de l'analytique / somme des capacités maximales
```

Le ratio n'est pas calculé lorsque l'analytique ne contient aucun participant,
afin d'éviter une division par zéro. Il mesure un résultat théorique à capacité
pleine ; il ne représente ni la fréquentation réelle ni la recette encaissée.

## Retrait des champs devenus inutiles

Une première version de l'onglet avait ajouté une classification des cours par
public et deux compteurs par catégorie. Ces données doublonnent
l'analytique et la capacité déjà présentes dans le planning ; elles sont donc
retirées selon une migration **migrate → narrow** :

1. la migration de nettoyage des cours efface l'ancien champ de classification ;
2. `clearBudgetEffectifsCours` efface les anciens effectifs mineurs/adultes,
   sans modifier `budgetEffectifs.nbMembresLoisir` ;
3. les inspections internes des cours et de `budgetEffectifs` contrôlent par
   pages qu'aucune valeur obsolète ne subsiste en DEV puis en PROD ;
4. les champs optionnels sont supprimés du schéma dans un déploiement ultérieur
   après validation des deux inspections.

Cette migration ne reclasse aucun cours et ne demande aucune reprise manuelle :
`ESC01`, `ESC02`, les tarifs et les capacités du planning restent les seules
données métier du calcul.

## Droits et saison

La fonctionnalité respecte le contrat de la tuile `budget` :

- la tuile doit figurer dans `userSettings.allowedTiles` pour ouvrir la route et
  lire les agrégats via `budgetRecettes.getRepartition` ;
- le rôle administrateur ne donne aucun passe-droit lorsque la tuile est absente ;
- toutes les lectures sont indexées ou rattachées à la saison sélectionnée ; un
  changement de saison ne doit jamais réutiliser le planning, le prévisionnel ou
  la paie de la précédente.

Les scénarios de validation et les commandes associées sont centralisés dans
[9-tests.md](9-tests.md#scénarios-ciblés--répartition-des-recettes-du-budget).
