import { useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { aboError } from "../lib/errors";
import { cleJour, formatJour, formatTranche } from "../lib/tests";

export default function TestAutonomieDirect({ demande }: { demande: React.ReactNode }) {
  const [mode, setMode] = useState<"choix" | "demande" | "test">("choix");
  if (mode === "demande") return <>{demande}</>;
  if (mode === "test") return <ReservationDirecte />;
  return (
    <div className="abo-content">
      <h1>Abonnements escalade</h1>
      <section className="abo-carte abo-parcours-choix">
        <h2>Que souhaitez-vous faire ?</h2>
        <div className="abo-parcours-option">
          <h3>Je ne suis pas encore inscrit·e sur le site du club</h3>
          <p>Déposez une demande de disponibilité avant de vous inscrire.</p>
          <button className="abo-btn" type="button" onClick={() => setMode("demande")}>
            Faire une demande de disponibilité
          </button>
        </div>
        <div className="abo-parcours-option abo-parcours-option--test">
          <h3>Je suis déjà inscrit·e sur le site du club</h3>
          <p>Vous avez besoin de passer un test d’autonomie ? Réservez votre créneau ici.</p>
          <button className="abo-btn" type="button" onClick={() => setMode("test")}>
            Réserver un test d’autonomie
          </button>
        </div>
      </section>
    </div>
  );
}

function ReservationDirecte() {
  const [licence, setLicence] = useState("");
  const [recherche, setRecherche] = useState<{
    licence: string;
    maintenantMs: number;
  } | null>(null);
  const [synchronisation, setSynchronisation] = useState<{
    statut: "skipped";
    retryAt: string | null;
  } | null>(null);
  const [informationSynchronisation, setInformationSynchronisation] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [synchronisationEnCours, setSynchronisationEnCours] = useState(false);
  const verificationId = useRef(0);
  const synchronisationId = useRef<number | null>(null);
  const eligibility = useQuery(api.abo.tests.eligibiliteReservationDirecteTest, recherche ?? "skip");
  const reservations = useQuery(api.abo.tests.getMesReservationsDirectes);
  const creneaux = useQuery(api.abo.tests.testCreneauxDisponibles);
  const synchroniser = useAction(api.abo.scrap.synchroniserPourTestAutonomieDirect);
  const reserver = useMutation(api.abo.tests.reserverTestDirect);
  const annuler = useMutation(api.abo.tests.annulerMaReservationDirecte);
  const active = reservations?.[0];

  function formatRetryAt(value: string | null): string {
    if (!value) return "dans quelques minutes";
    const date = new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "Europe/Paris",
    }).format(new Date(value));
    return `le ${date}`;
  }

  function modifierLicence(value: string) {
    verificationId.current += 1;
    setLicence(value);
    setRecherche(null);
    setSynchronisation(null);
    setInformationSynchronisation(null);
    setErreur(null);
  }

  async function verifierLicence() {
    const licenceSaisie = licence.trim();
    if (!licenceSaisie) {
      setErreur("Indiquez votre numéro de licence.");
      return;
    }
    const requeteId = ++verificationId.current;
    synchronisationId.current = requeteId;
    setRecherche(null);
    setSynchronisation(null);
    setInformationSynchronisation(null);
    setErreur(null);
    setSynchronisationEnCours(true);
    try {
      const resultat = await synchroniser({ licence: licenceSaisie });
      if (requeteId !== verificationId.current) return;
      if (resultat.statut === "done" || resultat.statut === "skipped") {
        setSynchronisation(
          resultat.statut === "skipped"
            ? { statut: "skipped", retryAt: resultat.retryAt }
            : null,
        );
        setRecherche({ licence: resultat.licence, maintenantMs: Date.now() });
        return;
      }
      if (resultat.statut === "en_cours") {
        setInformationSynchronisation(
          `Une mise à jour des inscriptions du club est déjà en cours. Réessayez après ${formatRetryAt(resultat.retryAt)}.`,
        );
        return;
      }
      setErreur(
        resultat.statut === "desactive"
          ? "La mise à jour des inscriptions du club est temporairement désactivée. Votre licence ne peut pas être vérifiée pour le moment."
          : "La mise à jour des inscriptions du club a échoué. Votre licence ne peut pas être vérifiée pour le moment. Réessayez dans quelques minutes.",
      );
    } catch (err) {
      if (requeteId === verificationId.current) setErreur(aboError(err).message);
    } finally {
      if (synchronisationId.current === requeteId) {
        synchronisationId.current = null;
        setSynchronisationEnCours(false);
      }
    }
  }

  async function choisir(tranche: string) { if (!recherche) return; setBusy(true); try { await reserver({ licence: recherche.licence, tranche }); } catch (err) { setErreur(aboError(err).message); } finally { setBusy(false); } }
  const jours = new Map<string, { label: string; tranches: NonNullable<typeof creneaux> }>();
  for (const c of creneaux ?? []) { const key = cleJour(c.tranche_debut); if (!jours.has(key)) jours.set(key, { label: formatJour(c.tranche_debut), tranches: [] }); jours.get(key)!.tranches.push(c); }
  return <div className="abo-content"><h1>Réserver un test d'autonomie</h1>
    {active ? <section className="abo-carte"><h2>{active.prenom} {active.nom}</h2><p><strong>Votre RDV :</strong> {formatJour(active.tranche)}, {formatTranche(active.tranche, active.tranche_fin)}</p><button className="abo-link" type="button" disabled={busy} onClick={async () => { setBusy(true); try { await annuler({ reservationId: active.id }); } catch (err) { setErreur(aboError(err).message); } finally { setBusy(false); } }}>Annuler ce RDV</button></section> : <>
      <section className="abo-carte abo-verification-licence">
        <p>Indiquez le numéro de licence utilisé sur le site du club. L'adresse e-mail de connexion peut être celle du responsable familial.</p>
        <form onSubmit={(e) => { e.preventDefault(); void verifierLicence(); }}>
          <label className="abo-label">
            Numéro de licence
            <input value={licence} onChange={(e) => modifierLicence(e.target.value)} required />
          </label>
          <button className="abo-btn" type="submit" disabled={synchronisationEnCours}>
            {synchronisationEnCours ? "Mise à jour…" : "Vérifier ma situation"}
          </button>
        </form>
        {synchronisationEnCours && <p role="status">Mise à jour des inscriptions du club…</p>}
        {informationSynchronisation && <p className="abo-resa-information" role="status">{informationSynchronisation}</p>}
        {recherche && eligibility === undefined && <p role="status">Vérification…</p>}
        {eligibility && <p className="abo-resa-information" role="status">{eligibility.motif === "inscription_non_verifiable" && synchronisation?.statut === "skipped" ? `Les informations saisies n'ont pas permis de vérifier votre inscription. Une synchronisation a été effectuée récemment. Réessayez après ${formatRetryAt(synchronisation.retryAt)}.` : eligibility.message}</p>}
      </section>
      {eligibility?.autorisee && <section className="abo-carte"><h2>Choisir un créneau</h2>{jours.size === 0 ? <p>Aucun créneau disponible pour l'instant.</p> : [...jours.values()].map((jour) => <div key={jour.label} className="abo-resa-jour"><h3>{jour.label}</h3>{jour.tranches.map((t) => <button key={t.tranche_debut} className="abo-resa-tranche" type="button" disabled={busy} onClick={() => choisir(t.tranche_debut)}>{formatTranche(t.tranche_debut, t.tranche_fin)} — {t.disponible} place{t.disponible > 1 ? "s" : ""}</button>)}</div>)}</section>}
    </>}
    {erreur && <p className="abo-msg abo-msg-error" role="alert">{erreur}</p>}
  </div>;
}
