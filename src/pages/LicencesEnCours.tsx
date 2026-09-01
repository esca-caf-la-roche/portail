import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check, ChevronDown, ChevronRight, Copy, RotateCcw } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useMaintenantJourParis } from "../abonnements/lib/useMaintenantJourParis";
import { useMaintenantMinute } from "../abonnements/lib/useMaintenantMinute";
import {
  emailsUniques,
  normaliserAdresseEmailUnique,
} from "../utils/contactsCours";

function errMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown })?.data;
  if (data && typeof data === "object" && "message" in data) {
    const m = (data as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === "string" && msg ? msg : fallback;
}

// Vérification des licences FFCAM des élèves EN COURS (abo_eleves_en_cours) :
// - Liste d'attente exclue (pas en cours).
// - Licence renseignée → toujours valide.
// - Licence vide → tolérance en septembre si l'élève était déjà en cours la
//   saison précédente (saison_precedente non vide), invalide sinon.
// SAISON-EXEMPT: cette page reflète les snapshots courants du site club et de
// l'annuaire FFCAM. Le suivi "traité" est temporaire et doit céder devant la
// prochaine synchronisation des élèves.

const RAISON_LABEL: Record<string, string> = {
  licence_absente_hors_fenetre: "Licence absente (hors tolérance de septembre)",
  nouvel_eleve_sans_licence: "Nouvel élève sans licence saisie",
};

type EleveLicence = {
  eleve_id: Id<"abo_eleves_en_cours">;
  nom: string | null;
  prenom: string | null;
  cours: string | null;
  horaire: string | null;
  email: string | null;
  emailSource: "eleve" | "gestion" | null;
  raison: string;
  traite: boolean;
  traiteAt: string | null;
  traitementPossible: boolean;
  candidats: Array<{ licence: string; nom: string | null; prenom: string | null; score: number }>;
};

type GroupeCours = { libelle: string; horaire: string | null; eleves: EleveLicence[] };
type GroupeJour = { libelle: string; priorite: string; cours: GroupeCours[] };

const JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

function estSelectionnable(eleve: EleveLicence): boolean {
  return !eleve.traite && normaliserAdresseEmailUnique(eleve.email) !== null;
}

function formaterDateHeure(value: string | number | null): string {
  if (!value) return "Non disponible";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Non disponible";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function trouverJour(horaire: string | null): { libelle: string } {
  const texte = (horaire ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr");
  const index = JOURS.findIndex((jour) => texte.includes(jour.toLocaleLowerCase("fr")));
  return { libelle: index === -1 ? "Jour non renseigné" : JOURS[index] };
}

function regrouperParJourEtCours(eleves: EleveLicence[]): GroupeJour[] {
  const jours = new Map<string, { libelle: string; priorite: string; cours: Map<string, GroupeCours> }>();

  for (const eleve of eleves) {
    const jour = trouverJour(eleve.horaire);
    const horsTolerance = eleve.raison === "licence_absente_hors_fenetre";
    const priorite = horsTolerance ? "Hors tolérance de septembre" : "Nouvelle licence";
    const cleJour = `${horsTolerance ? "0" : "1"}\u0000${jour.libelle}`;
    const cours = eleve.cours?.trim() || "Cours non renseigné";
    const cleCours = `${cours}\u0000${eleve.horaire?.trim() || ""}`;
    if (!jours.has(cleJour)) {
      jours.set(cleJour, { libelle: jour.libelle, priorite, cours: new Map() });
    }
    const groupeJour = jours.get(cleJour)!;
    if (!groupeJour.cours.has(cleCours)) {
      groupeJour.cours.set(cleCours, { libelle: cours, horaire: eleve.horaire, eleves: [] });
    }
    groupeJour.cours.get(cleCours)!.eleves.push(eleve);
  }

  // Convex fournit déjà l'ordre métier : priorité, jour relatif à aujourd'hui,
  // cours, puis élève. Les Map conservent cet ordre d'insertion.
  return [...jours.values()].map((jour) => ({
    libelle: jour.libelle,
    priorite: jour.priorite,
    cours: [...jour.cours.values()],
  }));
}

function CheckboxGroupe({
  eleves,
  selection,
  onChange,
  label,
}: {
  eleves: EleveLicence[];
  selection: Set<Id<"abo_eleves_en_cours">>;
  onChange: (eleves: EleveLicence[]) => void;
  label: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = eleves
    .filter(estSelectionnable)
    .map((eleve) => eleve.eleve_id);
  const coche = ids.length > 0 && ids.every((id) => selection.has(id));
  const partiel = !coche && ids.some((id) => selection.has(id));

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = partiel;
  }, [partiel]);

  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={coche}
      disabled={ids.length === 0}
      onChange={() => onChange(eleves)}
      aria-label={label}
    />
  );
}

