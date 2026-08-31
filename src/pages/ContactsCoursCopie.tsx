import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { ArrowLeft, Check, Clipboard, MailWarning } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import {
  creerEmpreinteEmails,
  decouperEmailsEnLots,
  emailsUniques,
  filtrerContactsCours,
  normaliserHorairesFiltres,
  normaliserAdresseEmailUnique,
  type FiltresContactsCours,
} from "../utils/contactsCours";

const CLE_PROGRESSION = "contacts-cours-copie-lots-v1";

interface ProgressionCopie {
  empreinte: string;
  lotsCopies: number[];
}

function lireFiltresNavigation(state: unknown): FiltresContactsCours | null {
  if (!state || typeof state !== "object" || !("filtres" in state)) return null;
  const filtres = (state as { filtres?: unknown }).filtres;
  if (!filtres || typeof filtres !== "object") return null;
  const candidat = filtres as Partial<Record<keyof FiltresContactsCours, unknown>>;
  const horaires = normaliserHorairesFiltres(candidat.horaires);

  if (
    typeof candidat.recherche !== "string" ||
    typeof candidat.cours !== "string" ||
    horaires === null ||
    typeof candidat.encadrant !== "string"
  ) {
    return null;
  }

  return {
    recherche: candidat.recherche,
    cours: candidat.cours,
    horaires,
    encadrant: candidat.encadrant,
  };
}

function lireProgression(empreinte: string, nombreLots: number): ProgressionCopie {
  try {
    const brut = sessionStorage.getItem(CLE_PROGRESSION);
    if (!brut) return { empreinte, lotsCopies: [] };
    const valeur = JSON.parse(brut) as Partial<ProgressionCopie>;
    if (valeur.empreinte !== empreinte || !Array.isArray(valeur.lotsCopies)) {
      return { empreinte, lotsCopies: [] };
    }
    const lotsCopies = valeur.lotsCopies.filter(
      (index): index is number =>
        Number.isInteger(index) && index >= 0 && index < nombreLots,
    );
    return { empreinte, lotsCopies: [...new Set(lotsCopies)] };
  } catch {
    return { empreinte, lotsCopies: [] };
  }
}

function enregistrerProgression(progression: ProgressionCopie): void {
  try {
    sessionStorage.setItem(CLE_PROGRESSION, JSON.stringify(progression));
  } catch {
    // La copie reste utilisable si le navigateur refuse le stockage de session.
  }
}

