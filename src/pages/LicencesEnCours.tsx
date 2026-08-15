import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAction, useQuery } from "convex/react";
import { ArrowLeft, Copy } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useMaintenantJourParis } from "../abonnements/lib/useMaintenantJourParis";
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
// Lecture seule : abo_eleves_en_cours est régénérée à chaque scrape du site
// club, aucune résolution n'est persistée ici — les candidats de l'annuaire
// abo_licences sont proposés à titre indicatif pour le suivi manuel.

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
  candidats: Array<{ licence: string; nom: string | null; prenom: string | null; score: number }>;
};

type GroupeCours = { libelle: string; horaire: string | null; eleves: EleveLicence[] };
type GroupeJour = { libelle: string; priorite: string; cours: GroupeCours[] };

const JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

function trouverJour(horaire: string | null): { index: number; libelle: string } {
  const texte = (horaire ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr");
  const index = JOURS.findIndex((jour) => texte.includes(jour.toLocaleLowerCase("fr")));
  return index === -1 ? { index: JOURS.length, libelle: "Jour non renseigné" } : { index, libelle: JOURS[index] };
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
    .filter((eleve) => normaliserAdresseEmailUnique(eleve.email))
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

export default function LicencesEnCours() {
  const maintenantJour = useMaintenantJourParis();
  const data = useQuery(api.abo.licencesEnCours.getElevesLicenceInvalide, { maintenantJour });
  const synchroniser = useAction(api.abo.sync.syncPourLicencesCours);
  const [syncStatut, setSyncStatut] = useState<"en_cours" | "ok" | "erreur">("en_cours");
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<Id<"abo_eleves_en_cours">>>(new Set());
  const [copie, setCopie] = useState<{ id: string; statut: "ok" | "erreur" } | null>(null);
  const lance = useRef(false);

  useEffect(() => {
    if (lance.current) return;
    lance.current = true;
    synchroniser({})
      .then(() => setSyncStatut("ok"))
      .catch((err) => {
        setSyncStatut("erreur");
        setSyncMsg(errMessage(err, "Échec de la synchronisation avec le site club."));
      });
  }, [synchroniser]);

  const elevesJoignables = useMemo(
    () => data?.eleves.filter((eleve) => normaliserAdresseEmailUnique(eleve.email)) ?? [],
    [data?.eleves],
  );

  const groupe = useMemo(() => {
    const elevesSelectionnes = data?.eleves.filter((eleve) => selection.has(eleve.eleve_id)) ?? [];
    return { emails: emailsUniques(elevesSelectionnes.map((eleve) => eleve.email)) };
  }, [data?.eleves, selection]);

  const groupes = useMemo(
    () => regrouperParJourEtCours(data?.eleves ?? []),
    [data?.eleves],
  );

  const basculerSelection = (eleves: EleveLicence[]) => {
    const ids = eleves
      .filter((eleve) => normaliserAdresseEmailUnique(eleve.email))
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
    try {
      await navigator.clipboard.writeText(emails.join(", "));
      setCopie({ id, statut: "ok" });
    } catch {
      setCopie({ id, statut: "erreur" });
    }
    window.setTimeout(() => setCopie(null), 1800);
  };

  return (
    <div className="licences-cours-page">
      <header className="page-header">
        <Link to="/" className="back-link" style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
          <ArrowLeft size={16} /> Retour au tableau de bord
        </Link>
        <h1>Licences élèves en cours</h1>
        <p className="subtitle">
          Élèves en cours (hors liste d'attente) sans licence FFCAM valide pour la saison.
        </p>
        <p style={{ fontSize: "0.8rem", color: syncStatut === "erreur" ? "#b91c1c" : "#6b7280" }}>
          {syncStatut === "en_cours" && "Synchronisation avec le site club en cours…"}
          {syncStatut === "ok" && "Données à jour (synchronisées avec le site club)."}
          {syncStatut === "erreur" && `Synchronisation échouée : ${syncMsg} — données potentiellement obsolètes.`}
        </p>
      </header>

      {data === undefined ? (
        <p>Chargement…</p>
      ) : (
        <>
          <div className="licences-cours-total">
            <span>{data.total}</span>
            <span>élève{data.total > 1 ? "s" : ""} sans licence valide</span>
          </div>

          {data.total > 0 && (
            <section aria-label="Relance licence" className="licences-cours-relance">
              <label className="licences-cours-selection-totale">
                <CheckboxGroupe
                  eleves={elevesJoignables}
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
                  onClick={() => void copierEmails("groupe", groupe.emails)}
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
              {groupes.map((jour) => (
                <section className="licences-cours-jour" key={`${jour.priorite}-${jour.libelle}`}>
                  <header className="licences-cours-jour-entete">
                    <div>
                      <span className="licences-cours-niveau">{jour.priorite}</span>
                      <h2>{jour.libelle}</h2>
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

                  <div className="licences-cours-groupes">
                    {jour.cours.map((cours) => (
                      <section className="licences-cours-groupe" key={`${cours.libelle}-${cours.horaire ?? ""}`}>
                        <header className="licences-cours-groupe-entete">
                          <div>
                            <span className="licences-cours-niveau">Cours</span>
                            <h3>{cours.libelle}</h3>
                            <span className="licences-cours-effectif">
                              {cours.eleves.length} élève{cours.eleves.length > 1 ? "s" : ""}
                            </span>
                            {cours.horaire && <span className="licences-cours-horaire">{cours.horaire}</span>}
                          </div>
                          <label className="licences-cours-selection-groupe">
                            <CheckboxGroupe
                              eleves={cours.eleves}
                              selection={selection}
                              onChange={basculerSelection}
                              label={`Sélectionner les élèves joignables du cours ${cours.libelle}`}
                            />
                            Tous les joignables du cours
                          </label>
                        </header>

                        <ul className="licences-cours-eleves">
                          {cours.eleves.map((e) => (
                            <li key={e.eleve_id} className="licences-cours-eleve">
                              <div className="licences-cours-eleve-entete">
                                <div className="licences-cours-eleve-nom">
                      <input
                        type="checkbox"
                        checked={selection.has(e.eleve_id)}
                        disabled={!normaliserAdresseEmailUnique(e.email)}
                        onChange={() => basculerSelection([e])}
                        aria-label={`Sélectionner ${`${e.prenom ?? ""} ${e.nom ?? ""}`.trim() || "cet élève"}`}
                      />
                      <span>{`${e.prenom ?? ""} ${e.nom ?? ""}`.trim() || "—"}</span>
                    </div>
                                <span className="licences-cours-raison">
                      {RAISON_LABEL[e.raison] ?? e.raison}
                    </span>
                  </div>
                              {e.horaire && <p className="licences-cours-horaire">{e.horaire}</p>}
                              <div className="licences-cours-eleve-actions">
                    {normaliserAdresseEmailUnique(e.email) ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => void copierEmails(
                            e.eleve_id,
                            [normaliserAdresseEmailUnique(e.email)!],
                          )}
                        >
                          <Copy size={16} aria-hidden="true" />
                          {copie?.id === e.eleve_id && copie.statut === "ok" ? "Adresse copiée" : "Copier l'adresse"}
                        </button>
                        {copie?.id === e.eleve_id && copie.statut === "erreur" && (
                          <span className="error-message" role="alert">Copie impossible</span>
                        )}
                        <span className="licences-cours-email-source">
                          {e.emailSource === "gestion" ? "Contact du dossier" : "Contact élève"}
                        </span>
                      </>
                    ) : (
                      <span className="licences-cours-email-source">Email non renseigné</span>
                    )}
                  </div>

                  {e.candidats.length > 0 && (
                                <div className="licences-cours-candidats">
                      <div>
                        Correspondances possibles dans l'annuaire des licences :
                      </div>
                      <ul>
                        {e.candidats.map((c) => {
                          const cn = `${c.prenom ?? ""} ${c.nom ?? ""}`.trim() || "—";
                          return (
                            <li key={c.licence}>
                              {cn} — <code>{c.licence}</code>{" "}
                                <span>
                                {Math.round(c.score * 100)}%
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                                </div>
                  )}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
