import { useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { aboError } from "../lib/errors";
import { cleJour, formatJour, formatTranche } from "../lib/tests";
import NotificationDisponibilitesTest from "../NotificationDisponibilitesTest";

export default function TestAutonomieDirectV2({ demande, initialMode = "choix" }: { demande: React.ReactNode; initialMode?: "choix" | "test" }) {
  const [mode, setMode] = useState<"choix" | "demande" | "test">(initialMode);
  if (mode === "demande") return <>{demande}</>;
  if (mode === "test") return <ReservationDirecte />;
  return <div className="abo-content"><h1>Abonnements escalade</h1><section className="abo-carte abo-parcours-choix"><h2>Que souhaitez-vous faire ?</h2><div className="abo-parcours-option"><h3>Je ne suis pas encore inscrit·e sur le site du club</h3><p>Déposez une demande de disponibilité avant de vous inscrire.</p><button className="abo-btn" type="button" onClick={() => setMode("demande")}>Faire une demande de disponibilité</button></div><div className="abo-parcours-option abo-parcours-option--test"><h3>Je suis déjà inscrit·e sur le site du club</h3><p>Vous avez besoin de passer un test d’autonomie ? Réservez votre créneau ici.</p><button className="abo-btn" type="button" onClick={() => setMode("test")}>Réserver un test d’autonomie</button></div></section></div>;
}

function ReservationDirecte() {
  const [licence, setLicence] = useState("");
  const [ajout, setAjout] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verificationId = useRef(0);
  const candidats = useQuery(api.abo.tests.mesCandidatsDirects);
  const reservations = useQuery(api.abo.tests.getMesReservationsDirectes);
  const creneaux = useQuery(api.abo.tests.testCreneauxDisponibles);
  const synchroniser = useAction(api.abo.scrap.synchroniserPourTestAutonomieDirect);
  const memoriser = useMutation(api.abo.tests.verifierEtMemoriserCandidatDirect);
  const retirer = useMutation(api.abo.tests.retirerCandidatDirect);
  const reserver = useMutation(api.abo.tests.reserverTestDirect);
  const annuler = useMutation(api.abo.tests.annulerMaReservationDirecte);
  const jours = new Map<string, { label: string; tranches: NonNullable<typeof creneaux> }>();
  for (const creneau of creneaux ?? []) { const key = cleJour(creneau.tranche_debut); if (!jours.has(key)) jours.set(key, { label: formatJour(creneau.tranche_debut), tranches: [] }); jours.get(key)!.tranches.push(creneau); }

  function retry(value: string | null) { return value ? `le ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(value))}` : "dans quelques minutes"; }
  async function verifier() {
    const saisie = licence.trim();
    if (!saisie) { setErreur("Indiquez votre numéro de licence."); return; }
    const id = ++verificationId.current; setBusy(true); setErreur(null); setMessage(null);
    try {
      const synchro = await synchroniser({ licence: saisie });
      if (id !== verificationId.current) return;
      if (synchro.statut === "en_cours") { setMessage(`Une mise à jour est déjà en cours. Réessayez après ${retry(synchro.retryAt)}.`); return; }
      if (synchro.statut !== "done" && synchro.statut !== "skipped") { setErreur(synchro.statut === "desactive" ? "La mise à jour des inscriptions est temporairement désactivée." : "La mise à jour des inscriptions a échoué. Réessayez dans quelques minutes."); return; }
      const resultat = await memoriser({ licence: synchro.licence });
      if (!resultat.autorisee) { setMessage(resultat.motif === "inscription_non_verifiable" && synchro.statut === "skipped" ? `Cette inscription n'a pas pu être vérifiée. Réessayez après ${retry(synchro.retryAt)}.` : resultat.message); return; }
      setLicence(""); setAjout(false); setMessage(`${resultat.candidat?.prenom ?? ""} ${resultat.candidat?.nom ?? ""} a bien été ajouté·e à ce compte.`.trim());
    } catch (error) { setErreur(aboError(error).message); } finally { if (id === verificationId.current) setBusy(false); }
  }
  async function choisir(candidatId: Id<"abo_test_candidats_directs">, tranche: string) { setBusy(true); setErreur(null); try { await reserver({ candidatId, tranche }); } catch (error) { setErreur(aboError(error).message); } finally { setBusy(false); } }
  const formulaire = candidats?.length === 0 || ajout;
  const licencesMemorisees = new Set((candidats ?? []).map((candidat) => candidat.licence));
  const reservationsOrphelines = (reservations ?? []).filter((reservation) => !licencesMemorisees.has(reservation.licence));

  return <div className="abo-content"><h1>Réserver un test d'autonomie</h1>
    {reservationsOrphelines.map((reservation) => <section className="abo-carte" key={reservation.id}><h2>{reservation.prenom} {reservation.nom}</h2><p>Licence {reservation.licence}</p><div className="abo-resa-active"><p><strong>Votre RDV :</strong> {formatJour(reservation.tranche)}, {formatTranche(reservation.tranche, reservation.tranche_fin)}</p><button className="abo-link" type="button" disabled={busy} onClick={async () => { setBusy(true); setErreur(null); try { await annuler({ reservationId: reservation.id }); } catch (error) { setErreur(aboError(error).message); } finally { setBusy(false); } }}>Annuler ce RDV</button></div></section>)}
    {candidats === undefined ? <p>Chargement…</p> : candidats.map((candidat) => {
      const reservation = reservations?.find((ligne) => ligne.licence === candidat.licence);
      return <section className="abo-carte abo-candidat-test" key={candidat._id}><div className="abo-candidat-test__entete"><div><h2>{candidat.prenom} {candidat.nom}</h2><p>Licence {candidat.licence}</p></div>{!reservation && <button className="abo-link" type="button" disabled={busy} onClick={async () => { setBusy(true); setErreur(null); try { await retirer({ candidatId: candidat._id }); } catch (error) { setErreur(aboError(error).message); } finally { setBusy(false); } }}>Retirer de ce compte</button>}</div>
        {reservation ? <div className="abo-resa-active"><p><strong>Votre RDV :</strong> {formatJour(reservation.tranche)}, {formatTranche(reservation.tranche, reservation.tranche_fin)}</p><button className="abo-link" type="button" disabled={busy} onClick={async () => { setBusy(true); setErreur(null); try { await annuler({ reservationId: reservation.id }); } catch (error) { setErreur(aboError(error).message); } finally { setBusy(false); } }}>Annuler ce RDV</button></div>
          : candidat.statut === "ineligible" ? <p className="abo-resa-information">{candidat.motif_ineligibilite ?? "Cette personne n'est plus éligible au test."}</p>
          : jours.size === 0 ? <><p>Aucun créneau disponible pour l'instant.</p><NotificationDisponibilitesTest cible={{ type: "direct", candidatId: candidat._id }} /></>
          : <><div className="abo-resa-jours">{[...jours.values()].map((jour) => <div key={jour.label} className="abo-resa-jour"><h3>{jour.label}</h3><div className="abo-resa-tranches">{jour.tranches.map((tranche) => <button key={tranche.tranche_debut} className="abo-resa-tranche" type="button" disabled={busy} onClick={() => choisir(candidat._id, tranche.tranche_debut)}><span>{formatTranche(tranche.tranche_debut, tranche.tranche_fin)}</span><span className="abo-resa-places">{tranche.disponible} place{tranche.disponible > 1 ? "s" : ""}</span></button>)}</div></div>)}</div><NotificationDisponibilitesTest masquerSiInactif cible={{ type: "direct", candidatId: candidat._id }} /></>}
      </section>;
    })}
    {candidats && candidats.length > 0 && !ajout && <button className="abo-btn" type="button" onClick={() => setAjout(true)}>Ajouter une autre licence</button>}
    {formulaire && <section className="abo-carte abo-verification-licence"><p>Indiquez le numéro de licence utilisé sur le site du club.</p><form onSubmit={(event) => { event.preventDefault(); void verifier(); }}><label className="abo-label">Numéro de licence<input value={licence} onChange={(event) => { verificationId.current += 1; setLicence(event.target.value); setErreur(null); setMessage(null); }} required /></label><button className="abo-btn" type="submit" disabled={busy}>{busy ? "Mise à jour…" : "Vérifier ma situation"}</button>{candidats && candidats.length > 0 && <button className="abo-link" type="button" disabled={busy} onClick={() => setAjout(false)}>Annuler</button>}</form></section>}
    {message && <p className="abo-resa-information" role="status">{message}</p>}{erreur && <p className="abo-msg abo-msg-error" role="alert">{erreur}</p>}
  </div>;
}
