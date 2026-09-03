import { Component, useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { aboError } from "../lib/errors";
import FusionDossiersModal, { type CandidatFusion } from "./FusionDossiersModal";

class FusionDossiersErrorBoundary extends Component<
  { children: ReactNode; onFermer: () => void },
  { erreur: string | null }
> {
  state = { erreur: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { erreur: aboError(error).message };
  }

  componentDidCatch() {
    // L'erreur est déjà journalisée par React ; l'interface expose ici un
    // retour métier maîtrisé au lieu de faire disparaître l'onglet Licences.
  }

  render() {
    if (!this.state.erreur) return this.props.children;
    return (
      <div className="abo-admin-modal-backdrop" role="presentation">
        <section className="abo-admin-modal abo-admin-fusion-modal" role="alertdialog" aria-modal="true" aria-labelledby="fusion-error-title">
          <h3 id="fusion-error-title">Répartition impossible</h3>
          <p>{this.state.erreur}</p>
          <button type="button" className="abo-admin-button" onClick={this.props.onFermer}>Fermer</button>
        </section>
      </div>
    );
  }
}

// Vue admin « Licences » : résolution des licences des demandes. La licence relie
// demandes / scrap / cours. Les correspondances exactes (nom/prénom, même inversé)
// sont résolues automatiquement ; les autres sont validées ici (candidats fuzzy
// classés par similarité, ou saisie manuelle). Portage de src/pages/admin-licences.js.

export default function Licences() {
  const personnes = useQuery(api.abo.licences.getLicencesAValider);
  const conflits = useQuery(api.abo.licences.getConflitsLicences);
  const resoudre = useMutation(api.abo.licences.resoudreLicencesPersonnes);
  const importer = useAction(api.abo.licences.importerAnnuaireLicences);

  const [msgResoudre, setMsgResoudre] = useState<string | null>(null);
  const [msgImport, setMsgImport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fusion, setFusion] = useState<{ a: CandidatFusion; b: CandidatFusion } | null>(null);

  async function lancerResolution() {
    setMsgResoudre("Résolution…");
    try {
      const n = await resoudre({});
      setMsgResoudre(`${n} personne(s) résolue(s).`);
    } catch (err) {
      setMsgResoudre(`Échec : ${aboError(err).message}`);
    }
  }

  async function lancerImport() {
    setBusy(true);
    setMsgImport("Téléchargement de l'annuaire…");
    try {
      const r = await importer({});
      setMsgImport(
        r.statut === "desactive"
          ? "Synchronisation de l'annuaire en pause pour la nouvelle saison. Réactivez-la dans l'onglet Configuration lorsque l'annuaire est prêt."
          : r.statut === "skipped"
          ? `Aucun appel disponible pour le moment. Nouvelle synchronisation possible ${r.retryAt ? `le ${new Date(r.retryAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" })} (heure de Paris)` : "au prochain créneau de 7 h ou 9 h (heure de Paris)"}.`
          : `Annuaire synchronisé : ${r.upsertees} licence(s) (sur ${r.recus} reçue(s)), ${r.supprimees} retirée(s) du cache.`,
      );
    } catch (err) {
      setMsgImport(`Échec : ${aboError(err).message} Une tentative consomme son créneau ; le prochain appel sera possible au créneau suivant de 7 h ou 9 h (heure de Paris).`);
    } finally {
      setBusy(false);
    }
  }

  if (personnes === undefined) {
    return <p>Chargement…</p>;
  }

  return (
    <div className="abo-admin-section">
      <p className="abo-admin-intro">
        La licence relie les demandes au scrap et aux cours. Les correspondances
        exactes (nom/prénom, même inversé) sont résolues automatiquement.
        Ci-dessous, les personnes à <strong>valider</strong> : choisissez le bon
        candidat de l'annuaire, ou saisissez une licence à la main.
      </p>

      <div className="abo-admin-toolbar">
        <button onClick={lancerResolution} className="abo-admin-button abo-admin-button--secondary">
          ↻ Relancer la résolution automatique
        </button>
        {msgResoudre && <span className="abo-admin-status">{msgResoudre}</span>}
      </div>
      <div className="abo-admin-toolbar">
        <button onClick={lancerImport} className="abo-admin-button abo-admin-button--secondary" disabled={busy}>
          ⬇ Synchroniser l'annuaire des licences
        </button>
        {msgImport && <span className="abo-admin-status">{msgImport}</span>}
      </div>

      <section className="abo-admin-subsection abo-admin-licence-conflicts">
        <h3 className="abo-admin-subheading">Conflits de licence</h3>
        <p className="abo-admin-meta">
          Une licence ne peut appartenir qu'à une personne. Ouvrez les deux dossiers, puis choisissez lesquels garder et où placer chaque personne.
        </p>
        {conflits === undefined ? (
          <p>Chargement…</p>
        ) : conflits.length === 0 ? (
          <p className="abo-admin-empty">Aucun conflit de licence.</p>
        ) : (
          <ul className="abo-admin-list">
            {conflits.map((conflit) => (
              <CarteConflit key={conflit.licence} conflit={conflit} onOuvrirFusion={(a, b) => setFusion({ a, b })} />
            ))}
          </ul>
        )}
      </section>

      <p className="abo-admin-count">
        {personnes.length} personne{personnes.length > 1 ? "s" : ""} à valider
      </p>

      {personnes.length === 0 ? (
        <p className="abo-admin-empty">
          Aucune personne à valider : toutes les licences sont résolues.
        </p>
      ) : (
        <ul className="abo-admin-list">
          {personnes.map((p) => (
            <CartePersonne key={p.personne_id} personne={p} onOuvrirFusion={(a, b) => setFusion({ a, b })} />
          ))}
        </ul>
      )}
      {fusion && (
        <FusionDossiersErrorBoundary key={`${fusion.a.personneId}:${fusion.b.personneId}`} onFermer={() => setFusion(null)}>
          <FusionDossiersModal candidatA={fusion.a} candidatB={fusion.b} onFermer={() => setFusion(null)} />
        </FusionDossiersErrorBoundary>
      )}
    </div>
  );
}

type ConflitLicence = NonNullable<
  ReturnType<typeof useQuery<typeof api.abo.licences.getConflitsLicences>>
>[number];

function CarteConflit({
  conflit,
  onOuvrirFusion,
}: {
  conflit: ConflitLicence;
  onOuvrirFusion: (a: CandidatFusion, b: CandidatFusion) => void;
}) {
  const [cibleId, setCibleId] = useState<Id<"abo_personnes"> | null>(null);

  function candidat(personne: ConflitLicence["personnes"][number]): CandidatFusion {
    return {
      personneId: personne.personneId as Id<"abo_personnes">,
      dossierId: personne.dossierId as Id<"abo_dossiers">,
      nom: personne.nom,
      prenom: personne.prenom,
      email: personne.email,
    };
  }

  function examinerFusion(sourceId: Id<"abo_personnes">) {
    if (!cibleId) return;
    const source = conflit.personnes.find((personne) => personne.personneId === sourceId);
    const cible = conflit.personnes.find((personne) => personne.personneId === cibleId);
    if (!source || !cible) return;
    onOuvrirFusion(
      { personneId: source.personneId as Id<"abo_personnes">, dossierId: source.dossierId as Id<"abo_dossiers">, nom: source.nom, prenom: source.prenom, email: source.email },
      { personneId: cible.personneId as Id<"abo_personnes">, dossierId: cible.dossierId as Id<"abo_dossiers">, nom: cible.nom, prenom: cible.prenom, email: cible.email },
    );
  }

  const paireDirecte = conflit.personnes.length === 2
    && conflit.personnes[0].dossierId !== conflit.personnes[1].dossierId;

  if (paireDirecte) {
    const [personneA, personneB] = conflit.personnes;
    return (
      <li className="abo-admin-card abo-admin-licence-card abo-admin-licence-conflict">
        <strong>Licence {conflit.licence}</strong>
        <p className="abo-admin-meta">
          {personneA.email} ↔ {personneB.email}
        </p>
        <button
          type="button"
          className="abo-admin-link-button abo-admin-link-button--danger"
          onClick={() => onOuvrirFusion(candidat(personneA), candidat(personneB))}
        >
          Ouvrir la répartition des deux dossiers
        </button>
      </li>
    );
  }

  return (
    <li className="abo-admin-card abo-admin-licence-card abo-admin-licence-conflict">
      <strong>Licence {conflit.licence}</strong>
      <p className="abo-admin-meta">Choisissez une première fiche, puis ouvrez avec elle le dossier d'une autre fiche portant cette licence.</p>
      <ul className="abo-admin-sublist">
        {conflit.personnes.map((personne) => {
          const estCible = cibleId === personne.personneId;
          const cible = conflit.personnes.find((candidate) => candidate.personneId === cibleId);
          const memeDossier = Boolean(cible && cible.dossierId === personne.dossierId);
          return (
            <li key={personne.personneId} className="abo-admin-list-row">
              <span>
                <strong>{`${personne.prenom} ${personne.nom}`.trim()}</strong><br />
                <span className="abo-admin-meta">{personne.email} · {personne.etapeValidation}{personne.reservationActive ? " · réservation de test active" : ""}</span>
              </span>
              {estCible ? (
                <span className="abo-admin-badge abo-admin-badge--success">Premier dossier</span>
              ) : cibleId ? (
                memeDossier ? (
                  <span className="abo-admin-meta">Déjà dans le même dossier : correction manuelle requise</span>
                ) : (
                  <button type="button" className="abo-admin-link-button abo-admin-link-button--danger" onClick={() => examinerFusion(personne.personneId as Id<"abo_personnes">)}>
                    Répartir les personnes entre les dossiers
                  </button>
                )
              ) : (
                <button type="button" className="abo-admin-link-button" onClick={() => setCibleId(personne.personneId as Id<"abo_personnes">)}>
                  Choisir comme premier dossier
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {cibleId && <button type="button" className="abo-admin-link-button" onClick={() => setCibleId(null)}>Changer de premier dossier</button>}
    </li>
  );
}

type PersonneAValider = NonNullable<
  ReturnType<typeof useQuery<typeof api.abo.licences.getLicencesAValider>>
>[number];

function CartePersonne({ personne, onOuvrirFusion }: { personne: PersonneAValider; onOuvrirFusion: (a: CandidatFusion, b: CandidatFusion) => void }) {
  const validerLicence = useMutation(api.abo.licences.validerLicence);
  const [manuel, setManuel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [conflit, setConflit] = useState<{
    licence: string;
    personneExistanteId: Id<"abo_personnes">;
    personneExistanteNom: string;
    personneExistantePrenom: string;
    personneExistanteEmail: string | null;
    personneCibleDossierId: Id<"abo_dossiers">;
    personneExistanteDossierId: Id<"abo_dossiers">;
  } | null>(null);

  async function associer(licence: string) {
    setMsg("Association…");
    try {
      const resultat = await validerLicence({
        personneId: personne.personne_id as Id<"abo_personnes">,
        licence: licence.trim(),
      });
      if (resultat.statut === "conflit") {
        setConflit(resultat);
        setMsg(null);
      } else {
        setConflit(null);
        // La personne résolue disparaît de la liste (query réactive).
      }
    } catch (err) {
      setMsg(`Échec : ${aboError(err).message}`);
    }
  }

  function examinerFusion() {
    if (!conflit) return;
    onOuvrirFusion(
      { personneId: personne.personne_id as Id<"abo_personnes">, dossierId: conflit.personneCibleDossierId, nom: personne.nom, prenom: personne.prenom, email: null },
      { personneId: conflit.personneExistanteId, dossierId: conflit.personneExistanteDossierId, nom: conflit.personneExistanteNom, prenom: conflit.personneExistantePrenom, email: conflit.personneExistanteEmail },
    );
  }

  const nom = `${personne.prenom} ${personne.nom}`.trim() || "—";
  const conflitDansMemeDossier = conflit?.personneCibleDossierId === conflit?.personneExistanteDossierId;

  return (
    <li className="abo-admin-card abo-admin-licence-card">
      <div className="abo-admin-card-title">{nom}</div>
      <ul className="abo-admin-sublist">
        {personne.candidats.length === 0 ? (
          <li className="abo-admin-empty">
            Aucun candidat proche dans l'annuaire.
          </li>
        ) : (
          personne.candidats.map((c) => {
            const cn = `${c.prenom ?? ""} ${c.nom ?? ""}`.trim() || "—";
            return (
              <li
                key={c.licence}
                className="abo-admin-list-row"
              >
                <span>
                  {cn} — <code>{c.licence}</code>{" "}
                  <span className="abo-admin-meta">
                    {Math.round((c.score ?? 0) * 100)}%
                  </span>
                </span>
                <button
                  onClick={() => associer(c.licence)}
                  className="abo-admin-link-button"
                >
                  Associer
                </button>
              </li>
            );
          })
        )}
      </ul>
      <div className="abo-admin-toolbar">
        <input
          type="text"
          inputMode="numeric"
          placeholder="Saisir une licence (12 chiffres)"
          value={manuel}
          onChange={(e) => setManuel(e.target.value)}
        />
        <button
          onClick={() => associer(manuel)}
          className="abo-admin-link-button"
        >
          Associer cette licence
        </button>
      </div>
      {conflit && (
        <div className="abo-admin-notice abo-admin-notice--warning">
          <strong>Licence {conflit.licence} déjà attribuée</strong>
          <p>
            Elle est actuellement liée à {`${conflit.personneExistantePrenom} ${conflit.personneExistanteNom}`.trim()}
            {conflit.personneExistanteEmail ? ` (${conflit.personneExistanteEmail})` : ""}.
          </p>
          <p>
            Si c&apos;est la même personne dans deux dossiers différents, choisissez les dossiers à garder et le dossier de chaque personne. Vous pouvez aussi conserver les deux dossiers.
          </p>
          {conflitDansMemeDossier ? (
            <p className="abo-admin-meta">Les deux fiches sont déjà dans le même dossier : corrigez-les manuellement sans ouvrir la répartition.</p>
          ) : (
            <button type="button" onClick={examinerFusion} className="abo-admin-link-button abo-admin-link-button--danger">
              Ouvrir la répartition des deux dossiers
            </button>
          )}
        </div>
      )}
      {msg && (
        <p className="abo-admin-status abo-admin-status--error">
          {msg}
        </p>
      )}
    </li>
  );
}
