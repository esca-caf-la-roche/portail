import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { aboError } from "../lib/errors";
import { cleJour, formatJour, formatTranche } from "../lib/tests";

export default function TestAutonomieDirect({ demande }: { demande: React.ReactNode }) {
  const [mode, setMode] = useState<"choix" | "demande" | "test">("choix");
  if (mode === "demande") return <>{demande}</>;
  if (mode === "test") return <ReservationDirecte />;
  return <div className="abo-content"><h1>Abonnements escalade</h1><section className="abo-carte"><h2>Que souhaitez-vous faire ?</h2><p>Déposez une demande de disponibilité si vous n'êtes pas encore inscrit·e sur le site du club.</p><button className="abo-btn" type="button" onClick={() => setMode("demande")}>Faire une demande de disponibilité</button><hr /><p>Déjà inscrit·e sur le site du club et test requis ?</p><button className="abo-btn" type="button" onClick={() => setMode("test")}>Réserver un test d'autonomie</button></section></div>;
}

function ReservationDirecte() {
  const [licence, setLicence] = useState("");
  const [recherche, setRecherche] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const eligibility = useQuery(api.abo.tests.eligibiliteReservationDirecteTest, recherche ? { licence: recherche } : "skip");
  const reservations = useQuery(api.abo.tests.getMesReservationsDirectes);
  const creneaux = useQuery(api.abo.tests.testCreneauxDisponibles);
  const reserver = useMutation(api.abo.tests.reserverTestDirect);
  const annuler = useMutation(api.abo.tests.annulerMaReservationDirecte);
  const active = reservations?.[0];
  async function choisir(tranche: string) { if (!recherche) return; setBusy(true); try { await reserver({ licence: recherche, tranche }); } catch (err) { setErreur(aboError(err).message); } finally { setBusy(false); } }
  const jours = new Map<string, { label: string; tranches: NonNullable<typeof creneaux> }>();
  for (const c of creneaux ?? []) { const key = cleJour(c.tranche_debut); if (!jours.has(key)) jours.set(key, { label: formatJour(c.tranche_debut), tranches: [] }); jours.get(key)!.tranches.push(c); }
  return <div className="abo-content"><h1>Réserver un test d'autonomie</h1>
    {active ? <section className="abo-carte"><h2>{active.prenom} {active.nom}</h2><p><strong>Votre RDV :</strong> {formatJour(active.tranche)}, {formatTranche(active.tranche, active.tranche_fin)}</p><button className="abo-link" type="button" disabled={busy} onClick={async () => { setBusy(true); try { await annuler({ reservationId: active.id }); } catch (err) { setErreur(aboError(err).message); } finally { setBusy(false); } }}>Annuler ce RDV</button></section> : <>
      <section className="abo-carte"><p>Indiquez le numéro de licence utilisé sur le site du club. L'adresse e-mail de connexion doit être la même.</p><form onSubmit={(e) => { e.preventDefault(); setRecherche(licence.trim()); setErreur(null); }}><label className="abo-label">Numéro de licence<input value={licence} onChange={(e) => setLicence(e.target.value)} required /></label><button className="abo-btn" type="submit">Vérifier ma situation</button></form>{recherche && eligibility === undefined && <p>Vérification…</p>}{eligibility && <p className="abo-resa-information" role="status">{eligibility.message}</p>}</section>
      {eligibility?.autorisee && <section className="abo-carte"><h2>Choisir un créneau</h2>{jours.size === 0 ? <p>Aucun créneau disponible pour l'instant.</p> : [...jours.values()].map((jour) => <div key={jour.label} className="abo-resa-jour"><h3>{jour.label}</h3>{jour.tranches.map((t) => <button key={t.tranche_debut} className="abo-resa-tranche" type="button" disabled={busy} onClick={() => choisir(t.tranche_debut)}>{formatTranche(t.tranche_debut, t.tranche_fin)} — {t.disponible} place{t.disponible > 1 ? "s" : ""}</button>)}</div>)}</section>}
    </>}
    {erreur && <p className="abo-msg abo-msg-error" role="alert">{erreur}</p>}
  </div>;
}
