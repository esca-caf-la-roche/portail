import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { aboError } from "../lib/errors";
import { useMaintenantMinute } from "../lib/useMaintenantMinute";
import { cleJour, formatJour, formatTranche } from "../lib/tests";
import FilDiscussion from "../FilDiscussion";
import N1RedirectModal from "../N1RedirectModal";
import NotificationDisponibilitesTest from "../NotificationDisponibilitesTest";

// Tableau de suivi (abonné, lecture seule pour l'essentiel).
// Le rendu d'une personne dépend de sa décision admin (etape_validation) :
//   - non acceptée → carte « nom + statut » seulement ;
//   - acceptée (validee) → étapes CONCRÈTES à réaliser (licence, attente, inscription,
//     règlement, paiement, test d'autonomie), avec liens d'action et état LIVE (mon_suivi).
// L'abonné peut compléter (ajouter une personne) et retirer des personnes.
// L'étape 6 (test d'autonomie, 16 ans et plus) embarque la prise de RDV :
// créneaux disponibles, réservation, annulation, et bandeau si le RDV a été
// délogé par surbooking (cf. ReservationTest / ModalReservation).

type PersonneVue = NonNullable<
  ReturnType<typeof useQuery<typeof api.abo.demandes.getMonDossier>>
>["personnes"][number];

type DossierVue = NonNullable<
  ReturnType<typeof useQuery<typeof api.abo.demandes.getMonDossier>>
>;

type ReservationPersonne = NonNullable<
  ReturnType<typeof useQuery<typeof api.abo.tests.getMesReservationsParPersonne>>
>[number];

type Check = {
  licence_ok: boolean;
  inscription_ok: boolean;
  reglement_signe: boolean;
  paiement_ok: boolean;
  test_autonomie: string | null;
  age: number | null;
};

const formatOk = (l: string) => [12, 14].includes(l.replace(/\D/g, "").length);

export default function Suivi({ dossier }: { dossier: DossierVue }) {
  const maintenantMs = useMaintenantMinute();
  const cfg = useQuery(api.abo.config.vaguesConfig, { maintenantMs });
  const liens = useQuery(api.abo.config.liensFinalisation);
  const checks = useQuery(api.abo.demandes.monSuivi);
  const reservations = useQuery(api.abo.tests.getMesReservationsParPersonne);
  const ajouterPersonne = useAction(api.abo.demandes.ajouterPersonne);
  const supprimerPersonne = useMutation(api.abo.demandes.supprimerPersonne);

  const vague = cfg?.vague ?? 0;
  const vague2 = vague === 2;
  const personnes = dossier.personnes ?? [];
  const aDesEtapes = personnes.some((p) => p.etape_validation === "validee");

  const checksById = new Map(
    (checks ?? []).map((c) => [c.personne_id as string, c]),
  );
  const reservById = new Map(
    (reservations ?? []).map((r) => [r.personne_id as string, r]),
  );

  async function retirer(p: PersonneVue) {
    const nom = `${p.prenom} ${p.nom}`.trim();
    const derniere = personnes.length <= 1;
    const question = derniere
      ? `Retirer ${nom} ? C'est la dernière personne : votre demande sera supprimée (un historique est conservé, vous pourrez en refaire une).`
      : `Retirer ${nom} de votre demande ? Un historique est conservé.`;
    if (!window.confirm(question)) return;
    try {
      await supprimerPersonne({ personneId: p.id as Id<"abo_personnes"> });
      // getMonDossier réactif : la personne disparaît, ou l'espace revient au
      // formulaire de demande si le dossier a été supprimé.
    } catch (err) {
      window.alert(`Échec : ${aboError(err).message}`);
    }
  }

  return (
    <div className="abo-content">
      <h1>Suivi de ma demande</h1>
      <div className="abo-suivi">
        {personnes.map((p) => (
          <PersonneBloc
            key={p.id}
            personne={p}
            seule={personnes.length <= 1}
            liens={liens}
            check={checksById.get(p.id as string)}
            reservation={reservById.get(p.id as string)}
            onRetirer={() => retirer(p)}
          />
        ))}
      </div>

      {aDesEtapes && <DisclaimerBenevoles />}

      {vague >= 2 && (
        <AjoutPersonne
          vague2={vague2}
          inscriptionUrl={liens?.inscription}
          onAjouter={ajouterPersonne}
        />
      )}

      <section className="abo-messagerie" style={{ marginTop: "2rem" }}>
        <h2>Échanger avec la commission escalade</h2>
        <p style={{ fontSize: "0.9rem", color: "#555" }}>
          Une question sur votre demande ? Écrivez-nous ici : les bénévoles vous
          répondront et vous serez prévenu·e par email.
        </p>
        <FilDiscussion dossierId={dossier.id as Id<"abo_dossiers">} />
      </section>
    </div>
  );
}

