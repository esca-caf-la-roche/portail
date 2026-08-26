import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  useAction,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  Archive,
  Check,
  ChevronDown,
  ExternalLink,
  Link2,
  Mail,
  Pencil,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  Unlink,
  Users,
  X,
} from "lucide-react";
import { api } from "../../convex/_generated/api";
import {
  creerLienGmailRemboursement,
  creerLienGmailRemboursementGroupe,
  eurosVersCentimes,
  formatEuros,
  LIENS_HELLOASSO_REMBOURSEMENTS,
  messageErreurRemboursement,
  normaliserRechercheRemboursement,
  preparerEmailRemboursement,
  preparerEmailRemboursementGroupe,
  type TypeEmailRemboursement,
  type TypeFormulaireRemboursement,
} from "../utils/remboursements";
import { normaliserAdresseEmailUnique } from "../utils/contactsCours";

type Demande = FunctionReturnType<
  typeof api.remboursements.listDemandes
>["page"][number];
type Beneficiaire = Demande["beneficiaires"][number];
type Eleve = FunctionReturnType<typeof api.remboursements.listEleves>[number];
type Paiement = FunctionReturnType<
  typeof api.remboursements.listPaiementsDisponibles
>["page"][number];
type StatutListe = "active" | "archivee";

function formatDate(value: string | null): string {
  if (!value) return "Date non renseignée";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(date);
}

