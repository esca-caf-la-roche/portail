import { Component, type ErrorInfo, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { aboError } from "../lib/errors";
import { useMaintenantMinute } from "../lib/useMaintenantMinute";
import { formatJour, formatTranche } from "../lib/tests";
import { etatReservationApercu } from "./apercuAbonne.logic";
import "../abo.css";

type Apercu = NonNullable<ReturnType<typeof useQuery<typeof api.abo.apercu.get>>>;
type Personne = Apercu["dossier"]["personnes"][number];
type Check = Apercu["checks"][number];
type Reservation = Apercu["reservations"][number];

const STATUTS: Record<string, { label: string; classe: string; marque: string }> = {
  en_attente: { label: "En attente de traitement", classe: "waiting", marque: "" },
  validee: { label: "Validée", classe: "done", marque: "✓" },
  liste_attente: { label: "Liste d’attente", classe: "attente", marque: "!" },
  refusee: { label: "Refusée", classe: "rejected", marque: "✕" },
};

class ErreurApercu extends Component<{ children: ReactNode }, { erreur: string | null }> {
  state = { erreur: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { erreur: aboError(error).message };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Échec du chargement de l’aperçu abonné", error, info);
  }

  render() {
    if (this.state.erreur) {
      return (
        <EtatApercu titre="Aperçu indisponible" role="alert">
          <p>{this.state.erreur}</p>
        </EtatApercu>
      );
    }
    return this.props.children;
  }
}

export default function ApercuAbonne() {
  const { dossierId } = useParams();
  if (!dossierId) {
    return (
      <EtatApercu titre="Dossier introuvable" role="alert">
        <p>L’adresse de cet aperçu est incomplète.</p>
      </EtatApercu>
    );
  }
  return (
    <ErreurApercu key={dossierId}>
      <ContenuApercu dossierId={dossierId as Id<"abo_dossiers">} />
    </ErreurApercu>
  );
}

function EtatApercu({ titre, role = "status", children }: {
  titre: string;
  role?: "alert" | "status";
  children: ReactNode;
}) {
  return (
    <main className="abo-admin-preview abo-admin-preview-state" role={role}>
      <h1>{titre}</h1>
      {children}
      <Link className="abo-admin-button" to="/gestion-abonnements">Retour aux dossiers</Link>
    </main>
  );
}

function ContenuApercu({ dossierId }: { dossierId: Id<"abo_dossiers"> }) {
  const maintenantMs = useMaintenantMinute();
  const apercu = useQuery(api.abo.apercu.get, { dossierId, maintenantMs });
  if (apercu === undefined) {
    return <EtatApercu titre="Chargement de l’aperçu"><p>Lecture du dossier, des étapes et des messages…</p></EtatApercu>;
  }

  const checks = new Map(apercu.checks.map((check) => [String(check.personne_id), check]));
  const reservations = new Map(apercu.reservations.map((r) => [String(r.personne_id), r]));
  const suivis = new Map(apercu.suivisDisponibilites.map((s) => [s.cle, s.statut]));

  return (
    <main className="abo-admin-preview" aria-labelledby="apercu-titre">
      <aside className="abo-admin-preview-banner" role="status">
        <strong>Mode prévisualisation — lecture seule</strong>
        <span>{apercu.dossier.email}</span>
        <span>Aucune session abonné n’est créée et aucune notification n’est envoyée.</span>
      </aside>
      <header className="abo-admin-preview-header">
        <div>
          <p className="abo-admin-preview-kicker">Prévisualisation du suivi du dossier</p>
          <h1 id="apercu-titre">Suivi de ma demande</h1>
        </div>
        <Link className="abo-admin-button" to="/gestion-abonnements">Retour aux dossiers</Link>
      </header>

      {apercu.dossier.personnes.length === 0 ? (
        <p className="abo-admin-preview-empty">Ce dossier ne contient aucune personne.</p>
      ) : (
        <div className="abo-admin-preview-people">
          {apercu.dossier.personnes.map((personne) => (
            <PersonneApercu
              key={personne.id}
              personne={personne}
              check={checks.get(String(personne.id))}
              reservation={reservations.get(String(personne.id))}
              suiviDisponibilite={suivis.get(`dossier:${personne.id}`)}
              liens={apercu.liens}
            />
          ))}
        </div>
      )}

      {apercu.dossier.personnes.some((p) => p.etape_validation === "validee") && (
        <aside className="abo-admin-preview-note" role="note">
          <strong>Un peu de patience 🙏</strong>
          <p>Certaines validations sont saisies à la main par des bénévoles : un délai est normal.</p>
        </aside>
      )}

      <section className="abo-admin-preview-account-actions" aria-labelledby="apercu-parcours-compte">
        <h2 id="apercu-parcours-compte">Autres parcours de l’espace abonné</h2>
        <p>Ils sont signalés pour le contrôle fonctionnel, mais cet aperçu reste centré sur le suivi du dossier.</p>
        <div className="abo-admin-preview-actions">
          {apercu.vague >= 2 && <ActionBloquee label="Ajouter une personne" />}
          <ActionBloquee label="Réserver pour une autre licence déjà inscrite au club" />
        </div>
      </section>

      <section className="abo-admin-preview-messages" aria-labelledby="apercu-messages-titre">
        <h2 id="apercu-messages-titre">Échanger avec la commission escalade</h2>
        <p>Une question sur votre demande ? Écrivez-nous ici : les bénévoles vous répondront.</p>
        <FilLectureSeule messages={apercu.messages} tronque={apercu.messagesTronques} />
      </section>
    </main>
  );
}

function PersonneApercu({ personne, check, reservation, suiviDisponibilite, liens }: {
  personne: Personne;
  check?: Check;
  reservation?: Reservation;
  suiviDisponibilite?: string;
  liens: Apercu["liens"];
}) {
  const statut = STATUTS[personne.etape_validation] ?? STATUTS.en_attente;
  if (personne.etape_validation !== "validee") {
    return (
      <section className="abo-admin-preview-card">
        <h2>{personne.prenom} {personne.nom}</h2>
        <p className={`abo-admin-preview-status abo-admin-preview-status--${statut.classe}`}>
          <span aria-hidden="true">{statut.marque}</span> {statut.label}
        </p>
        <ActionBloquee label="Retirer cette personne" />
      </section>
    );
  }

  const c = check ?? { licence_ok: false, inscription_ok: false, reglement_signe: false, paiement_ok: false, test_autonomie: null, age: personne.age };
  const afficheTest = Boolean(reservation) || !(c.test_autonomie === "non_requis" || (c.age != null && c.age < 16));
  const etapes = [
    { titre: "Licence CAF (obligatoire)", fait: c.licence_ok, attente: false, texte: "Adhérer au CAF La Roche Bonneville en ligne.", actions: [{ label: "Nouvelle adhésion", disponible: Boolean(liens.licence_nouvelle) }, { label: "Renouvellement", disponible: Boolean(liens.licence_renouvellement) }] },
    { titre: "Attente de la synchronisation (≈ 24 h)", fait: c.licence_ok || c.inscription_ok, attente: true, texte: "La synchronisation avec la fédération se fait une fois par jour. Cette étape se valide automatiquement.", actions: [] },
    { titre: "Inscription en ligne", fait: c.inscription_ok, attente: false, texte: "Activer son compte puis faire la demande officielle d’abonnement sur le site du club.", actions: [{ label: "Activer mon compte", disponible: Boolean(liens.compte_activation) }, { label: "Faire ma demande d’abonnement", disponible: Boolean(liens.inscription) }] },
    { titre: "Lire et signer le règlement intérieur", fait: c.reglement_signe, attente: false, texte: "Consultez le règlement puis signez-le en ligne sur DocuSeal.", actions: [{ label: "Lire et signer sur DocuSeal", disponible: Boolean(liens.reglement) }] },
    { titre: "Paiement", fait: c.paiement_ok, attente: false, texte: "Effectuer le règlement par carte bancaire.", actions: [{ label: "Payer en ligne via HelloAsso", disponible: Boolean(liens.helloasso) }] },
    ...(afficheTest ? [{ titre: "Test d’autonomie (16 ans et plus)", fait: c.test_autonomie === "valide", attente: false, texte: "Lieu : gymnase de St Pierre en Faucigny.", actions: [{ label: "Télécharger le formulaire pré-rempli", disponible: true }, { label: "Formulaire vierge", disponible: Boolean(liens.test_autonomie) }] }] : []),
  ];

  return (
    <section className="abo-admin-preview-card">
      <h2>{personne.prenom} {personne.nom}</h2>
      <p className="abo-admin-preview-status abo-admin-preview-status--done"><span aria-hidden="true">✓</span> Validée</p>
      <p>Votre demande est <strong>acceptée</strong> 🎉 Voici les étapes pour finaliser votre inscription.</p>
      <ol className="abo-admin-preview-steps">
        {etapes.map((etape, index) => (
          <li key={etape.titre} className={`abo-admin-preview-step${etape.fait ? " is-done" : ""}`}>
            <span className="abo-admin-preview-step-number" aria-hidden="true">{etape.fait ? "✓" : index + 1}</span>
            <div>
              <div className="abo-admin-preview-step-head">
                <strong>{etape.titre}</strong>
                <span>{etape.fait ? "Fait" : etape.attente ? "En attente" : "À faire"}</span>
              </div>
              <p>{etape.texte}</p>
              {etape.actions.length > 0 && <div className="abo-admin-preview-actions" aria-label="Actions désactivées dans l’aperçu">
                {etape.actions.map((action) => (
                  <ActionBloquee
                    key={action.label}
                    label={`${action.label}${action.disponible ? "" : " (lien à venir)"}`}
                    compact
                  />
                ))}
              </div>}
              {index === etapes.length - 1 && afficheTest && (
                <ReservationApercu
                  reservation={reservation}
                  suiviDisponibilite={suiviDisponibilite}
                  testAutonomie={c.test_autonomie}
                  age={c.age}
                />
              )}
            </div>
          </li>
        ))}
      </ol>
      <ActionBloquee label="Retirer cette personne" />
    </section>
  );
}

function ReservationApercu({ reservation, suiviDisponibilite, testAutonomie, age }: {
  reservation?: Reservation;
  suiviDisponibilite?: string;
  testAutonomie: string | null;
  age: number | null;
}) {
  const active = reservation?.active;
  const annulee = reservation?.annulee;
  const etat = etatReservationApercu({
    testAutonomie,
    age,
    reservationActive: Boolean(active),
  });
  if (etat === "reservation_active" && active) {
    return <div className="abo-admin-preview-reservation">
      <p><strong>Votre RDV :</strong> {formatJour(active.tranche)}, {formatTranche(active.tranche, active.tranche_fin)}</p>
      <p><strong>{active.etat_confirmation === "confirmee" ? "RDV confirmé" : "RDV provisoire"}</strong></p>
      <ActionBloquee label="Annuler ce RDV" compact />
    </div>;
  }
  return <div className="abo-admin-preview-reservation">
    {annulee && <p>Votre précédent RDV a été annulé{annulee.annulee_raison === "conditions_test_non_remplies" ? " après vérification des conditions" : ""}.</p>}
    {suiviDisponibilite === "en_attente" && <p><strong>Alerte disponibilité activée.</strong></p>}
    {etat === "peut_reserver" ? (
      <ActionBloquee label="Réserver un créneau de test" compact />
    ) : (
      <p className="abo-admin-preview-unavailable" role="status">
        Le test n’est pas accessible pour cette personne. Sa situation sera mise à jour automatiquement après vérification.
      </p>
    )}
  </div>;
}

function ActionBloquee({ label, compact = false }: { label: string; compact?: boolean }) {
  return <span className={compact ? "abo-admin-preview-disabled is-compact" : "abo-admin-preview-disabled"} title="Désactivé dans l’aperçu en lecture seule">
    {label} <span aria-hidden="true">🔒</span><span className="abo-admin-visually-hidden"> — désactivé dans l’aperçu en lecture seule</span>
  </span>;
}

function FilLectureSeule({ messages, tronque }: { messages: Apercu["messages"]; tronque: boolean }) {
  return <div className="abo-admin-preview-thread">
    {tronque && <p className="abo-admin-preview-truncated" role="status">Seuls les 200 messages les plus récents sont affichés.</p>}
    <div className="abo-admin-preview-message-list">
      {messages.length === 0 ? <p className="abo-admin-preview-empty">Aucun message.</p> : messages.map((message) => (
        <article key={message.id} className={`abo-admin-preview-message${message.est_moi ? " is-me" : ""}`}>
          <small>{message.auteur_role === "admin" ? "Commission escalade" : "Abonné·e"} · {new Date(message.created_at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</small>
          <p>{message.contenu}</p>
        </article>
      ))}
    </div>
    <div className="abo-admin-preview-compose">
      <textarea aria-label="Votre message" rows={2} disabled placeholder="Votre message…" />
      <button type="button" disabled>Envoyer</button>
    </div>
    <p className="abo-admin-preview-readonly-help">La messagerie est désactivée et les messages ne sont pas marqués comme lus dans cet aperçu.</p>
  </div>;
}