function CoursRepliable({
  cours,
  cle,
  replie,
  onBasculerRepli,
  selection,
  onSelectionChange,
  copie,
  onCopierEmails,
  traitementEnCours,
  onDefinirTraite,
}: {
  cours: GroupeCours;
  cle: string;
  replie: boolean;
  onBasculerRepli: (cle: string) => void;
  selection: Set<Id<"abo_eleves_en_cours">>;
  onSelectionChange: (eleves: EleveLicence[]) => void;
  copie: { id: string; statut: "ok" | "erreur" } | null;
  onCopierEmails: (id: Id<"abo_eleves_en_cours">) => Promise<void>;
  traitementEnCours: Id<"abo_eleves_en_cours"> | null;
  onDefinirTraite: (eleve: EleveLicence) => Promise<void>;
}) {
  const aTraiter = cours.eleves.filter((eleve) => !eleve.traite).length;
  const enAttente = cours.eleves.length - aTraiter;

  return (
    <section className="licences-cours-groupe">
      <header className="licences-cours-groupe-entete">
        <div className="licences-cours-titre-repliable">
          <button type="button" className="licences-cours-bouton-repli" onClick={() => onBasculerRepli(cle)} aria-expanded={!replie} aria-controls={`${cle}-contenu`}>
            {replie ? <ChevronRight size={20} aria-hidden="true" /> : <ChevronDown size={20} aria-hidden="true" />}
            <span className="sr-only">{replie ? "Déplier" : "Replier"} le cours {cours.libelle}</span>
          </button>
          <div>
            <span className="licences-cours-niveau">Cours</span>
            <h3>{cours.libelle}</h3>
            <span className="licences-cours-effectif">
              {aTraiter} à traiter{enAttente > 0 ? ` · ${enAttente} en attente` : ""}
            </span>
            {cours.horaire && <span className="licences-cours-horaire">{cours.horaire}</span>}
          </div>
        </div>
        <label className="licences-cours-selection-groupe">
          <CheckboxGroupe eleves={cours.eleves} selection={selection} onChange={onSelectionChange} label={`Sélectionner les élèves joignables du cours ${cours.libelle}`} />
          Tous les joignables du cours
        </label>
      </header>

      {!replie && <ul className="licences-cours-eleves" id={`${cle}-contenu`}>
        {cours.eleves.map((e) => {
          // Pendant la bascule DEV, une réponse d'une ancienne version de la
          // query peut ne pas encore porter les correspondances séparées.
          // L'affichage reste disponible et les candidats arrivent à la
          // prochaine réponse réactive.
          const candidats = e.candidats ?? [];
          return (
          <li key={e.eleve_id} className={`licences-cours-eleve${e.traite ? " licences-cours-eleve--traite" : ""}`}>
            <div className="licences-cours-eleve-entete">
              <div className="licences-cours-eleve-nom">
                <input type="checkbox" checked={!e.traite && selection.has(e.eleve_id)} disabled={!estSelectionnable(e)} onChange={() => onSelectionChange([e])} aria-label={`Sélectionner ${`${e.prenom ?? ""} ${e.nom ?? ""}`.trim() || "cet élève"}`} />
                <span>{`${e.prenom ?? ""} ${e.nom ?? ""}`.trim() || "—"}</span>
              </div>
              <div className="licences-cours-etats">
                {e.traite && <span className="licences-cours-traite">En attente de confirmation</span>}
                <span className="licences-cours-raison">{RAISON_LABEL[e.raison] ?? e.raison}</span>
              </div>
            </div>
            {e.traite && (
              <p className="licences-cours-traite-detail">
                Marqué traité{e.traiteAt ? ` le ${formaterDateHeure(e.traiteAt)}` : ""}. La prochaine synchronisation des élèves reste prioritaire.
              </p>
            )}
            {e.horaire && <p className="licences-cours-horaire">{e.horaire}</p>}
            <div className="licences-cours-eleve-actions">
              {normaliserAdresseEmailUnique(e.email) && !e.traite ? <>
                <button type="button" className="btn btn-secondary" onClick={() => void onCopierEmails(e.eleve_id)}>
                  <Copy size={16} aria-hidden="true" />
                  {copie?.id === e.eleve_id && copie.statut === "ok" ? "Adresse copiée" : "Copier l'adresse mail"}
                </button>
                {copie?.id === e.eleve_id && copie.statut === "erreur" && <span className="error-message" role="alert">Copie impossible</span>}
              </> : !e.traite ? <span>Email non renseigné</span> : null}
              <button
                type="button"
                className={`btn ${e.traite ? "btn-secondary" : "btn-primary"}`}
                disabled={traitementEnCours === e.eleve_id || (!e.traite && !e.traitementPossible)}
                onClick={() => void onDefinirTraite(e)}
                title={!e.traite && !e.traitementPossible ? "Le suivi ne peut pas être enregistré pour cette ligne." : undefined}
              >
                {e.traite ? <RotateCcw size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                {traitementEnCours === e.eleve_id
                  ? "Enregistrement…"
                  : e.traite
                    ? "Remettre à traiter"
                    : e.traitementPossible
                      ? "Marquer traité"
                      : "Suivi indisponible"}
              </button>
            </div>
            {candidats.length > 0 && <div className="licences-cours-candidats">
              <div>Correspondances possibles dans l'annuaire des licences :</div>
              <ul>{candidats.map((c) => {
                const cn = `${c.prenom ?? ""} ${c.nom ?? ""}`.trim() || "—";
                return <li key={c.licence}>{cn} — <code>{c.licence}</code> <span>{Math.round(c.score * 100)}%</span></li>;
              })}</ul>
            </div>}
          </li>
          );
        })}
      </ul>}
    </section>
  );
}

export default function LicencesEnCours() {
  const maintenantJour = useMaintenantJourParis();
  const maintenantMs = useMaintenantMinute();
  const data = useQuery(api.abo.licencesEnCours.getElevesLicenceInvalide, { maintenantJour });
  const candidats = useQuery(
    api.abo.licencesEnCours.getCandidatsLicences,
    data && data.eleves.some((eleve) => !eleve.traite)
      ? { maintenantJour }
      : "skip",
  );
  const statutSynchronisation = useQuery(api.abo.sync.getStatutSyncLicencesCours, {
    maintenantMs,
  });
  const synchroniser = useAction(api.abo.sync.syncPourLicencesCours);
  const definirTraite = useMutation(api.abo.licencesEnCours.definirTraite);
  const [syncStatut, setSyncStatut] = useState<"en_cours" | "ok" | "erreur">("en_cours");
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<Id<"abo_eleves_en_cours">>>(new Set());
  const [copie, setCopie] = useState<{ id: string; statut: "ok" | "erreur" } | null>(null);
  const [traitementEnCours, setTraitementEnCours] = useState<Id<"abo_eleves_en_cours"> | null>(null);
  const [traitementErreur, setTraitementErreur] = useState<string | null>(null);
  const [joursReplis, setJoursReplis] = useState<Set<string>>(new Set());
  const [coursReplis, setCoursReplis] = useState<Set<string>>(new Set());
  const lance = useRef(false);

  useEffect(() => {
    if (lance.current) return;
    lance.current = true;
    synchroniser({})
      .then((resultat) => {
        const echecs = [
          resultat.eleves === "erreur" ? "élèves du site club" : null,
          resultat.annuaire === "erreur" ? "annuaire des licences" : null,
          resultat.annuaire === "desactive" ? "annuaire des licences temporairement désactivé" : null,
        ].filter((source): source is string => source !== null);
        if (echecs.length > 0) {
          setSyncStatut("erreur");
          setSyncMsg(`source non actualisée : ${echecs.join(" et ")}`);
        } else {
          setSyncStatut("ok");
        }
      })
      .catch((err) => {
        setSyncStatut("erreur");
        setSyncMsg(errMessage(err, "Échec de la synchronisation avec le site club."));
      });
  }, [synchroniser]);

  const eleves = useMemo<EleveLicence[]>(() => {
    if (!data) return [];
    const candidatsParEleve = new Map(
      (candidats ?? []).map((item) => [item.eleveId, item.candidats]),
    );
    return data.eleves.map((eleve) => ({
      ...eleve,
      candidats: eleve.traite ? [] : (candidatsParEleve.get(eleve.eleve_id) ?? []),
    }));
  }, [candidats, data]);

  const elevesASelectionner = useMemo(
    () => eleves.filter(estSelectionnable),
    [eleves],
  );

  const groupe = useMemo(() => {
    const elevesSelectionnes = eleves.filter(
      (eleve) => estSelectionnable(eleve) && selection.has(eleve.eleve_id),
    );
    return { emails: emailsUniques(elevesSelectionnes.map((eleve) => eleve.email)) };
  }, [eleves, selection]);

  const compteurs = useMemo(() => {
    const aTraiter = eleves.filter((eleve) => !eleve.traite).length;
    return { aTraiter, enAttente: eleves.length - aTraiter };
  }, [eleves]);

  const groupes = useMemo(
    () => regrouperParJourEtCours(eleves),
    [eleves],
  );

  const basculerSelection = (eleves: EleveLicence[]) => {
    const ids = eleves
      .filter(estSelectionnable)
      .map((eleve) => eleve.eleve_id);
    const toutLeGroupeEstSelectionne = ids.length > 0 && ids.every((id) => selection.has(id));
    setSelection((precedente) => {
      const suivante = new Set(precedente);
      for (const id of ids) {
        if (toutLeGroupeEstSelectionne) suivante.delete(id);
        else suivante.add(id);
      }
      return suivante;
    });
  };

  const copierEmails = async (id: string, emails: string[]) => {
    if (emails.length === 0) {
      setCopie({ id, statut: "erreur" });
      window.setTimeout(() => setCopie(null), 1800);
      return;
    }
    try {
      await navigator.clipboard.writeText(emails.join(", "));
      setCopie({ id, statut: "ok" });
    } catch {
      setCopie({ id, statut: "erreur" });
    }
    window.setTimeout(() => setCopie(null), 1800);
  };

  const copierEleve = async (eleveId: Id<"abo_eleves_en_cours">) => {
    const eleve = eleves.find((item) => item.eleve_id === eleveId);
    const email = eleve && !eleve.traite
      ? normaliserAdresseEmailUnique(eleve.email)
      : null;
    await copierEmails(eleveId, email ? [email] : []);
  };

  const copierSelection = async () => {
    // Refiltrage volontaire au clic : une ligne marquée traitée ou disparue
    // depuis la sélection ne doit jamais se retrouver dans le presse-papiers.
    const emails = emailsUniques(
      eleves
        .filter((eleve) => estSelectionnable(eleve) && selection.has(eleve.eleve_id))
        .map((eleve) => eleve.email),
    );
    await copierEmails("groupe", emails);
  };

  const changerTraitement = async (eleve: EleveLicence) => {
    setTraitementErreur(null);
    setTraitementEnCours(eleve.eleve_id);
    try {
      await definirTraite({ eleveId: eleve.eleve_id, traite: !eleve.traite });
      if (!eleve.traite) {
        setSelection((precedente) => {
          if (!precedente.has(eleve.eleve_id)) return precedente;
          const suivante = new Set(precedente);
          suivante.delete(eleve.eleve_id);
          return suivante;
        });
      }
    } catch (err) {
      setTraitementErreur(errMessage(err, "Impossible de modifier le suivi de cet élève."));
    } finally {
      setTraitementEnCours(null);
    }
  };

  const basculerRepli = (cle: string, setReplis: Dispatch<SetStateAction<Set<string>>>) => {
    setReplis((precedents) => {
      const suivants = new Set(precedents);
      if (suivants.has(cle)) suivants.delete(cle);
      else suivants.add(cle);
      return suivants;
    });
  };

  return (
    <div className="licences-cours-page">
      <header className="page-header">
        <h1>Licences élèves en cours</h1>
        <p className="subtitle">
          Élèves en cours (hors liste d'attente) sans licence FFCAM valide dans les données actuelles.
        </p>
        <p className={`licences-cours-sync-resume licences-cours-sync-resume--${syncStatut}`} role="status">
          {syncStatut === "en_cours" && "Synchronisation avec le site club en cours…"}
          {syncStatut === "ok" && "Synchronisation vérifiée. Les délais propres à chaque source sont indiqués ci-dessous."}
          {syncStatut === "erreur" && `Synchronisation échouée : ${syncMsg} — données potentiellement obsolètes.`}
        </p>
      </header>

      <section className="licences-cours-syncs" aria-label="État des synchronisations">
        {([
          { cle: "eleves", titre: "Élèves du site club", delai: "1 heure" },
          { cle: "annuaire", titre: "Annuaire des licences", delai: "12 heures" },
        ] as const).map((source) => {
          const statut = statutSynchronisation?.[source.cle];
          return (
            <article className="licences-cours-sync-carte" key={source.cle}>
              <h2>{source.titre}</h2>
              {statutSynchronisation === undefined ? (
                <p>Chargement de l'état…</p>
              ) : (
                <dl>
                  <div>
                    <dt>Dernière synchronisation</dt>
                    <dd>{statut?.lastSyncAt ? formaterDateHeure(statut.lastSyncAt) : "Jamais synchronisée"}</dd>
                  </div>
                  <div>
                    <dt>Prochaine synchronisation possible</dt>
                    <dd>{statut?.nextSyncAt ? formaterDateHeure(statut.nextSyncAt) : "Disponible maintenant"}</dd>
                  </div>
                </dl>
              )}
              <p className="licences-cours-sync-delai">Délai minimal : {source.delai}</p>
            </article>
          );
        })}
      </section>

      {data === undefined ? (
        <p>Chargement…</p>
      ) : (
        <>
          <section className="licences-cours-compteurs" aria-label="Avancement du traitement">
            <div className="licences-cours-total licences-cours-total--a-traiter">
              <span>{compteurs.aTraiter}</span>
              <span>à traiter</span>
            </div>
            <div className="licences-cours-total licences-cours-total--attente">
              <span>{compteurs.enAttente}</span>
              <span>en attente de confirmation</span>
            </div>
          </section>

          {traitementErreur && <p className="error-message" role="alert">{traitementErreur}</p>}

          {data.total > 0 && (
            <section aria-label="Relance licence" className="licences-cours-relance">
              <label className="licences-cours-selection-totale">
                <CheckboxGroupe
                  eleves={elevesASelectionner}
                  selection={selection}
                  onChange={basculerSelection}
                  label="Sélectionner tous les élèves joignables"
                />
                Sélectionner les élèves joignables
              </label>
              <div className="licences-cours-relance-actions">
                <span>
                  {groupe.emails.length} adresse{groupe.emails.length > 1 ? "s" : ""} sélectionnée{groupe.emails.length > 1 ? "s" : ""}
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={groupe.emails.length === 0}
                  onClick={() => void copierSelection()}
                >
                  <Copy size={16} aria-hidden="true" /> Copier {groupe.emails.length > 1 ? "les adresses" : "l'adresse"}
                </button>
              </div>
              <p className="licences-cours-copie-statut" role="status">
                {copie?.id === "groupe" && copie.statut === "ok" && "Adresses copiées dans le presse-papiers."}
                {copie?.id === "groupe" && copie.statut === "erreur" && "Copie impossible. Autorisez l'accès au presse-papiers puis réessayez."}
                {copie?.id !== "groupe" && "Les adresses seront copiées dans le presse-papiers."}
              </p>
            </section>
          )}

          {data.total === 0 ? (
            <p style={{ color: "#6b7280" }}>Tous les élèves en cours ont une licence valide.</p>
          ) : (
            <div className="licences-cours-jours">
              {groupes.map((jour) => {
                const cleJour = `${jour.priorite}-${jour.libelle}`;
                const jourReplie = joursReplis.has(cleJour);
                return (
                <section className="licences-cours-jour" key={cleJour}>
                  <header className="licences-cours-jour-entete">
                    <div className="licences-cours-titre-repliable">
                      <button
                        type="button"
                        className="licences-cours-bouton-repli"
                        onClick={() => basculerRepli(cleJour, setJoursReplis)}
                        aria-expanded={!jourReplie}
                        aria-controls={`${cleJour}-contenu`}
                      >
                        {jourReplie ? <ChevronRight size={20} aria-hidden="true" /> : <ChevronDown size={20} aria-hidden="true" />}
                        <span className="sr-only">{jourReplie ? "Déplier" : "Replier"} le jour {jour.libelle}</span>
                      </button>
                      <div>
                      <span className="licences-cours-niveau">{jour.priorite}</span>
                      <h2>{jour.libelle}</h2>
                      </div>
                    </div>
                    <label className="licences-cours-selection-groupe">
                      <CheckboxGroupe
                        eleves={jour.cours.flatMap((cours) => cours.eleves)}
                        selection={selection}
                        onChange={basculerSelection}
                        label={`Sélectionner les élèves joignables du ${jour.libelle}`}
                      />
                      Tous les joignables du jour
                    </label>
                  </header>

                  {!jourReplie && <div className="licences-cours-groupes" id={`${cleJour}-contenu`}>
                    {jour.cours.map((cours) => (
                      <CoursRepliable
                        key={`${cours.libelle}-${cours.horaire ?? ""}`}
                        cours={cours}
                        cle={`${cleJour}-${cours.libelle}-${cours.horaire ?? ""}`}
                        replie={coursReplis.has(`${cleJour}-${cours.libelle}-${cours.horaire ?? ""}`)}
                        onBasculerRepli={(cle) => basculerRepli(cle, setCoursReplis)}
                        selection={selection}
                        onSelectionChange={basculerSelection}
                        copie={copie}
                        onCopierEmails={copierEleve}
                        traitementEnCours={traitementEnCours}
                        onDefinirTraite={changerTraitement}
                      />
                    ))}
                  </div>}
                </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