// ── Carte d'une personne (statut seul, ou étapes de finalisation) ────
function PersonneBloc({
  personne,
  seule,
  liens,
  check,
  reservation,
  onRetirer,
}: {
  personne: PersonneVue;
  seule: boolean;
  liens: ReturnType<typeof useQuery<typeof api.abo.config.liensFinalisation>>;
  check?: Check;
  reservation?: ReservationPersonne;
  onRetirer: () => void;
}) {
  return (
    <div className="abo-suivi-personne">
      {personne.etape_validation === "validee" ? (
        <CarteFinalisation
          personne={personne}
          liens={liens}
          check={check}
          reservation={reservation}
        />
      ) : (
        <CarteStatut personne={personne} />
      )}
      <button type="button" className="abo-link" onClick={onRetirer}>
        ✕ Retirer cette personne{seule ? " (supprime la demande)" : ""}
      </button>
    </div>
  );
}

const STATUT_DEMANDE: Record<string, { cls: string; label: string; mark: string }> = {
  en_attente: { cls: "waiting", label: "En attente de traitement", mark: "" },
  validee: { cls: "done", label: "Validée", mark: "✓" },
  liste_attente: { cls: "attente", label: "Liste d'attente", mark: "!" },
  refusee: { cls: "rejected", label: "Refusée", mark: "✕" },
};

function CarteStatut({ personne }: { personne: PersonneVue }) {
  const s = STATUT_DEMANDE[personne.etape_validation] ?? STATUT_DEMANDE.en_attente;
  return (
    <section className="abo-carte">
      <h2>
        {personne.prenom} {personne.nom}
      </h2>
      <p className={`abo-statut-badge abo-statut-badge--${s.cls}`}>
        <span aria-hidden="true">{s.mark}</span> {s.label}
      </p>
    </section>
  );
}

// ── Étapes de finalisation (demande acceptée) ────────────────────────
interface Etape {
  num: number;
  titre: string;
  etat: "done" | "todo";
  etatLabel: string;
  corps: React.ReactNode;
}

