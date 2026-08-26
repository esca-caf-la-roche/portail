import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAction, useQuery } from "convex/react";
import {
  Check,
  Clipboard,
  Mail,
  MessageCircle,
  Search,
  Users,
} from "lucide-react";
import { api } from "../../convex/_generated/api";
import {
  calculerOptionsContactsCours,
  creerLienGmail,
  creerLienWhatsApp,
  doitCopierEmailsParLots,
  emailsUniques,
  estAppareilMobileWhatsApp,
  filtresContactsCoursEgaux,
  filtrerContactsCours,
  type FiltresContactsCours,
  normaliserAdresseEmailUnique,
  normaliserTelephoneWhatsApp,
  reconcilierFiltresContactsCours,
  separerEncadrants,
} from "../utils/contactsCours";

function errMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown })?.data;
  if (typeof data === "string" && data) return data;
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  const message = (err as { message?: unknown })?.message;
  return typeof message === "string" && message ? message : fallback;
}

function optionLabel(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function formatDate(value: string | number | null): string | null {
  if (value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

export default function ContactsCours() {
  const navigate = useNavigate();
  const data = useQuery(api.contactsCours.listContacts);
  const synchroniser = useAction(api.abo.sync.syncPourContactsCours);
  const syncLancee = useRef(false);
  const [syncStatut, setSyncStatut] = useState<"en_cours" | "ok" | "erreur">("en_cours");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [filtres, setFiltres] = useState<FiltresContactsCours>({
    recherche: "",
    cours: "",
    horaire: "",
    encadrant: "",
  });
  const [copie, setCopie] = useState<{ id: string; statut: "ok" | "erreur" } | null>(null);
  const [copieGroupe, setCopieGroupe] = useState<"ok" | "erreur" | null>(null);

  useEffect(() => {
    if (syncLancee.current) return;
    syncLancee.current = true;

    void synchroniser({})
      .then((resultat) => {
        if (resultat.eleves === "erreur") {
          setSyncStatut("erreur");
          setSyncMessage("La source externe n'a pas pu être actualisée.");
          return;
        }
        setSyncStatut("ok");
      })
      .catch((err: unknown) => {
        setSyncStatut("erreur");
        setSyncMessage(errMessage(err, "La source externe n'a pas pu être actualisée."));
      });
  }, [synchroniser]);

  const contacts = useMemo(() => data?.contacts ?? [], [data?.contacts]);

  useEffect(() => {
    let annule = false;
    queueMicrotask(() => {
      if (annule) return;
      setFiltres((precedents) => {
        const valides = reconcilierFiltresContactsCours(
          precedents,
          calculerOptionsContactsCours(contacts, precedents),
        );
        return filtresContactsCoursEgaux(precedents, valides)
          ? precedents
          : valides;
      });
    });
    return () => {
      annule = true;
    };
  }, [contacts]);

  const options = useMemo(
    () => calculerOptionsContactsCours(contacts, filtres),
    [contacts, filtres],
  );

  const contactsFiltres = useMemo(
    () => filtrerContactsCours(contacts, filtres),
    [contacts, filtres],
  );

  const appliquerFiltres = (modifications: Partial<FiltresContactsCours>) => {
    setFiltres((precedents) => {
      const suivants = { ...precedents, ...modifications };
      const valides = reconcilierFiltresContactsCours(
        suivants,
        calculerOptionsContactsCours(contacts, suivants),
      );
      return filtresContactsCoursEgaux(precedents, valides)
        ? precedents
        : valides;
    });
  };

  const groupe = useMemo(() => {
    const emails = emailsUniques(
      contactsFiltres.map((contact) =>
        normaliserAdresseEmailUnique(contact.email),
      ),
    );
    const sansEmail = contactsFiltres.filter(
      (contact) => !normaliserAdresseEmailUnique(contact.email),
    ).length;
    return { emails, sansEmail };
  }, [contactsFiltres]);

  const copierEmail = async (id: string, email: string) => {
    try {
      await navigator.clipboard.writeText(email);
      setCopie({ id, statut: "ok" });
    } catch {
      setCopie({ id, statut: "erreur" });
    }
    window.setTimeout(() => setCopie(null), 1800);
  };

  const ouvrirBrouillon = () => {
    if (groupe.emails.length === 0) return;
    window.open(
      creerLienGmail({ cci: groupe.emails }),
      "_blank",
      "noopener,noreferrer",
    );
  };

  const copierEmailsFiltres = async () => {
    if (groupe.emails.length === 0) return;

    if (doitCopierEmailsParLots(groupe.emails.length)) {
      navigate("/contacts-cours/copier", { state: { filtres } });
      return;
    }

    try {
      await navigator.clipboard.writeText(groupe.emails.join(", "));
      setCopieGroupe("ok");
    } catch {
      setCopieGroupe("erreur");
    }
    window.setTimeout(() => setCopieGroupe(null), 1800);
  };

  const dateFraicheur = formatDate(data?.lastSyncAt ?? null);
  const appareilMobileWhatsApp = estAppareilMobileWhatsApp(
    navigator.userAgent,
    navigator.maxTouchPoints,
  );

  return (
    <div className="contacts-cours-page">
      <header className="contacts-cours-header">
        <div className="contacts-cours-heading">
          <div>
            <p className="contacts-cours-kicker">Carnet de cours</p>
            <h1>Contacts élèves</h1>
            <p className="subtitle">
              Coordonnées des élèves inscrits aux cours, hors liste d’attente.
            </p>
          </div>
          <div className={`contacts-cours-sync contacts-cours-sync--${syncStatut}`} role="status">
            {syncStatut === "en_cours" && "Actualisation en cours…"}
            {syncStatut === "ok" && (
              <>
                Données actualisées
                {dateFraicheur ? <small>Dernière synchro : {dateFraicheur}</small> : null}
              </>
            )}
            {syncStatut === "erreur" && (
              <>
                Actualisation impossible
                <small>
                  {syncMessage} Les données affichées peuvent être obsolètes.
                  {dateFraicheur ? ` Dernière synchro réussie : ${dateFraicheur}.` : ""}
                </small>
              </>
            )}
          </div>
        </div>
      </header>

      <section className="contacts-cours-filters" aria-labelledby="contacts-filtres-title">
        <div className="contacts-cours-section-title">
          <h2 id="contacts-filtres-title">Trouver un groupe</h2>
          <span>
            {contactsFiltres.length} inscription{contactsFiltres.length > 1 ? "s" : ""}
          </span>
        </div>
        <div className="contacts-cours-filter-grid">
          <label className="contacts-cours-field contacts-cours-search">
            <span>Nom ou prénom</span>
            <span className="contacts-cours-input-icon">
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                value={filtres.recherche}
                onChange={(event) => appliquerFiltres({ recherche: event.target.value })}
                placeholder="Ex. Léa Martin"
              />
            </span>
          </label>
          <label className="contacts-cours-field">
            <span>Cours</span>
            <select
              value={filtres.cours}
              onChange={(event) => appliquerFiltres({ cours: event.target.value })}
            >
              <option value="">Tous les cours</option>
              {options.cours.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <label className="contacts-cours-field">
            <span>Horaire</span>
            <select
              value={filtres.horaire}
              onChange={(event) => appliquerFiltres({ horaire: event.target.value })}
            >
              <option value="">Tous les horaires</option>
              {options.horaires.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <label className="contacts-cours-field">
            <span>Encadrant</span>
            <select
              value={filtres.encadrant}
              onChange={(event) => appliquerFiltres({ encadrant: event.target.value })}
            >
              <option value="">Tous les encadrants</option>
              {options.encadrants.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
        </div>
      </section>

      <section className="contacts-cours-group" aria-labelledby="contacts-groupe-title">
        <div>
          <h2 id="contacts-groupe-title">
            <Mail size={20} aria-hidden="true" /> Écrire au groupe filtré
          </h2>
          <p>
            {groupe.emails.length} adresse{groupe.emails.length > 1 ? "s" : ""} unique{groupe.emails.length > 1 ? "s" : ""} en copie cachée
            {" · "}
            {groupe.sansEmail} inscription{groupe.sansEmail > 1 ? "s" : ""} sans email
          </p>
        </div>
        <div className="contacts-cours-group-actions">
          <button
            type="button"
            className="contacts-cours-action contacts-cours-action--copy"
            disabled={groupe.emails.length === 0}
            onClick={() => void copierEmailsFiltres()}
            aria-describedby="contacts-groupe-copie-aide"
          >
            {copieGroupe === "ok"
              ? <Check size={18} aria-hidden="true" />
              : <Clipboard size={18} aria-hidden="true" />}
            {copieGroupe === "ok"
              ? "Emails copiés"
              : copieGroupe === "erreur"
                ? "Échec de la copie"
                : doitCopierEmailsParLots(groupe.emails.length)
                  ? "Préparer les lots"
                  : "Copier les emails"}
          </button>
          <span id="contacts-groupe-copie-aide" className="sr-only" aria-live="polite">
            {doitCopierEmailsParLots(groupe.emails.length)
              ? "La sélection sera répartie en lots de 99 adresses."
              : copieGroupe === "ok"
                ? "Les adresses ont été copiées dans le presse-papiers."
                : copieGroupe === "erreur"
                  ? "La copie a échoué. Vérifiez l’autorisation du presse-papiers."
                  : "Les adresses seront copiées, séparées par des virgules."}
          </span>
          <button
            type="button"
            className="contacts-cours-action contacts-cours-action--mail"
            disabled={groupe.emails.length === 0}
            onClick={ouvrirBrouillon}
          >
            <Mail size={18} aria-hidden="true" />
            Ouvrir le brouillon
          </button>
        </div>
      </section>

      {data === undefined ? (
        <div className="contacts-cours-state" role="status">Chargement des contacts…</div>
      ) : contacts.length === 0 ? (
        <div className="contacts-cours-state">
          <Users size={36} aria-hidden="true" />
          <h2>Aucun élève en cours</h2>
          <p>La synchronisation ne contient actuellement aucun contact.</p>
        </div>
      ) : contactsFiltres.length === 0 ? (
        <div className="contacts-cours-state">
          <Search size={36} aria-hidden="true" />
          <h2>Aucun résultat</h2>
          <p>Modifiez la recherche ou l’un des filtres.</p>
        </div>
      ) : (
        <ul className="contacts-cours-list">
          {contactsFiltres.map((contact, index) => {
            const email = normaliserAdresseEmailUnique(contact.email);
            const telephone = contact.telephone;
            const whatsapp = normaliserTelephoneWhatsApp(telephone);
            const emailGestion = contact.emailSource === "gestion";
            const telephoneGestion = contact.telephoneSource === "gestion";
            const identifiant = `${contact.eleve_id ?? "sans-id"}-${index}`;
            const nomComplet =
              `${contact.nom ?? ""} ${contact.prenom ?? ""}`.trim() || "Élève sans nom";
            const encadrants = separerEncadrants(contact.encadrants);

            return (
              <li className="contacts-cours-card" key={identifiant}>
                <div className="contacts-cours-card-main">
                  <div className="contacts-cours-card-name">
                    <h3>{nomComplet}</h3>
                    {(emailGestion || telephoneGestion) && (
                      <span className="contacts-cours-fallback">Contact du dossier</span>
                    )}
                  </div>
                  <dl className="contacts-cours-course">
                    <div>
                      <dt>Cours</dt>
                      <dd>{optionLabel(contact.cours, "Non renseigné")}</dd>
                    </div>
                    <div>
                      <dt>Horaire</dt>
                      <dd>{optionLabel(contact.horaire, "Non renseigné")}</dd>
                    </div>
                    <div>
                      <dt>Encadrant{encadrants.length > 1 ? "s" : ""}</dt>
                      <dd>{encadrants.length > 0 ? encadrants.join(" · ") : "Non renseigné"}</dd>
                    </div>
                  </dl>
                </div>

                <div className="contacts-cours-details">
                  <div className="contacts-cours-contact-line">
                    <div>
                      <span>Email</span>
                      {email ? (
                        <a
                          href={creerLienGmail({ destinataire: email })}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {email}
                        </a>
                      ) : <strong>Non renseigné</strong>}
                      {emailGestion && <small>Coordonnée du gestionnaire du dossier</small>}
                    </div>
                    <button
                      type="button"
                      className="contacts-cours-icon-button"
                      disabled={!email}
                      onClick={() => email && void copierEmail(identifiant, email)}
                      aria-label={email ? `Copier l’email de ${nomComplet}` : `Aucun email pour ${nomComplet}`}
                    >
                      {copie?.id === identifiant && copie.statut === "ok"
                        ? <Check size={18} aria-hidden="true" />
                        : <Clipboard size={18} aria-hidden="true" />}
                      <span>{copie?.id === identifiant ? (copie.statut === "ok" ? "Copié" : "Échec") : "Copier"}</span>
                    </button>
                  </div>
                  <div className="contacts-cours-contact-line">
                    <div>
                      <span>Téléphone</span>
                      {telephone ? <a href={`tel:${telephone}`}>{telephone}</a> : <strong>Non renseigné</strong>}
                      {telephoneGestion && <small>Coordonnée du gestionnaire du dossier</small>}
                    </div>
                    <a
                      className={`contacts-cours-icon-button contacts-cours-whatsapp${whatsapp ? "" : " is-disabled"}`}
                      href={whatsapp ? creerLienWhatsApp(whatsapp, appareilMobileWhatsApp) : undefined}
                      target={whatsapp && !appareilMobileWhatsApp ? "_blank" : undefined}
                      rel={whatsapp && !appareilMobileWhatsApp ? "noreferrer" : undefined}
                      aria-disabled={!whatsapp}
                      tabIndex={whatsapp ? undefined : -1}
                      aria-label={whatsapp ? `Ouvrir WhatsApp pour ${nomComplet}` : `Aucun numéro WhatsApp pour ${nomComplet}`}
                      onClick={(event) => {
                        if (!whatsapp) event.preventDefault();
                      }}
                    >
                      <MessageCircle size={18} aria-hidden="true" />
                      <span>WhatsApp</span>
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
