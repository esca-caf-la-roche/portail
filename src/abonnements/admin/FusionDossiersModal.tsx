import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { aboError } from "../lib/errors";

export interface CandidatFusion {
  personneId: Id<"abo_personnes">;
  dossierId: Id<"abo_dossiers">;
  nom: string;
  prenom: string;
  email: string | null;
}

type ModeRepartition = "conserver_les_deux" | "conserver_a" | "conserver_b";
type Apercu = FunctionReturnType<typeof api.abo.fusionsDossiers.getApercuRepartitionDossiers>;
type Resultat = FunctionReturnType<typeof api.abo.fusionsDossiers.resoudreConflitDossiers>;
type Dossier = Apercu["dossierA"];

function nomComplet(personne: { nom: string; prenom: string }) {
  return `${personne.prenom} ${personne.nom}`.trim() || "Personne sans nom";
}

function libelleLicence(licence: string | null) {
  return licence ? `Licence ${licence}` : "Licence non renseignée";
}

function memeEmail(saisie: string, email: string) {
  return saisie.trim().toLocaleLowerCase("fr") === email.trim().toLocaleLowerCase("fr");
}

export default function FusionDossiersModal({ candidatA, candidatB, onFermer }: { candidatA: CandidatFusion; candidatB: CandidatFusion; onFermer: () => void }) {
  const titreId = useId();
  const descriptionId = useId();
  const modalRef = useRef<HTMLElement>(null);
  const fermerRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<ModeRepartition>("conserver_les_deux");
  const [affectations, setAffectations] = useState<Record<string, Id<"abo_dossiers">>>({});
  const [confirmation, setConfirmation] = useState("");
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [resultat, setResultat] = useState<Resultat | null>(null);
  const enCoursRef = useRef(enCours);
  const onFermerRef = useRef(onFermer);

  // La mutation supprime l'une des deux fiches en doublon. Suspendre la query
  // avant son exécution évite qu'une invalidation réactive relance l'aperçu
  // avec l'identifiant supprimé alors que la résolution a bien réussi.
  const apercu = useQuery(
    api.abo.fusionsDossiers.getApercuRepartitionDossiers,
    enCours || resultat
      ? "skip"
      : {
          personneAId: candidatA.personneId,
          personneBId: candidatB.personneId,
        },
  );
  const resoudre = useMutation(api.abo.fusionsDossiers.resoudreConflitDossiers);

  useEffect(() => {
    enCoursRef.current = enCours;
  }, [enCours]);

  useEffect(() => {
    onFermerRef.current = onFermer;
  }, [onFermer]);

  const lignes = useMemo(() => {
    if (!apercu) return [];
    return [
      ...apercu.dossierA.personnes.map((personne) => ({ ...personne, dossierActuelId: apercu.dossierA.id, doublon: false as const })),
      ...apercu.dossierB.personnes.map((personne) => ({ ...personne, dossierActuelId: apercu.dossierB.id, doublon: false as const })),
      {
        id: apercu.personneDoublon.idLogique,
        nom: apercu.personneDoublon.optionA.nom,
        prenom: apercu.personneDoublon.optionA.prenom,
        licence: apercu.personneDoublon.optionA.licence ?? apercu.personneDoublon.optionB.licence,
        dossierActuelId: null,
        doublon: true as const,
        optionA: apercu.personneDoublon.optionA,
        optionB: apercu.personneDoublon.optionB,
      },
    ];
  }, [apercu]);

  useEffect(() => {
    const precedent = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    fermerRef.current?.focus();
    function gererClavier(event: KeyboardEvent) {
      if (event.key === "Escape" && !enCoursRef.current) onFermerRef.current();
      if (event.key !== "Tab" || !modalRef.current) return;
      const elements = Array.from(modalRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (elements.length === 0) return;
      const premier = elements[0];
      const dernier = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === premier) {
        event.preventDefault();
        dernier.focus();
      } else if (!event.shiftKey && document.activeElement === dernier) {
        event.preventDefault();
        premier.focus();
      }
    }
    window.addEventListener("keydown", gererClavier);
    return () => {
      window.removeEventListener("keydown", gererClavier);
      precedent?.focus();
    };
  }, []);

  function choisirMode(nouveauMode: ModeRepartition) {
    if (!apercu) return;
    setMode(nouveauMode);
    setConfirmation("");
    setErreur(null);
    const prochaines: Record<string, Id<"abo_dossiers">> = {};
    if (nouveauMode === "conserver_a" || nouveauMode === "conserver_b") {
      const dossierId = nouveauMode === "conserver_a" ? apercu.dossierA.id : apercu.dossierB.id;
      for (const ligne of lignes) prochaines[ligne.id] = dossierId;
    } else {
      for (const personne of apercu.dossierA.personnes) prochaines[personne.id] = apercu.dossierA.id;
      for (const personne of apercu.dossierB.personnes) prochaines[personne.id] = apercu.dossierB.id;
    }
    setAffectations(prochaines);
  }

  const affectationsEffectives = useMemo(() => Object.fromEntries(lignes.flatMap((ligne) => {
    const dossierId = affectations[ligne.id] ?? ligne.dossierActuelId;
    return dossierId ? [[ligne.id, dossierId]] : [];
  })) as Record<string, Id<"abo_dossiers">>, [affectations, lignes]);
  const nombreA = apercu ? lignes.filter(({ id }) => affectationsEffectives[id] === apercu.dossierA.id).length : 0;
  const nombreB = apercu ? lignes.filter(({ id }) => affectationsEffectives[id] === apercu.dossierB.id).length : 0;
  const toutesAffectees = lignes.length > 0 && lignes.every(({ id }) => affectationsEffectives[id] !== undefined);
  const dossiersNonVides = mode !== "conserver_les_deux" || (nombreA > 0 && nombreB > 0);
  const emailSupprime = apercu
    ? mode === "conserver_a" ? apercu.dossierB.email : mode === "conserver_b" ? apercu.dossierA.email : null
    : null;
  const alertes = apercu?.alertes ?? [];
  const confirmationValide = emailSupprime === null || memeEmail(confirmation, emailSupprime);
  const peutConfirmer = Boolean(apercu && toutesAffectees && dossiersNonVides && confirmationValide && alertes.length === 0 && !enCours);

  async function confirmer() {
    if (!apercu || !peutConfirmer) return;
    setEnCours(true);
    setErreur(null);
    try {
      const reponse = await resoudre({
        personneAId: candidatA.personneId,
        personneBId: candidatB.personneId,
        revision: apercu.revision,
        mode,
        affectations: lignes.map(({ id }) => ({ personneId: id, dossierId: affectationsEffectives[id] })),
      });
      setResultat(reponse);
    } catch (cause) {
      setErreur(aboError(cause).message);
    } finally {
      setEnCours(false);
    }
  }

  return (
    <div className="abo-admin-modal-backdrop" role="presentation">
      <section ref={modalRef} className="abo-admin-modal abo-admin-fusion-modal" role="dialog" aria-modal="true" aria-labelledby={titreId} aria-describedby={descriptionId}>
        <div className="abo-admin-modal-header">
          <h3 id={titreId}>Répartir les personnes entre les dossiers</h3>
          <button ref={fermerRef} type="button" className="abo-admin-modal-close" onClick={onFermer} disabled={enCours} aria-label="Fermer">×</button>
        </div>
        <p id={descriptionId} className="abo-admin-modal-copy">Choisissez les dossiers à garder, puis vérifiez dans quel dossier se trouve chaque personne.</p>

        {resultat ? (
          <div className="abo-admin-fusion-result" role="status">
            <h4>Répartition enregistrée</h4>
            <p>{resultat.dossiersConserves.length} dossier(s) conservé(s). {resultat.personnesDeplacees} personne(s) déplacée(s).</p>
            <p>{resultat.notificationsPlanifiees} notification(s) programmée(s).</p>
            <button type="button" className="abo-admin-button abo-admin-button--primary" onClick={onFermer}>Fermer</button>
          </div>
        ) : enCours ? (
          <p className="abo-admin-fusion-loading" role="status">Enregistrement de la répartition…</p>
        ) : apercu === undefined ? (
          <p className="abo-admin-fusion-loading" role="status">Chargement des deux dossiers…</p>
        ) : (
          <div className="abo-admin-fusion-body">
            <fieldset className="abo-admin-fusion-fieldset">
              <legend>Dossiers à conserver</legend>
              <div className="abo-admin-fusion-modes">
                <label className="abo-admin-fusion-mode"><input type="radio" name="mode-repartition" checked={mode === "conserver_les_deux"} onChange={() => choisirMode("conserver_les_deux")} /><span>Garder les deux dossiers</span></label>
                <label className="abo-admin-fusion-mode"><input type="radio" name="mode-repartition" checked={mode === "conserver_a"} onChange={() => choisirMode("conserver_a")} /><span>Garder seulement {apercu.dossierA.email}</span></label>
                <label className="abo-admin-fusion-mode"><input type="radio" name="mode-repartition" checked={mode === "conserver_b"} onChange={() => choisirMode("conserver_b")} /><span>Garder seulement {apercu.dossierB.email}</span></label>
              </div>
            </fieldset>

            {alertes.map((alerte) => <div key={alerte.code} className="abo-admin-notice abo-admin-notice--error" role="alert">{alerte.message}</div>)}

            {!toutesAffectees && lignes.filter(({ id }) => affectationsEffectives[id] === undefined).map((personne) => (
              <div key={personne.id} className="abo-admin-fusion-unassigned">
                <strong>Choisissez le dossier de la personne présente en double</strong>
                <PersonneRow
                  personne={personne}
                  dossierA={apercu.dossierA}
                  dossierB={apercu.dossierB}
                  dossierChoisiId={affectationsEffectives[personne.id]}
                  disabled={false}
                  onAffecter={(dossierId) => setAffectations((courantes) => ({ ...courantes, [personne.id]: dossierId }))}
                />
              </div>
            ))}

            <div className="abo-admin-fusion-split">
              <DossierColumn dossier={apercu.dossierA} autreDossier={apercu.dossierB} cote="A" lignes={lignes} affectations={affectationsEffectives} mode={mode} onAffecter={(personneId, dossierId) => setAffectations((courantes) => ({ ...courantes, [personneId]: dossierId }))} />
              <DossierColumn dossier={apercu.dossierB} autreDossier={apercu.dossierA} cote="B" lignes={lignes} affectations={affectationsEffectives} mode={mode} onAffecter={(personneId, dossierId) => setAffectations((courantes) => ({ ...courantes, [personneId]: dossierId }))} />
            </div>

            {!toutesAffectees && <div className="abo-admin-notice abo-admin-notice--warning" role="status">Choisissez un dossier pour la personne présente en double.</div>}
            {toutesAffectees && !dossiersNonVides && <div className="abo-admin-notice abo-admin-notice--warning" role="status">Chaque dossier conservé doit contenir au moins une personne.</div>}

            <section className="abo-admin-fusion-summary" aria-labelledby={`${titreId}-resume`}>
              <h4 id={`${titreId}-resume`}>Résumé</h4>
              <p><strong>{apercu.dossierA.email}</strong> : {nombreA} personne(s){mode === "conserver_b" ? " — dossier supprimé" : ""}</p>
              <p><strong>{apercu.dossierB.email}</strong> : {nombreB} personne(s){mode === "conserver_a" ? " — dossier supprimé" : ""}</p>
            </section>

            {emailSupprime && (
              <label className="abo-admin-fusion-confirm">
                Pour confirmer la suppression du dossier, retapez son e-mail : <strong>{emailSupprime}</strong>
                <input type="email" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={enCours} autoComplete="off" />
              </label>
            )}
            {erreur && <div className="abo-admin-notice abo-admin-notice--error" role="alert">Échec de la répartition : {erreur}</div>}
            <div className="abo-admin-fusion-actions">
              <button type="button" className="abo-admin-button" onClick={onFermer} disabled={enCours}>Annuler</button>
              <button type="button" className="abo-admin-button abo-admin-button--primary" disabled={!peutConfirmer} onClick={() => void confirmer()}>
                {enCours ? "Enregistrement…" : emailSupprime ? "Supprimer le dossier et enregistrer" : "Enregistrer la répartition"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

type LignePersonne = {
  id: Id<"abo_personnes">;
  nom: string;
  prenom: string;
  licence: string | null;
  doublon: boolean;
  optionA?: { nom: string; prenom: string };
  optionB?: { nom: string; prenom: string };
};

function DossierColumn({ dossier, autreDossier, cote, lignes, affectations, mode, onAffecter }: {
  dossier: Dossier;
  autreDossier: Dossier;
  cote: "A" | "B";
  lignes: LignePersonne[];
  affectations: Record<string, Id<"abo_dossiers">>;
  mode: ModeRepartition;
  onAffecter: (personneId: Id<"abo_personnes">, dossierId: Id<"abo_dossiers">) => void;
}) {
  const supprime = (cote === "A" && mode === "conserver_b") || (cote === "B" && mode === "conserver_a");
  const personnes = lignes.filter(({ id }) => affectations[id] === dossier.id);
  return (
    <section className={`abo-admin-fusion-dossier${supprime ? " abo-admin-fusion-dossier--supprime" : ""}`} aria-label={`Dossier ${cote} ${dossier.email}`}>
      <header className="abo-admin-fusion-dossier-header">
        <span>Dossier {cote}</span>
        <strong className="abo-admin-fusion-email">{dossier.email}</strong>
        {supprime && <span className="abo-admin-badge">Supprimé</span>}
      </header>
      <div className="abo-admin-fusion-family">
        {personnes.map((personne) => (
          <PersonneRow
            key={personne.id}
            personne={personne}
            dossierA={cote === "A" ? dossier : autreDossier}
            dossierB={cote === "B" ? dossier : autreDossier}
            dossierChoisiId={dossier.id}
            disabled={mode !== "conserver_les_deux"}
            onAffecter={(dossierId) => onAffecter(personne.id, dossierId)}
          />
        ))}
        {personnes.length === 0 && <div className="abo-admin-fusion-empty">Aucune personne dans ce dossier</div>}
      </div>
    </section>
  );
}

function PersonneRow({ personne, dossierA, dossierB, dossierChoisiId, disabled, onAffecter }: {
  personne: LignePersonne;
  dossierA: Dossier;
  dossierB: Dossier;
  dossierChoisiId: Id<"abo_dossiers"> | undefined;
  disabled: boolean;
  onAffecter: (dossierId: Id<"abo_dossiers">) => void;
}) {
  const identiteDoublon = personne.doublon && personne.optionA && personne.optionB
    ? dossierChoisiId === dossierA.id
      ? nomComplet(personne.optionA)
      : dossierChoisiId === dossierB.id
        ? nomComplet(personne.optionB)
        : `${nomComplet(personne.optionA)} (A) ou ${nomComplet(personne.optionB)} (B)`
    : null;
  return (
    <div className={`abo-admin-fusion-person${personne.doublon ? " abo-admin-fusion-person--doublon" : ""}`}>
      <div className="abo-admin-fusion-person-identity">
        <strong>{identiteDoublon ?? nomComplet(personne)}</strong>
        <span className="abo-admin-fusion-person-meta">{libelleLicence(personne.licence)}</span>
        {personne.doublon && <span className="abo-admin-badge">Présente en double</span>}
      </div>
      <fieldset className="abo-admin-fusion-person-destination">
        <legend>Dossier</legend>
        <label><input type="radio" name={`affectation-${personne.id}`} checked={dossierChoisiId === dossierA.id} onChange={() => onAffecter(dossierA.id)} disabled={disabled} /><span>A</span></label>
        <label><input type="radio" name={`affectation-${personne.id}`} checked={dossierChoisiId === dossierB.id} onChange={() => onAffecter(dossierB.id)} disabled={disabled} /><span>B</span></label>
      </fieldset>
    </div>
  );
}