function CarteFinalisation({
  personne,
  liens,
  check,
  reservation,
}: {
  personne: PersonneVue;
  liens: ReturnType<typeof useQuery<typeof api.abo.config.liensFinalisation>>;
  check?: Check;
  reservation?: ReservationPersonne;
}) {
  const c = check ?? {
    licence_ok: false,
    inscription_ok: false,
    reglement_signe: false,
    paiement_ok: false,
    test_autonomie: null,
    age: personne.age,
  };
  const peutAfficherTest = Boolean(reservation) ||
    !(c.test_autonomie === "non_requis" || (c.age != null && c.age < 16));
  const peutReserverTest =
    c.test_autonomie !== "non_requis" &&
    c.test_autonomie !== "valide" &&
    !(c.age != null && c.age < 16);
  const suitCoursEscalade = personne.vague_depot === "vague_2";
  const etapes = construireEtapes(
    c,
    liens,
    personne,
    peutAfficherTest,
    suitCoursEscalade && peutReserverTest,
    <ReservationTest
      personneId={personne.id as Id<"abo_personnes">}
      reservation={reservation}
      peutReserver={peutReserverTest}
      suitCoursEscalade={suitCoursEscalade && peutReserverTest}
    />,
  );
  return (
    <section className="abo-carte">
      <h2>
        {personne.prenom} {personne.nom}
      </h2>
      <p className="abo-statut-badge abo-statut-badge--done">
        <span aria-hidden="true">✓</span> Validée
      </p>
      <p className="abo-final-intro">
        Votre demande est <strong>acceptée</strong> 🎉 Voici les étapes pour
        finaliser votre inscription. L'état se met à jour automatiquement.
      </p>
      <ol className="abo-finalisation">
        {etapes.map((e) => (
          <li key={e.num} className={`abo-fstep abo-fstep--${e.etat}`}>
            <span className="abo-fstep-num" aria-hidden="true">
              {e.etat === "done" ? "✓" : e.num}
            </span>
            <div className="abo-fstep-body">
              <div className="abo-fstep-head">
                <span className="abo-fstep-title">{e.titre}</span>
                <span className={`abo-fstep-state abo-fstep-state--${e.etat}`}>
                  {e.etatLabel}
                </span>
              </div>
              {e.corps}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Liens = ReturnType<
  typeof useQuery<typeof api.abo.config.liensFinalisation>
>;

function lienAction(url: string | null | undefined, label: string) {
  return url ? (
    <a
      className="abo-fstep-lien"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {label}
    </a>
  ) : (
    <span className="abo-fstep-lien abo-fstep-lien--vide">{label} (lien à venir)</span>
  );
}

const etatBool = (v: boolean): { etat: "done" | "todo"; etatLabel: string } =>
  v ? { etat: "done", etatLabel: "Fait" } : { etat: "todo", etatLabel: "À faire" };

function construireEtapes(
  c: Check,
  liens: Liens,
  personne: PersonneVue,
  peutAfficherTest: boolean,
  suitCoursEscalade: boolean,
  reservationWidget: React.ReactNode,
): Etape[] {
  const etapes: Etape[] = [
    {
      num: 1,
      titre: "Licence CAF (obligatoire)",
      ...etatBool(c.licence_ok),
      corps: (
        <>
          <p>Adhérer au CAF La Roche Bonneville en ligne.</p>
          <p className="abo-fstep-liens">
            {lienAction(liens?.licence_nouvelle, "Nouvelle adhésion")}{" "}
            {lienAction(liens?.licence_renouvellement, "Renouvellement")}
          </p>
        </>
      ),
    },
    {
      num: 2,
      titre: "Attente de la synchronisation (≈ 24 h)",
      etat: c.licence_ok || c.inscription_ok ? "done" : "todo",
      etatLabel: c.licence_ok || c.inscription_ok ? "Fait" : "En attente",
      corps: (
        <p>
          La synchronisation entre la fédération (FFCAM) et notre site se fait{" "}
          <strong>une fois par jour</strong> : comptez environ 24 h avant de
          pouvoir vous inscrire en ligne. Cette étape se valide automatiquement.
        </p>
      ),
    },
    {
      num: 3,
      titre: "Inscription en ligne",
      ...etatBool(c.inscription_ok),
      corps: (
        <>
          <p>
            1. Activer son compte avec son numéro de licence et une adresse e-mail.
          </p>
          <p className="abo-fstep-liens">
            {lienAction(liens?.compte_activation, "Activer mon compte")}
          </p>
          <p>2. Faire la demande officielle d'abonnement sur le site du club.</p>
          <p className="abo-fstep-liens">
            {lienAction(liens?.inscription, "Faire ma demande d'abonnement")}
          </p>
        </>
      ),
    },
    {
      num: 4,
      titre: "Lire et signer le règlement intérieur",
      ...etatBool(c.reglement_signe),
      corps: (
        <>
          <p>
            Consultez le règlement intérieur puis signez-le en ligne sur DocuSeal.
            La confirmation est vérifiée par un membre du staff et peut prendre un peu de temps.
          </p>
          <p className="abo-fstep-liens">
            {lienAction(liens?.reglement, "Lire et signer sur DocuSeal")}
          </p>
        </>
      ),
    },
    {
      num: 5,
      titre: "Paiement",
      ...etatBool(c.paiement_ok),
      corps: (
        <>
          <p>Effectuer le règlement par carte bancaire.</p>
          <p className="abo-fstep-liens">
            {lienAction(liens?.helloasso, "Payer en ligne via HelloAsso")}
          </p>
        </>
      ),
    },
  ];

  // Étape 6 — test d'autonomie (16 ans et plus). Masquée si non requis ou < 16 ans.
  if (peutAfficherTest) {
    const fait = c.test_autonomie === "valide";
    etapes.push({
      num: 6,
      titre: "Test d'autonomie (16 ans et plus)",
      etat: fait ? "done" : "todo",
      etatLabel: fait ? "Validé" : "À faire",
      corps: (
        <>
          {suitCoursEscalade ? (
            <p className="abo-resa-information">
              Vous suivez un cours d'escalade : imprimez le formulaire puis
              faites-le valider par votre moniteur pendant votre cours habituel.
              Vous n'avez pas besoin de réserver un créneau de test.
            </p>
          ) : (
            <p>
              <strong>Où :</strong> gymnase de St Pierre en Faucigny.
            </p>
          )}
          <p className="abo-fstep-liens">
            <TelechargerFormulaireTest
              personne={personne}
              impressionRequise={suitCoursEscalade}
            />
            {liens?.test_autonomie && (
              <>
                {" "}
                {lienAction(liens.test_autonomie, "Formulaire vierge")}
              </>
            )}
          </p>
          {reservationWidget}
        </>
      ),
    });
  }

  return etapes;
}

function TelechargerFormulaireTest({
  personne,
  impressionRequise,
}: {
  personne: PersonneVue;
  impressionRequise: boolean;
}) {
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function telecharger() {
    setEnCours(true);
    setErreur(null);
    try {
      const { creerFormulaireTestAutonomie, telechargerPdf } = await import(
        "../lib/testAutonomiePdf"
      );
      const pdf = await creerFormulaireTestAutonomie({
        nom: personne.nom,
        prenom: personne.prenom,
        licence: personne.licence,
      });
      telechargerPdf(pdf, "test-autonomie.pdf");
    } catch (err) {
      setErreur(err instanceof Error ? err.message : "Le téléchargement a échoué.");
    } finally {
      setEnCours(false);
    }
  }

  return (
    <span>
      <button
        type="button"
        className={
          impressionRequise
            ? "abo-btn"
            : "abo-fstep-lien abo-fstep-lien--button"
        }
        onClick={telecharger}
        disabled={enCours}
      >
        {enCours
          ? "Préparation du formulaire…"
          : impressionRequise
            ? "Télécharger et imprimer le formulaire pré-rempli"
            : "Télécharger le formulaire pré-rempli"}
      </button>
      {erreur && <span className="abo-pdf-erreur" role="alert">{erreur}</span>}
    </span>
  );
}

// ── Réservation du test d'autonomie (étape 6) ────────────────────────
// Affiche la réservation active (avec annulation), un bandeau si le RDV a été
// délogé par surbooking, et un bouton ouvrant la liste des créneaux disponibles.
function ReservationTest({
  personneId,
  reservation,
  peutReserver,
  suitCoursEscalade,
}: {
  personneId: Id<"abo_personnes">;
  reservation?: ReservationPersonne;
  peutReserver: boolean;
  suitCoursEscalade: boolean;
}) {
  const annuler = useMutation(api.abo.tests.annulerMaReservation);
  const [ouvert, setOuvert] = useState(false);
  const [busy, setBusy] = useState(false);

  const active = reservation?.active ?? null;
  const annulee = reservation?.annulee ?? null;
  // Les anciennes réservations actives n'avaient pas ce champ : elles restent
  // affichées comme provisoires jusqu'à leur prochaine vérification.
  const estConfirmee =
    (active as (typeof active & { etat_confirmation?: "provisoire" | "confirmee" }) | null)
      ?.etat_confirmation === "confirmee";

  async function annulerRdv() {
    if (!window.confirm("Annuler votre réservation de test ?")) return;
    setBusy(true);
    try {
      await annuler({ personneId });
    } catch (err) {
      window.alert(`Échec : ${aboError(err).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="abo-resa">
      {active ? (
        <div className="abo-resa-active">
          <p>
            <strong>Votre RDV :</strong> {formatJour(active.tranche)},{" "}
            {formatTranche(active.tranche, active.tranche_fin)}
          </p>
          <p
            className={`abo-resa-confirmation abo-resa-confirmation--${
              estConfirmee ? "confirmee" : "provisoire"
            }`}
            role="status"
          >
            <strong>{estConfirmee ? "RDV confirmé" : "RDV provisoire"}</strong>
            {estConfirmee
              ? " : vos conditions de test sont validées."
              : " : votre place est réservée. Nous vérifierons vos conditions de test via votre licence avant le rendez-vous."}
          </p>
          <button
            type="button"
            className="abo-link"
            onClick={annulerRdv}
            disabled={busy}
          >
            Annuler ce RDV
          </button>
        </div>
      ) : suitCoursEscalade ? null : (
        <>
          {annulee && <AnnulationReservation reservation={annulee} />}
          {peutReserver ? (
            <button
              type="button"
              className="abo-btn abo-resa-ouvrir"
              onClick={() => setOuvert(true)}
            >
              Réserver un créneau de test
            </button>
          ) : (
            <p className="abo-resa-information" role="status">
              Le test n'est pas accessible pour cette personne. Sa situation sera
              mise à jour automatiquement après vérification.
            </p>
          )}
        </>
      )}

      {ouvert && peutReserver && !suitCoursEscalade && (
        <ModalReservation
          personneId={personneId}
          onFermer={() => setOuvert(false)}
        />
      )}
    </div>
  );
}

function AnnulationReservation({
  reservation,
}: {
  reservation: NonNullable<ReservationPersonne["annulee"]>;
}) {
  if (
    (reservation as typeof reservation & {
      annulee_raison?: "conditions_test_non_remplies";
    }).annulee_raison === "conditions_test_non_remplies"
  ) {
    return (
      <p className="abo-resa-annulee" role="status">
        Votre précédent RDV a été annulé après vérification : le test n'est
        finalement pas requis, est déjà validé, ou n'est pas accessible pour cette personne.
      </p>
    );
  }

  return (
    <p className="abo-resa-annulee" role="status">
      Votre précédent RDV a été annulé. Merci d'en choisir un nouveau.
    </p>
  );
}

function ModalReservation({
  personneId,
  onFermer,
}: {
  personneId: Id<"abo_personnes">;
  onFermer: () => void;
}) {
  const dispos = useQuery(api.abo.tests.testCreneauxDisponibles);
  const reserver = useMutation(api.abo.tests.reserverTest);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function choisir(tranche: string) {
    setBusy(true);
    setMsg(null);
    try {
      await reserver({ personneId, tranche });
      onFermer(); // la réservation apparaît (getMesReservationsParPersonne réactif)
    } catch (err) {
      setMsg(aboError(err).message);
      setBusy(false);
    }
  }

  // Regroupe les tranches disponibles par jour (Europe/Paris).
  const jours = new Map<
    string,
    { label: string; tranches: NonNullable<typeof dispos> }
  >();
  for (const t of dispos ?? []) {
    const k = cleJour(t.tranche_debut);
    if (!jours.has(k)) jours.set(k, { label: formatJour(t.tranche_debut), tranches: [] });
    jours.get(k)!.tranches.push(t);
  }

  return (
    <div className="abo-modal-fond" role="dialog" aria-modal="true" onClick={onFermer}>
      <div className="abo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="abo-modal-head">
          <h3>Choisir un créneau de test</h3>
          <button type="button" className="abo-retirer" onClick={onFermer}>
            ✕
          </button>
        </div>

        {dispos === undefined ? (
          <p>Chargement…</p>
        ) : jours.size === 0 ? (
          <div className="abo-placeholder">
            <p>Aucun créneau disponible pour l'instant.</p>
            <NotificationDisponibilitesTest cible={{ type: "dossier", personneId }} />
          </div>
        ) : (
          <><div className="abo-resa-jours">
            {[...jours.values()].map((j) => (
              <div key={j.label} className="abo-resa-jour">
                <h4>{j.label}</h4>
                <div className="abo-resa-tranches">
                  {j.tranches.map((t) => (
                    <button
                      key={t.tranche_debut}
                      type="button"
                      className="abo-resa-tranche"
                      disabled={busy}
                      onClick={() => choisir(t.tranche_debut)}
                    >
                      <span>{formatTranche(t.tranche_debut, t.tranche_fin)}</span>
                      <span className="abo-resa-places">
                        {t.disponible} place{t.disponible > 1 ? "s" : ""}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div><NotificationDisponibilitesTest masquerSiInactif cible={{ type: "dossier", personneId }} /></>
        )}

        {msg && (
          <p className="abo-msg abo-msg-error" role="status">
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}

function DisclaimerBenevoles() {
  return (
    <aside className="abo-note" role="note">
      <p>
        <strong>Un peu de patience 🙏</strong>
      </p>
      <p>
        Certaines validations sont saisies{" "}
        <strong>à la main par des bénévoles</strong>, sur leur temps libre, en
        dehors de leurs heures de travail. Un délai est donc normal. Sont
        concernés :
      </p>
      <ul>
        <li>
          la confirmation du <strong>règlement intérieur signé</strong> ;
        </li>
        <li>
          l'enregistrement du <strong>paiement</strong> ;
        </li>
        <li>
          l'enregistrement du <strong>test d'autonomie</strong>.
        </li>
      </ul>
    </aside>
  );
}

// ── Ajout d'une personne au dossier ──────────────────────────────────
function AjoutPersonne({
  vague2,
  inscriptionUrl,
  onAjouter,
}: {
  vague2: boolean;
  inscriptionUrl?: string | null;
  onAjouter: ReturnType<typeof useAction<typeof api.abo.demandes.ajouterPersonne>>;
}) {
  const [nom, setNom] = useState("");
  const [prenom, setPrenom] = useState("");
  const [licence, setLicence] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [redirectionN1, setRedirectionN1] = useState<string | null>(null);

  async function soumettre(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (vague2) {
      if (!licence.trim()) return setMsg("Renseignez le n° de licence.");
      if (!formatOk(licence))
        return setMsg("Numéro de licence invalide : 12 chiffres attendus.");
    } else {
      if (!nom.trim() || !prenom.trim())
        return setMsg("Renseignez le nom ET le prénom.");
      if (licence.trim() && !formatOk(licence))
        return setMsg("Numéro de licence invalide : 12 chiffres attendus.");
    }
    setBusy(true);
    try {
      await onAjouter(
        vague2
          ? { licence: licence.trim() }
          : {
              nom: nom.trim(),
              prenom: prenom.trim(),
              licence: licence.trim() || undefined,
            },
      );
      setNom("");
      setPrenom("");
      setLicence("");
      setMsg(null);
    } catch (err) {
      const erreur = aboError(err);
      if (erreur.code === "ABO_N1_REDIRECTION") setRedirectionN1(erreur.message);
      else setMsg(erreur.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="abo-ajout">
      <h2>Ajouter une personne</h2>
      {vague2 ? (
        <p className="abo-vague-info">
          Réservé aux élèves en cours d'escalade : saisissez le{" "}
          <strong>n° de licence</strong> — l'identité est reconnue automatiquement.
        </p>
      ) : (
        <p className="abo-vague-info">
          Renseignez le nom et le prénom (n° de licence facultatif).
        </p>
      )}
      <form onSubmit={soumettre} className="abo-ajout-form">
        {!vague2 && (
          <>
            <input
              className="abo-input"
              type="text"
              placeholder="Nom"
              value={nom}
              onChange={(e) => setNom(e.target.value)}
            />
            <input
              className="abo-input"
              type="text"
              placeholder="Prénom"
              value={prenom}
              onChange={(e) => setPrenom(e.target.value)}
            />
          </>
        )}
        <input
          className="abo-input"
          type="text"
          inputMode="numeric"
          placeholder={vague2 ? "N° de licence" : "N° de licence (facultatif)"}
          value={licence}
          onChange={(e) => setLicence(e.target.value)}
        />
        <button type="submit" className="abo-btn" disabled={busy}>
          {busy ? "Ajout…" : "Ajouter"}
        </button>
      </form>
      {msg && (
        <p className="abo-msg abo-msg-error" role="status">
          {msg}
        </p>
      )}
      {redirectionN1 && (
        <N1RedirectModal
          message={redirectionN1}
          inscriptionUrl={inscriptionUrl}
          onClose={() => setRedirectionN1(null)}
        />
      )}
    </section>
  );
}