function formatDateHeure(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("fr-FR", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function libelleType(type: TypeFormulaireRemboursement): string {
  return type === "competition" ? "Compétition" : "Stage";
}

function RapprochementPanel({
  demandeId,
  beneficiaire,
  onFermer,
}: {
  demandeId: Demande["demandeId"];
  beneficiaire: Beneficiaire;
  onFermer: () => void;
}) {
  const {
    results: paiements,
    status: paginationPaiements,
    loadMore: chargerPlusPaiements,
  } = usePaginatedQuery(
    api.remboursements.listPaiementsDisponibles,
    {
      demandeId,
      beneficiaireId: beneficiaire.beneficiaireId,
    },
    { initialNumItems: 25 },
  );
  const rapprocher = useMutation(api.remboursements.rapprocherPaiement);
  const [selection, setSelection] = useState<Paiement["paiementId"] | "">("");
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const disponibles = paiements;

  const valider = async () => {
    if (!selection) return;
    setEnCours(true);
    setErreur(null);
    try {
      await rapprocher({
        beneficiaireId: beneficiaire.beneficiaireId,
        paiementId: selection,
      });
      onFermer();
    } catch (error) {
      setErreur(
        messageErreurRemboursement(
          error,
          "Le rapprochement n’a pas pu être enregistré.",
        ),
      );
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="remb-match" aria-label={`Rapprocher ${beneficiaire.prenom} ${beneficiaire.nom}`}>
      <div className="remb-match-heading">
        <div>
          <h4>Paiements du bon formulaire HelloAsso</h4>
          <p>Sélectionnez une ligne, vérifiez les indices, puis validez explicitement.</p>
        </div>
        <button type="button" className="remb-icon-button" onClick={onFermer} aria-label="Fermer le rapprochement">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      {erreur && <p className="remb-alert remb-alert--error" role="alert">{erreur}</p>}
      {paginationPaiements === "LoadingFirstPage" ? (
        <p className="remb-inline-state" role="status">Chargement des paiements…</p>
      ) : disponibles.length === 0 && paginationPaiements === "Exhausted" ? (
        <p className="remb-inline-state">Aucun paiement autorisé et disponible pour ce formulaire.</p>
      ) : (
        <>
          {disponibles.length === 0 && (
            <p className="remb-inline-state">
              Aucun paiement disponible dans les résultats chargés.
            </p>
          )}
          {disponibles.length > 0 && (
            <fieldset className="remb-payment-list">
              <legend className="sr-only">Paiement à rapprocher</legend>
              {disponibles.map((paiement) => {
                const suggestion = paiement.suggestion;
                return (
                  <label className="remb-payment-option" key={paiement.paiementId}>
                    <input
                      type="radio"
                      name={`paiement-${beneficiaire.beneficiaireId}`}
                      value={paiement.paiementId}
                      checked={selection === paiement.paiementId}
                      onChange={() => setSelection(paiement.paiementId)}
                    />
                    <span className="remb-payment-main">
                      <strong>
                        {paiement.payeurPrenom} {paiement.payeurNom} · {formatEuros(paiement.amountCentimes)}
                      </strong>
                      <small>{paiement.payeurEmail} · {formatDate(paiement.datePaiement)}</small>
                      {paiement.participantNom || paiement.participantPrenom ? (
                        <small>
                          Participant : {paiement.participantPrenom} {paiement.participantNom}
                        </small>
                      ) : null}
                    </span>
                    <span className={`remb-suggestion${suggestion ? "" : " remb-suggestion--none"}`}>
                      {suggestion ? (
                        <>
                          Suggestion {suggestion.score}/100
                          <small>{suggestion.raisons.join(" · ")}</small>
                        </>
                      ) : "Aucun indice commun"}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
          {(paginationPaiements === "CanLoadMore" ||
            paginationPaiements === "LoadingMore") && (
            <button
              type="button"
              className="remb-button remb-button--quiet"
              disabled={paginationPaiements === "LoadingMore"}
              onClick={() => chargerPlusPaiements(25)}
            >
              {paginationPaiements === "LoadingMore"
                ? "Chargement…"
                : "Afficher plus de paiements"}
            </button>
          )}
        </>
      )}
      <div className="remb-match-actions">
        <button type="button" className="remb-button remb-button--quiet" onClick={onFermer}>
          Annuler
        </button>
        <button
          type="button"
          className="remb-button"
          disabled={!selection || enCours}
          onClick={() => void valider()}
        >
          <Link2 size={17} aria-hidden="true" />
          {enCours ? "Rapprochement…" : "Valider le rapprochement"}
        </button>
      </div>
    </div>
  );
}

function CreationDemande({
  eleves,
  onFermer,
}: {
  eleves: Eleve[] | undefined;
  onFermer: () => void;
}) {
  const creer = useMutation(api.remboursements.creerDemande);
  const [typeFormulaire, setTypeFormulaire] =
    useState<TypeFormulaireRemboursement>("competition");
  const [libelle, setLibelle] = useState("");
  const [description, setDescription] = useState("");
  const [dateEvenement, setDateEvenement] = useState("");
  const [modeCalcul, setModeCalcul] =
    useState<"total_reparti" | "prix_fixe_personne">("total_reparti");
  const [montant, setMontant] = useState("");
  const [recherche, setRecherche] = useState("");
  const [selection, setSelection] = useState<Set<Eleve["eleveId"]>>(
    () => new Set(),
  );
  const [parents, setParents] = useState<Record<string, { parent1Nom: string; parent1Prenom: string; parent2Nom: string; parent2Prenom: string }>>({});
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const elevesFiltres = useMemo(() => {
    const terme = normaliserRechercheRemboursement(recherche);
    const trouves = (eleves ?? []).filter((eleve) =>
      normaliserRechercheRemboursement(
        `${eleve.prenom ?? ""} ${eleve.nom ?? ""} ${eleve.email ?? ""} ${eleve.licence ?? ""} ${eleve.cours ?? ""}`,
      ).includes(terme),
    );
    return trouves.slice(0, 100);
  }, [eleves, recherche]);

  const centimes = eurosVersCentimes(montant);
  const montantParPersonne =
    centimes && selection.size > 0
      ? modeCalcul === "total_reparti"
        ? Math.floor(centimes / selection.size)
        : centimes
      : null;
  const repartitionAvecReste =
    modeCalcul === "total_reparti" &&
    centimes !== null &&
    selection.size > 0 &&
    centimes % selection.size !== 0;

  const basculerEleve = (eleveId: Eleve["eleveId"]) => {
    setSelection((precedente) => {
      const suivante = new Set(precedente);
      if (suivante.has(eleveId)) suivante.delete(eleveId);
      else suivante.add(eleveId);
      return suivante;
    });
  };
  const elevesSelectionnes = useMemo(
    () => (eleves ?? []).filter((eleve) => selection.has(eleve.eleveId)),
    [eleves, selection],
  );
  const modifierParent = (eleveId: Eleve["eleveId"], champ: "parent1Nom" | "parent1Prenom" | "parent2Nom" | "parent2Prenom", valeur: string) => {
    setParents((precedents) => {
      const parent = precedents[eleveId] ?? {
        parent1Nom: "",
        parent1Prenom: "",
        parent2Nom: "",
        parent2Prenom: "",
      };
      return { ...precedents, [eleveId]: { ...parent, [champ]: valeur } };
    });
  };

  const soumettre = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!centimes) {
      setErreur("Saisissez un montant positif avec au maximum deux décimales.");
      return;
    }
    setEnCours(true);
    setErreur(null);
    try {
      await creer({
        typeFormulaire,
        libelle,
        description: description.trim() || undefined,
        dateEvenement: dateEvenement || undefined,
        calcul:
          modeCalcul === "total_reparti"
            ? { type: "total_reparti", montantTotalCentimes: centimes }
            : { type: "prix_fixe_personne", prixParPersonneCentimes: centimes },
        eleveIds: [...selection],
        parents: [...selection].map((eleveId) => ({ eleveId, ...parents[eleveId] })),
      });
      onFermer();
    } catch (error) {
      setErreur(
        messageErreurRemboursement(
          error,
          "La demande n’a pas pu être créée.",
        ),
      );
    } finally {
      setEnCours(false);
    }
  };

  return (
    <section className="remb-create" aria-labelledby="remb-create-title">
      <div className="remb-section-heading">
        <div>
          <p className="remb-kicker">Nouvelle page du carnet</p>
          <h2 id="remb-create-title">Créer une demande</h2>
        </div>
        <button type="button" className="remb-icon-button" onClick={onFermer} aria-label="Fermer le formulaire">
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <form onSubmit={(event) => void soumettre(event)}>
        {erreur && <p className="remb-alert remb-alert--error" role="alert">{erreur}</p>}
        <div className="remb-form-grid">
          <label className="remb-field">
            <span>Type de remboursement</span>
            <select value={typeFormulaire} onChange={(event) => setTypeFormulaire(event.target.value as TypeFormulaireRemboursement)}>
              <option value="competition">Compétition</option>
              <option value="stage">Stage</option>
            </select>
          </label>
          <label className="remb-field">
            <span>Date de l’événement</span>
            <input type="date" value={dateEvenement} onChange={(event) => setDateEvenement(event.target.value)} />
          </label>
          <label className="remb-field remb-field--wide">
            <span>Libellé</span>
            <input required maxLength={160} value={libelle} onChange={(event) => setLibelle(event.target.value)} placeholder="Ex. Championnat régional 2026" />
          </label>
          <label className="remb-field remb-field--wide">
            <span>Description</span>
            <textarea maxLength={2000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Informations utiles pour le suivi" />
          </label>
        </div>

        <fieldset className="remb-calcul">
          <legend>Calcul du montant attendu</legend>
          <label>
            <input type="radio" name="calcul" checked={modeCalcul === "total_reparti"} onChange={() => setModeCalcul("total_reparti")} />
            <span><strong>Total réparti</strong><small>Le total est réparti entre les élèves sélectionnés.</small></span>
          </label>
          <label>
            <input type="radio" name="calcul" checked={modeCalcul === "prix_fixe_personne"} onChange={() => setModeCalcul("prix_fixe_personne")} />
            <span><strong>Prix fixe par personne</strong><small>Chaque élève doit le même montant.</small></span>
          </label>
          <label className="remb-field remb-amount">
            <span>{modeCalcul === "total_reparti" ? "Montant total (€)" : "Prix par personne (€)"}</span>
            <input required inputMode="decimal" value={montant} onChange={(event) => setMontant(event.target.value)} placeholder="0,00" />
          </label>
          <p className="remb-calcul-preview" aria-live="polite">
            {selection.size} élève{selection.size > 1 ? "s" : ""} ·{" "}
            {montantParPersonne
              ? repartitionAvecReste
                ? `${formatEuros(montantParPersonne)} ou ${formatEuros(montantParPersonne + 1)} par personne pour répartir exactement le total`
                : `${formatEuros(montantParPersonne)} par personne`
              : "montant à compléter"}
          </p>
        </fieldset>

        <fieldset className="remb-students">
          <legend>Élèves bénéficiaires</legend>
          <label className="remb-field remb-search">
            <span>Rechercher par nom, email, licence ou cours</span>
            <span>
              <Search size={18} aria-hidden="true" />
              <input type="search" value={recherche} onChange={(event) => setRecherche(event.target.value)} placeholder="Rechercher un élève" />
            </span>
          </label>
          <p className="remb-selection-count">{selection.size} sélectionné{selection.size > 1 ? "s" : ""}</p>
          {elevesSelectionnes.length > 0 && (
            <div className="remb-selected-students" aria-label="Élèves sélectionnés">
              <strong>Élèves sélectionnés — restent visibles pendant la recherche</strong>
              {elevesSelectionnes.map((eleve) => {
                const parent = parents[eleve.eleveId] ?? { parent1Nom: "", parent1Prenom: "", parent2Nom: "", parent2Prenom: "" };
                return <div className="remb-selected-student" key={eleve.eleveId}>
                  <div><strong>{eleve.prenom} {eleve.nom}</strong><button type="button" className="remb-link-button" onClick={() => basculerEleve(eleve.eleveId)}>Retirer</button></div>
                  <div className="remb-parent-fields">
                    <input value={parent.parent1Prenom} onChange={(event) => modifierParent(eleve.eleveId, "parent1Prenom", event.target.value)} placeholder="Prénom parent 1" maxLength={120} />
                    <input value={parent.parent1Nom} onChange={(event) => modifierParent(eleve.eleveId, "parent1Nom", event.target.value)} placeholder="Nom parent 1" maxLength={120} />
                    <input value={parent.parent2Prenom} onChange={(event) => modifierParent(eleve.eleveId, "parent2Prenom", event.target.value)} placeholder="Prénom parent 2" maxLength={120} />
                    <input value={parent.parent2Nom} onChange={(event) => modifierParent(eleve.eleveId, "parent2Nom", event.target.value)} placeholder="Nom parent 2" maxLength={120} />
                  </div>
                </div>;
              })}
            </div>
          )}
          {eleves === undefined ? (
            <p className="remb-inline-state" role="status">Chargement des élèves…</p>
          ) : eleves.length === 0 ? (
            <p className="remb-inline-state">Aucun élève disponible dans le snapshot courant.</p>
          ) : elevesFiltres.length === 0 ? (
            <p className="remb-inline-state">Aucun élève ne correspond à la recherche.</p>
          ) : (
            <>
              <div className="remb-student-list">
                {elevesFiltres.map((eleve) => (
                  <label className="remb-student-option" key={eleve.eleveId}>
                    <input type="checkbox" checked={selection.has(eleve.eleveId)} onChange={() => basculerEleve(eleve.eleveId)} />
                    <span>
                      <strong>{eleve.prenom || "Sans prénom"} {eleve.nom || "Sans nom"}</strong>
                      <small>{eleve.email || "Email non renseigné"}</small>
                      <small>{[eleve.cours, eleve.horaire].filter(Boolean).join(" · ") || "Cours non renseigné"}</small>
                    </span>
                  </label>
                ))}
              </div>
              {(eleves ?? []).length > 100 && elevesFiltres.length === 100 && (
                <p className="remb-list-note">100 résultats affichés : précisez la recherche pour affiner.</p>
              )}
            </>
          )}
        </fieldset>
        <div className="remb-form-actions">
          <button type="button" className="remb-button remb-button--quiet" onClick={onFermer}>Annuler</button>
          <button type="submit" className="remb-button" disabled={enCours || selection.size === 0}>
            <Plus size={18} aria-hidden="true" />
            {enCours ? "Création…" : "Créer la demande"}
          </button>
        </div>
      </form>
    </section>
  );
}

function DemandeCard({
  demande,
  onErreur,
}: {
  demande: Demande;
  onErreur: (message: string) => void;
}) {
  const archiver = useMutation(api.remboursements.archiverDemande);
  const restaurer = useMutation(api.remboursements.restaurerDemande);
  const annuler = useMutation(api.remboursements.annulerDemande);
  const modifier = useMutation(api.remboursements.modifierDemande);
  const annulerRapprochement = useMutation(api.remboursements.annulerRapprochement);
  const journaliserEmail = useMutation(api.remboursements.journaliserEmail);
  const [ouverte, setOuverte] = useState(true);
  const [rapprochementOuvert, setRapprochementOuvert] =
    useState<Beneficiaire["beneficiaireId"] | null>(null);
  const boutonsRapprochement = useRef(
    new Map<Beneficiaire["beneficiaireId"], HTMLButtonElement>(),
  );
  const [actionEnCours, setActionEnCours] = useState<string | null>(null);
  const [brouillonPrepare, setBrouillonPrepare] = useState<string | null>(null);
  const soldee = demande.beneficiaires.length > 0 &&
    demande.beneficiaires.every((beneficiaire) => beneficiaire.soldeCentimes <= 0);
  const annulee = demande.annuleeAt !== null;
  const progression = demande.montantDuCentimes > 0
    ? Math.min(100, Math.round((demande.montantPayeCentimes / demande.montantDuCentimes) * 100))
    : 0;

  const executer = async (cle: string, action: () => Promise<unknown>, fallback: string) => {
    setActionEnCours(cle);
    try {
      await action();
    } catch (error) {
      onErreur(messageErreurRemboursement(error, fallback));
    } finally {
      setActionEnCours(null);
    }
  };

  const journaliserBrouillon = (
    beneficiaire: Beneficiaire,
    typeEmail: TypeEmailRemboursement,
  ) => {
    if (!beneficiaire.email) return;
    const cle = `${beneficiaire.beneficiaireId}-${typeEmail}`;
    setBrouillonPrepare(cle);
    void journaliserEmail({
      demandeId: demande.demandeId,
      beneficiaireId: beneficiaire.beneficiaireId,
      typeEmail,
    }).catch((error: unknown) => {
      setBrouillonPrepare(null);
      onErreur(
        messageErreurRemboursement(
          error,
          "Le brouillon est ouvert, mais sa préparation n’a pas pu être journalisée.",
        ),
      );
    });
  };

  const demanderAnnulation = () => {
    const motif = window.prompt(
      `Motif d’annulation de « ${demande.libelle} » :`,
    );
    if (motif === null) return;
    if (!motif.trim()) {
      onErreur("Le motif d’annulation est obligatoire.");
      return;
    }
    void executer(
      "cancel",
      () => annuler({ demandeId: demande.demandeId, motif: motif.trim() }),
      "La demande n’a pas pu être annulée.",
    );
  };

  const demanderModification = () => {
    const libelle = window.prompt("Libellé de la demande :", demande.libelle);
    if (libelle === null) return;
    const typeFormulaire = window.prompt("Type de remboursement (competition ou stage) :", demande.typeFormulaire);
    if (typeFormulaire === null) return;
    if (typeFormulaire !== "competition" && typeFormulaire !== "stage") {
      onErreur("Le type de remboursement doit être « competition » ou « stage ».");
      return;
    }
    const description = window.prompt("Description (facultative) :", demande.description ?? "");
    if (description === null) return;
    const dateEvenement = window.prompt("Date de l’événement (AAAA-MM-JJ, facultative) :", demande.dateEvenement ?? "");
    if (dateEvenement === null) return;
    const parents = [] as Array<{ beneficiaireId: Beneficiaire["beneficiaireId"]; parent1Nom?: string; parent1Prenom?: string; parent2Nom?: string; parent2Prenom?: string }>;
    for (const beneficiaire of demande.beneficiaires) {
      const parent1Prenom = window.prompt(`Prénom du parent 1 de ${beneficiaire.prenom} ${beneficiaire.nom} :`, beneficiaire.parent1Prenom ?? "");
      if (parent1Prenom === null) return;
      const parent1Nom = window.prompt(`Nom du parent 1 de ${beneficiaire.prenom} ${beneficiaire.nom} :`, beneficiaire.parent1Nom ?? "");
      if (parent1Nom === null) return;
      const parent2Prenom = window.prompt(`Prénom du parent 2 de ${beneficiaire.prenom} ${beneficiaire.nom} :`, beneficiaire.parent2Prenom ?? "");
      if (parent2Prenom === null) return;
      const parent2Nom = window.prompt(`Nom du parent 2 de ${beneficiaire.prenom} ${beneficiaire.nom} :`, beneficiaire.parent2Nom ?? "");
      if (parent2Nom === null) return;
      parents.push({ beneficiaireId: beneficiaire.beneficiaireId, parent1Nom: parent1Nom.trim() || undefined, parent1Prenom: parent1Prenom.trim() || undefined, parent2Nom: parent2Nom.trim() || undefined, parent2Prenom: parent2Prenom.trim() || undefined });
    }
    void executer("edit", () => modifier({
      demandeId: demande.demandeId,
      typeFormulaire,
      libelle,
      description: description.trim() || undefined,
      dateEvenement: dateEvenement.trim() || undefined,
      parents,
    }), "La demande n’a pas pu être modifiée.");
  };

  const lienEmailGroupe = (typeEmail: TypeEmailRemboursement) => {
    const destinataires = demande.beneficiaires
      .filter((beneficiaire) => typeEmail === "initial" || beneficiaire.soldeCentimes > 0)
      .map((beneficiaire) => beneficiaire.email ?? "");
    const email = preparerEmailRemboursementGroupe({
      typeEmail,
      libelle: demande.libelle,
      lienHelloAsso: LIENS_HELLOASSO_REMBOURSEMENTS[demande.typeFormulaire],
    });
    try { return creerLienGmailRemboursementGroupe({ destinatairesCci: destinataires, ...email }); }
    catch { return null; }
  };

  const journaliserBrouillonGroupe = (typeEmail: TypeEmailRemboursement) => {
    const beneficiaires = demande.beneficiaires.filter((beneficiaire) =>
      Boolean(normaliserAdresseEmailUnique(beneficiaire.email)) &&
      (typeEmail === "initial" || beneficiaire.soldeCentimes > 0),
    );
    void Promise.all(beneficiaires.map((beneficiaire) => journaliserEmail({
      demandeId: demande.demandeId,
      beneficiaireId: beneficiaire.beneficiaireId,
      typeEmail,
    }))).catch((error: unknown) => onErreur(messageErreurRemboursement(error, "Le brouillon est ouvert, mais sa préparation n’a pas pu être journalisée.")));
  };

  const fermerRapprochement = (beneficiaireId: Beneficiaire["beneficiaireId"]) => {
    setRapprochementOuvert(null);
    requestAnimationFrame(() => boutonsRapprochement.current.get(beneficiaireId)?.focus());
  };

  return (
    <article className="remb-card">
      <button type="button" className="remb-card-summary" onClick={() => setOuverte((valeur) => !valeur)} aria-expanded={ouverte}>
        <span className="remb-reference">{demande.reference}</span>
        <span className="remb-card-title">
          <small>{libelleType(demande.typeFormulaire)} · {formatDate(demande.dateEvenement)}</small>
          <strong>{demande.libelle}</strong>
        </span>
        <span className={`remb-stamp ${annulee ? "remb-stamp--cancelled" : soldee ? "remb-stamp--paid" : "remb-stamp--pending"}`}>
          {annulee ? "Annulée" : soldee ? "Soldé" : "À rapprocher"}
        </span>
        <ChevronDown className={ouverte ? "is-open" : ""} size={22} aria-hidden="true" />
      </button>

      <div className="remb-progress-block">
        <div className="remb-progress-label">
          <span>{formatEuros(demande.montantPayeCentimes)} encaissés</span>
          <strong>{formatEuros(demande.montantDuCentimes)} attendus</strong>
        </div>
        <div
          className="remb-progress"
          role="progressbar"
          aria-label={`Progression de ${demande.libelle}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progression}
          style={{ "--progression": `${progression}%` } as CSSProperties}
        >
          <span />
        </div>
        <div className="remb-tally" aria-hidden="true">
          {Array.from({ length: 10 }, (_, index) => <i className={index < Math.ceil(progression / 10) ? "is-done" : ""} key={index} />)}
        </div>
      </div>

      {ouverte && (
        <div className="remb-card-body">
          {demande.description && <p className="remb-description">{demande.description}</p>}
          {annulee && (
            <p className="remb-cancellation">
              <strong>Demande annulée le {formatDateHeure(demande.annuleeAt!)}</strong>
              <span>{demande.motifAnnulation || "Motif non renseigné"}</span>
            </p>
          )}
          <ul className="remb-beneficiaries">
            {demande.beneficiaires.map((beneficiaire) => {
              const lienHelloAsso = LIENS_HELLOASSO_REMBOURSEMENTS[demande.typeFormulaire];
              const adresseEmail = normaliserAdresseEmailUnique(beneficiaire.email);
              return (
                <li className="remb-beneficiary" key={beneficiaire.beneficiaireId}>
                  <div className="remb-beneficiary-main">
                    <div>
                      <h3>{beneficiaire.prenom} {beneficiaire.nom}</h3>
                      <p>{adresseEmail || (beneficiaire.email ? "Email invalide" : "Email non renseigné")}</p>
                      <small>{[beneficiaire.cours, beneficiaire.horaire, beneficiaire.licence].filter(Boolean).join(" · ")}</small>
                      {(beneficiaire.parent1Nom || beneficiaire.parent1Prenom || beneficiaire.parent2Nom || beneficiaire.parent2Prenom) && <small>Parents : {[`${beneficiaire.parent1Prenom ?? ""} ${beneficiaire.parent1Nom ?? ""}`.trim(), `${beneficiaire.parent2Prenom ?? ""} ${beneficiaire.parent2Nom ?? ""}`.trim()].filter(Boolean).join(" · ")}</small>}
                    </div>
                    <div className="remb-balance">
                      <span>Dû {formatEuros(beneficiaire.montantDuCentimes)}</span>
                      <strong>{beneficiaire.soldeCentimes <= 0 ? "Soldé" : `Reste ${formatEuros(beneficiaire.soldeCentimes)}`}</strong>
                    </div>
                  </div>

                  {demande.statut === "active" && (
                    <div className="remb-beneficiary-actions">
                      {(["initial", "relance"] as const).map((typeEmail) => {
                        const email = preparerEmailRemboursement({
                          typeEmail,
                          beneficiaire: `${beneficiaire.prenom} ${beneficiaire.nom}`,
                          libelle: demande.libelle,
                          montantCentimes:
                            typeEmail === "relance"
                              ? Math.max(beneficiaire.soldeCentimes, 0)
                              : beneficiaire.montantDuCentimes,
                          lienHelloAsso,
                        });
                        const cle = `${beneficiaire.beneficiaireId}-${typeEmail}`;
                        return (
                          <a
                            key={typeEmail}
                            className={`remb-button remb-button--small${adresseEmail ? "" : " is-disabled"}`}
                            href={adresseEmail ? creerLienGmailRemboursement({ destinataire: adresseEmail, ...email }) : undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-disabled={!adresseEmail}
                            tabIndex={adresseEmail ? undefined : -1}
                            onClick={(event) => {
                              if (!adresseEmail) {
                                event.preventDefault();
                                return;
                              }
                              journaliserBrouillon(beneficiaire, typeEmail);
                            }}
                          >
                            <Mail size={15} aria-hidden="true" />
                            {brouillonPrepare === cle ? "Brouillon préparé" : typeEmail === "initial" ? "Email initial" : "Relance"}
                          </a>
                        );
                      })}
                      <a className="remb-button remb-button--small remb-button--quiet" href={lienHelloAsso} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={15} aria-hidden="true" /> Formulaire
                      </a>
                      <button
                        type="button"
                        className="remb-button remb-button--small"
                        ref={(element) => {
                          if (element) {
                            boutonsRapprochement.current.set(
                              beneficiaire.beneficiaireId,
                              element,
                            );
                          } else {
                            boutonsRapprochement.current.delete(
                              beneficiaire.beneficiaireId,
                            );
                          }
                        }}
                        disabled={beneficiaire.soldeCentimes <= 0}
                        title={beneficiaire.soldeCentimes <= 0 ? "Ce bénéficiaire est déjà soldé" : undefined}
                        onClick={() => setRapprochementOuvert((id) => id === beneficiaire.beneficiaireId ? null : beneficiaire.beneficiaireId)}
                      >
                        <Link2 size={15} aria-hidden="true" /> Rapprocher
                      </button>
                    </div>
                  )}

                  {(beneficiaire.dernierEmailInitialAt || beneficiaire.dernierEmailRelanceAt) && (
                    <div className="remb-email-history">
                      {beneficiaire.dernierEmailInitialAt && (
                        <span>
                          Brouillon initial préparé le {formatDateHeure(beneficiaire.dernierEmailInitialAt)}
                        </span>
                      )}
                      {beneficiaire.dernierEmailRelanceAt && (
                        <span>
                          Dernière relance préparée le {formatDateHeure(beneficiaire.dernierEmailRelanceAt)}
                        </span>
                      )}
                      <small>Cette trace ne confirme pas l’envoi. Vérifiez l’envoi dans Gmail.</small>
                    </div>
                  )}

                  {beneficiaire.rapprochements.length > 0 && (
                    <ul className="remb-linked-list">
                      {beneficiaire.rapprochements.map((rapprochement) => (
                        <li
                          className={`remb-linked-item remb-linked-item--${rapprochement.statut}`}
                          key={rapprochement.rapprochementId}
                        >
                          <span>
                            {rapprochement.statut === "authorized"
                              ? <Check size={15} aria-hidden="true" />
                              : <Link2 size={15} aria-hidden="true" />}
                            Paiement {rapprochement.helloassoPaymentId} · {formatEuros(rapprochement.amountCentimes)} · {formatDate(rapprochement.datePaiement)}
                            <strong className={`remb-linked-status remb-linked-status--${rapprochement.statut}`}>
                              {rapprochement.statut === "authorized"
                                ? "Autorisé"
                                : rapprochement.statut === "pending"
                                  ? "En attente"
                                  : rapprochement.statut === "refunded"
                                    ? "Remboursé"
                                    : rapprochement.statut === "refused"
                                      ? "Refusé"
                                      : rapprochement.statut === "canceled"
                                        ? "Annulé"
                                        : "Statut inconnu"}
                            </strong>
                          </span>
                          {demande.statut === "active" && (
                            <button type="button" className="remb-link-button" disabled={actionEnCours === rapprochement.rapprochementId} onClick={() => void executer(rapprochement.rapprochementId, () => annulerRapprochement({ rapprochementId: rapprochement.rapprochementId }), "Le paiement n’a pas pu être délié.")}>
                              <Unlink size={14} aria-hidden="true" /> Délier
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {rapprochementOuvert === beneficiaire.beneficiaireId && (
                    <RapprochementPanel
                      demandeId={demande.demandeId}
                      beneficiaire={beneficiaire}
                      onFermer={() => fermerRapprochement(beneficiaire.beneficiaireId)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <footer className="remb-card-footer">
            <span>{demande.beneficiaires.length} bénéficiaire{demande.beneficiaires.length > 1 ? "s" : ""}</span>
            {demande.statut === "active" ? (
              <div className="remb-card-footer-actions">
                <a className={`remb-button remb-button--small${lienEmailGroupe("initial") ? "" : " is-disabled"}`} href={lienEmailGroupe("initial") ?? undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!lienEmailGroupe("initial")} tabIndex={lienEmailGroupe("initial") ? undefined : -1} onClick={() => journaliserBrouillonGroupe("initial")}><Mail size={15} aria-hidden="true" /> Demande à tous (CCI)</a>
                <a className={`remb-button remb-button--small remb-button--quiet${lienEmailGroupe("relance") ? "" : " is-disabled"}`} href={lienEmailGroupe("relance") ?? undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!lienEmailGroupe("relance")} tabIndex={lienEmailGroupe("relance") ? undefined : -1} onClick={() => journaliserBrouillonGroupe("relance")}><Mail size={15} aria-hidden="true" /> Relance à tous (CCI)</a>
                <button type="button" className="remb-button remb-button--quiet" disabled={actionEnCours !== null} onClick={demanderModification}><Pencil size={17} aria-hidden="true" /> {actionEnCours === "edit" ? "Modification…" : "Modifier"}</button>
                <button type="button" className="remb-button remb-button--danger" disabled={actionEnCours !== null} onClick={demanderAnnulation}>
                  <X size={17} aria-hidden="true" /> {actionEnCours === "cancel" ? "Annulation…" : "Annuler la demande"}
                </button>
                <button type="button" className="remb-button remb-button--archive" disabled={!soldee || actionEnCours !== null} title={soldee ? "Archiver cette demande soldée" : "Tous les bénéficiaires doivent être soldés"} onClick={() => void executer("archive", () => archiver({ demandeId: demande.demandeId }), "La demande n’a pas pu être archivée.")}>
                  <Archive size={17} aria-hidden="true" /> {actionEnCours === "archive" ? "Archivage…" : "Archiver"}
                </button>
              </div>
            ) : (
              <button type="button" className="remb-button" disabled={actionEnCours !== null} onClick={() => void executer("restore", () => restaurer({ demandeId: demande.demandeId }), "La demande n’a pas pu être restaurée.")}>
                <RotateCcw size={17} aria-hidden="true" /> {actionEnCours === "restore" ? "Restauration…" : "Restaurer"}
              </button>
            )}
          </footer>
        </div>
      )}
    </article>
  );
}

export default function RemboursementsEleves() {
  const [statut, setStatut] = useState<StatutListe>("active");
  const [creationOuverte, setCreationOuverte] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [paiementsOuverts, setPaiementsOuverts] = useState(false);
  const erreurRef = useRef<HTMLDivElement>(null);
  const [syncStatut, setSyncStatut] =
    useState<"en_cours" | "ok" | "erreur">("en_cours");
  const [syncMessage, setSyncMessage] = useState("Actualisation HelloAsso en cours…");
  const syncLancee = useRef(false);
  const {
    results: demandes,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.remboursements.listDemandes,
    { statut },
    { initialNumItems: 10 },
  );
  const eleves = useQuery(api.remboursements.listEleves);
  const { results: paiementsNonRapproches, status: statutPaiementsNonRapproches, loadMore: chargerPlusPaiementsNonRapproches } = usePaginatedQuery(api.remboursements.listPaiementsNonRapproches, {}, { initialNumItems: 20 });
  const archiverPaiement = useMutation(api.remboursements.archiverPaiementNonRapproche);
  const synchroniser = useAction(api.remboursementsHelloAsso.synchroniser);

  useEffect(() => {
    if (!erreur) return;
    requestAnimationFrame(() => {
      erreurRef.current?.focus();
      erreurRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [erreur]);

  useEffect(() => {
    if (syncLancee.current) return;
    syncLancee.current = true;
    void synchroniser({})
      .then((resultat) => {
        const sourcesEnErreur = [
          resultat.statut === "erreur" ? "paiements HelloAsso" : null,
          resultat.statutEleves === "erreur" ? "liste des élèves" : null,
        ].filter((source): source is string => source !== null);
        if (sourcesEnErreur.length > 0) {
          setSyncStatut("erreur");
          setSyncMessage(
            `Actualisation impossible pour ${sourcesEnErreur.join(" et ")} ; les dernières données restent affichées.`,
          );
          return;
        }
        setSyncStatut("ok");
        setSyncMessage(
          resultat.statut === "skipped"
            ? "Données HelloAsso déjà actualisées récemment."
            : `${resultat.nombrePaiements} paiement${resultat.nombrePaiements > 1 ? "s" : ""} parcouru${resultat.nombrePaiements > 1 ? "s" : ""}.`,
        );
      })
      .catch((error: unknown) => {
        setSyncStatut("erreur");
        setSyncMessage(
          messageErreurRemboursement(
            error,
            "Actualisation impossible, les dernières données restent affichées.",
          ),
        );
      });
  }, [synchroniser]);

  return (
    <div className="remb-page">
      <header className="remb-header">
        <div className="remb-heading-row">
          <div>
            <p className="remb-kicker">Carnet de remboursement</p>
            <h1>Avances élèves</h1>
            <p className="subtitle">Compétitions et stages · suivi hors saison</p>
          </div>
          <div className={`remb-sync remb-sync--${syncStatut}`} role="status">
            <RefreshCcw size={18} aria-hidden="true" />
            <span>{syncMessage}</span>
          </div>
        </div>
      </header>

      {erreur && (
        <div
          ref={erreurRef}
          className="remb-alert remb-alert--error"
          role="alert"
          tabIndex={-1}
        >
          <span>{erreur}</span>
          <button type="button" className="remb-icon-button" onClick={() => setErreur(null)} aria-label="Fermer le message d’erreur"><X size={18} /></button>
        </div>
      )}

      <div className="remb-toolbar">
        <div className="remb-tabs" role="tablist" aria-label="État des demandes">
          <button id="remb-tab-active" type="button" role="tab" aria-selected={statut === "active"} aria-controls="remb-panel-active" onClick={() => setStatut("active")}>Demandes en cours</button>
          <button id="remb-tab-archivee" type="button" role="tab" aria-selected={statut === "archivee"} aria-controls="remb-panel-archivee" onClick={() => setStatut("archivee")}>Archives</button>
        </div>
        {statut === "active" && (
          <button type="button" className="remb-button" onClick={() => setCreationOuverte((valeur) => !valeur)}>
            <Plus size={18} aria-hidden="true" /> Nouvelle demande
          </button>
        )}
      </div>

      {creationOuverte && statut === "active" && (
        <CreationDemande eleves={eleves} onFermer={() => setCreationOuverte(false)} />
      )}

      <section className="remb-unmatched">
        <button type="button" className="remb-button remb-button--quiet" onClick={() => setPaiementsOuverts((ouverte) => !ouverte)} aria-expanded={paiementsOuverts}>
          <Archive size={17} aria-hidden="true" /> Paiements non rapprochés ({paiementsOuverts ? "masquer" : "afficher"})
        </button>
        {paiementsOuverts && <div className="remb-unmatched-list">
          <p>Archivez les anciens paiements saisis manuellement : ils disparaissent des propositions de rapprochement, sans être supprimés.</p>
          {statutPaiementsNonRapproches === "LoadingFirstPage" ? <p className="remb-inline-state">Chargement des paiements…</p> : paiementsNonRapproches.length === 0 ? <p className="remb-inline-state">Aucun paiement autorisé non rapproché.</p> : paiementsNonRapproches.map((paiement) => <div className="remb-unmatched-item" key={paiement.paiementId}>
            <span><strong>{paiement.payeurPrenom} {paiement.payeurNom} · {formatEuros(paiement.amountCentimes)}</strong><small>{libelleType(paiement.typeFormulaire)} · {paiement.payeurEmail} · {formatDate(paiement.datePaiement)}</small></span>
            <button type="button" className="remb-button remb-button--small remb-button--archive" onClick={() => { if (window.confirm("Archiver ce paiement non rapproché ?")) void archiverPaiement({ paiementId: paiement.paiementId }).catch((error: unknown) => setErreur(messageErreurRemboursement(error, "Le paiement n’a pas pu être archivé."))); }}><Archive size={15} aria-hidden="true" /> Archiver</button>
          </div>)}
          {(statutPaiementsNonRapproches === "CanLoadMore" || statutPaiementsNonRapproches === "LoadingMore") && <button type="button" className="remb-button remb-button--quiet" disabled={statutPaiementsNonRapproches === "LoadingMore"} onClick={() => chargerPlusPaiementsNonRapproches(20)}>{statutPaiementsNonRapproches === "LoadingMore" ? "Chargement…" : "Afficher plus"}</button>}
        </div>}
      </section>

      <section
        id={`remb-panel-${statut}`}
        role="tabpanel"
        aria-labelledby={`remb-tab-${statut}`}
        aria-live="polite"
        aria-busy={
          paginationStatus === "LoadingFirstPage" ||
          paginationStatus === "LoadingMore"
        }
      >
        {paginationStatus === "LoadingFirstPage" ? (
          <div className="remb-empty" role="status">Chargement du carnet…</div>
        ) : demandes.length === 0 && paginationStatus === "Exhausted" ? (
          <div className="remb-empty">
            {statut === "active" ? <Users size={38} aria-hidden="true" /> : <Archive size={38} aria-hidden="true" />}
            <h2>{statut === "active" ? "Aucune demande en cours" : "Aucune archive"}</h2>
            <p>{statut === "active" ? "Créez une première demande pour démarrer le suivi." : "Les demandes soldées et archivées apparaîtront ici."}</p>
          </div>
        ) : (
          <div className="remb-list">
            {demandes.map((demande) => (
              <DemandeCard key={demande.demandeId} demande={demande} onErreur={setErreur} />
            ))}
            {(paginationStatus === "CanLoadMore" ||
              paginationStatus === "LoadingMore") && (
              <button
                type="button"
                className="remb-button remb-load-more"
                disabled={paginationStatus === "LoadingMore"}
                onClick={() => loadMore(10)}
              >
                {paginationStatus === "LoadingMore"
                  ? "Chargement…"
                  : "Afficher plus"}
              </button>
            )}
            {paginationStatus === "Exhausted" && demandes.length > 10 && (
              <p className="remb-pagination-end">Toutes les demandes sont affichées.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