export default function ContactsCoursCopie() {
  const location = useLocation();
  const navigate = useNavigate();
  const filtres = useMemo(() => lireFiltresNavigation(location.state), [location.state]);
  const data = useQuery(api.contactsCours.listContacts, filtres ? {} : "skip");
  const [progressionLocale, setProgressionLocale] = useState<ProgressionCopie | null>(null);
  const [erreurCopie, setErreurCopie] = useState<number | null>(null);

  const emails = useMemo(() => {
    if (!filtres || !data) return [];
    const contacts = filtrerContactsCours(data.contacts, filtres);
    return emailsUniques(
      contacts.map((contact) => normaliserAdresseEmailUnique(contact.email)),
    );
  }, [data, filtres]);

  const lots = useMemo(() => decouperEmailsEnLots(emails), [emails]);
  const empreinte = useMemo(() => creerEmpreinteEmails(emails), [emails]);
  const progressionStockee = useMemo(
    () => filtres && data !== undefined
      ? lireProgression(empreinte, lots.length)
      : null,
    [data, empreinte, filtres, lots.length],
  );
  const progression = progressionLocale?.empreinte === empreinte
    ? progressionLocale
    : progressionStockee;

  useEffect(() => {
    if (progressionStockee) enregistrerProgression(progressionStockee);
  }, [progressionStockee]);

  const copierLot = async (index: number) => {
    const lot = lots[index];
    if (!lot) return;

    try {
      await navigator.clipboard.writeText(lot.join(", "));
      setErreurCopie(null);
      setProgressionLocale((precedente) => {
        const base = precedente?.empreinte === empreinte
          ? precedente.lotsCopies
          : progression?.empreinte === empreinte
            ? progression.lotsCopies
            : [];
        const suivante = {
          empreinte,
          lotsCopies: [...new Set([...base, index])].sort((a, b) => a - b),
        };
        enregistrerProgression(suivante);
        return suivante;
      });
    } catch {
      setErreurCopie(index);
    }
  };

  if (!filtres) {
    return (
      <div className="contacts-cours-page contacts-cours-copy-page">
        <div className="contacts-cours-state" role="alert">
          <MailWarning size={36} aria-hidden="true" />
          <h1>Sélection expirée</h1>
          <p>Revenez aux contacts et choisissez de nouveau les destinataires.</p>
          <Link to="/contacts-cours" className="contacts-cours-action">
            <ArrowLeft size={18} aria-hidden="true" /> Retour aux contacts
          </Link>
        </div>
      </div>
    );
  }

  if (data === undefined || progression === null || progression.empreinte !== empreinte) {
    return (
      <div className="contacts-cours-page contacts-cours-copy-page">
        <div className="contacts-cours-state" role="status">
          Préparation des lots d’emails…
        </div>
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <div className="contacts-cours-page contacts-cours-copy-page">
        <div className="contacts-cours-state">
          <MailWarning size={36} aria-hidden="true" />
          <h1>Aucune adresse disponible</h1>
          <p>La sélection a changé ou ne contient plus d’adresse email valide.</p>
          <button type="button" className="contacts-cours-action" onClick={() => navigate(-1)}>
            <ArrowLeft size={18} aria-hidden="true" /> Retour aux contacts
          </button>
        </div>
      </div>
    );
  }

  const lotsCopies = new Set(progression.lotsCopies);

  return (
    <div className="contacts-cours-page contacts-cours-copy-page">
      <header className="contacts-cours-header">
        <button type="button" className="back-link contacts-cours-back-button" onClick={() => navigate(-1)}>
          <ArrowLeft size={16} aria-hidden="true" /> Retour aux contacts
        </button>
        <div className="contacts-cours-copy-heading">
          <p className="contacts-cours-kicker">Copie par lots</p>
          <h1>Emails du groupe filtré</h1>
          <p className="subtitle">
            Copiez chaque lot dans votre outil d’envoi. Les adresses sont séparées
            par des virgules dans le presse-papiers.
          </p>
        </div>
      </header>

      <div className="contacts-cours-copy-summary" role="status" aria-live="polite">
        <strong>{progression.lotsCopies.length} lot{progression.lotsCopies.length > 1 ? "s" : ""} copié{progression.lotsCopies.length > 1 ? "s" : ""} sur {lots.length}</strong>
        <span>{emails.length} adresses uniques, réparties par 99 maximum.</span>
      </div>
      <p className="contacts-cours-copy-session-note">
        La progression est conservée tant que cet onglet reste ouvert.
      </p>

      <ol className="contacts-cours-copy-list">
        {lots.map((lot, index) => {
          const estCopie = lotsCopies.has(index);
          const identifiantTitre = `contacts-cours-lot-${index + 1}`;
          const identifiantStatut = `contacts-cours-lot-statut-${index + 1}`;

          return (
            <li
              key={`${empreinte}-${index}`}
              className={`contacts-cours-copy-lot${estCopie ? " is-copied" : ""}`}
              aria-labelledby={identifiantTitre}
            >
              <div className="contacts-cours-copy-lot-header">
                <div>
                  <h2 id={identifiantTitre}>Lot {index + 1}</h2>
                  <span>{lot.length} adresse{lot.length > 1 ? "s" : ""}</span>
                </div>
                <button
                  type="button"
                  className="contacts-cours-action contacts-cours-action--copy"
                  onClick={() => void copierLot(index)}
                  aria-describedby={identifiantStatut}
                >
                  {estCopie
                    ? <Check size={18} aria-hidden="true" />
                    : <Clipboard size={18} aria-hidden="true" />}
                  {estCopie ? "Copié" : "Copier ce lot"}
                </button>
              </div>
              <pre tabIndex={0}><code>{lot.join("\n")}</code></pre>
              <p id={identifiantStatut} className="contacts-cours-copy-status" aria-live="polite">
                {estCopie
                  ? "Copie réussie — ce lot a déjà été traité."
                  : erreurCopie === index
                    ? "La copie a échoué. Vérifiez l’autorisation du presse-papiers puis réessayez."
                    : "À copier"}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
