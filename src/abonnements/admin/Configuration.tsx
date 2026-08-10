import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { aboError } from "../lib/errors";

// Vue admin « Configuration » (Phase I, portage de admin-config.js) : plafond de
// places, liens stables des étapes de finalisation, dates des vagues 2/3, et
// changement de saison (archive N-1 + purge des comptes publics). Le lien
// HelloAsso ne se change QU'au changement de saison (affiché en lecture seule).

type Statut = { texte: string; erreur: boolean } | null;

function Message({ statut }: { statut: Statut }) {
  if (!statut) return null;
  return (
    <p className={`abo-admin-status ${statut.erreur ? "abo-admin-status--error" : "abo-admin-status--success"}`}>
      {statut.texte}
    </p>
  );
}

export default function Configuration() {
  const cfg = useQuery(api.abo.config.getConfig);
  const setPlacesMax = useMutation(api.abo.compteur.setPlacesMax);
  const setLiens = useMutation(api.abo.config.setLiens);
  const setVagues = useMutation(api.abo.config.setVagues);
  const resetSaison = useMutation(api.abo.config.resetSaison);
  const setSynchronisationExterneActive = useMutation(api.abo.config.setSynchronisationExterneActive);

  // États de formulaire, initialisés depuis la config au chargement.
  const [places, setPlaces] = useState("350");
  const [liens, setLiensState] = useState({
    licence_nouvelle: "",
    licence_renouvellement: "",
    compte_activation: "",
    inscription: "",
    test_autonomie: "",
  });
  const [vagues, setVaguesState] = useState({ vague2_debut: "", vague3_debut: "" });
  const [saison, setSaison] = useState("");
  const [nouveauLien, setNouveauLien] = useState("");

  const [msgPlaces, setMsgPlaces] = useState<Statut>(null);
  const [msgLiens, setMsgLiens] = useState<Statut>(null);
  const [msgVagues, setMsgVagues] = useState<Statut>(null);
  const [msgSaison, setMsgSaison] = useState<Statut>(null);
  const [msgSynchronisation, setMsgSynchronisation] = useState<Statut>(null);
  const [busy, setBusy] = useState(false);
  const synchronisationExterneActive = cfg?.synchronisation_externe_active ?? true;

  useEffect(() => {
    if (!cfg) return;
    // Synchronisation volontaire des champs éditables lors du chargement
    // asynchrone de la configuration serveur.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlaces(cfg.places_max ?? "350");
    setLiensState({
      licence_nouvelle: cfg.licence_lien_nouvelle ?? "",
      licence_renouvellement: cfg.licence_lien_renouvellement ?? "",
      compte_activation: cfg.compte_activation_lien ?? "",
      inscription: cfg.inscription_lien ?? "",
      test_autonomie: cfg.test_autonomie_lien ?? "",
    });
    setVaguesState({
      vague2_debut: cfg.vague2_debut ?? "",
      vague3_debut: cfg.vague3_debut ?? "",
    });
  }, [cfg]);

  if (cfg === undefined) return <p>Chargement…</p>;

  async function enregistrerPlaces() {
    const n = parseInt(places, 10);
    if (!Number.isInteger(n) || n < 1) {
      setMsgPlaces({ texte: "Entrez un nombre entier ≥ 1.", erreur: true });
      return;
    }
    setBusy(true);
    setMsgPlaces(null);
    try {
      await setPlacesMax({ places_max: n });
      setMsgPlaces({ texte: `Plafond enregistré : ${n} places.`, erreur: false });
    } catch (err) {
      setMsgPlaces({ texte: aboError(err).message, erreur: true });
    } finally {
      setBusy(false);
    }
  }

  async function enregistrerLiens() {
    setBusy(true);
    setMsgLiens(null);
    try {
      await setLiens(liens);
      setMsgLiens({ texte: "Liens des étapes d'inscription enregistrés.", erreur: false });
    } catch (err) {
      setMsgLiens({ texte: aboError(err).message, erreur: true });
    } finally {
      setBusy(false);
    }
  }

  async function enregistrerVagues() {
    if (vagues.vague2_debut && vagues.vague3_debut && vagues.vague3_debut <= vagues.vague2_debut) {
      setMsgVagues({ texte: "Les dates doivent être croissantes : vague 2 < vague 3.", erreur: true });
      return;
    }
    setBusy(true);
    setMsgVagues(null);
    try {
      await setVagues(vagues);
      setMsgVagues({ texte: "Dates des vagues enregistrées.", erreur: false });
    } catch (err) {
      setMsgVagues({ texte: aboError(err).message, erreur: true });
    } finally {
      setBusy(false);
    }
  }

  async function changerSaison() {
    const s = saison.trim();
    const l = nouveauLien.trim();
    if (!s || !l) {
      setMsgSaison({ texte: "Renseignez la saison à archiver ET le nouveau lien.", erreur: true });
      return;
    }
    const ok = window.confirm(
      "Changer de saison ?\n\n" +
        `• Archive les abonnés actuels en N-1 sous « ${s} »\n` +
        "• Vide les abonnés scrapés, les paiements et les élèves en cours\n" +
        "• Supprime les demandes et les comptes abonnés publics\n" +
        "  (les comptes staff/admin sont conservés)\n" +
        "• Enregistre le nouveau lien HelloAsso\n\n" +
        "Le scrap du site et l'annuaire des licences seront mis en pause jusqu'à leur réactivation.\n\n" +
        "Action irréversible.",
    );
    if (!ok) return;
    setBusy(true);
    setMsgSaison({ texte: "Changement de saison en cours…", erreur: false });
    try {
      const n = await resetSaison({ saisonArchivee: s, nouveauLien: l });
      setSaison("");
      setNouveauLien("");
      setMsgSaison({
        texte: `Saison « ${s} » archivée (${n} abonné·es). Comptes publics en cours de suppression, nouveau lien enregistré. Relancez scrap + sync.`,
        erreur: false,
      });
    } catch (err) {
      setMsgSaison({ texte: aboError(err).message, erreur: true });
    } finally {
      setBusy(false);
    }
  }

  async function basculerSynchronisationExterne() {
    const active = !synchronisationExterneActive;
    setBusy(true);
    setMsgSynchronisation(null);
    try {
      await setSynchronisationExterneActive({ active });
      setMsgSynchronisation({
        texte: active
          ? "Synchronisations du site et de l'annuaire réactivées."
          : "Synchronisations du site et de l'annuaire mises en pause.",
        erreur: false,
      });
      setMsgSaison({
        texte: "Saison archivée. Le scrap du site et l'annuaire des licences sont en pause : réactivez-les lorsque leurs données sont prêtes.",
        erreur: false,
      });
    } catch (err) {
      setMsgSynchronisation({ texte: aboError(err).message, erreur: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="abo-admin-section abo-admin-configuration">
      <h2>Configuration</h2>

      <p className="abo-admin-copy">Lien HelloAsso actuel :</p>
      <p className="abo-admin-copy">
        {cfg.helloasso_lien ? (
          <code className="abo-admin-url">{cfg.helloasso_lien}</code>
        ) : (
          <span className="abo-admin-empty">(non défini)</span>
        )}
      </p>

      <hr className="abo-admin-separator" />

      <h3>Plafond de places</h3>
      <p className="abo-admin-intro">
        Nombre maximum de places affiché par le compteur (jauge « X / plafond »).
        Lorsqu’il est atteint, la validation propose par défaut la liste d’attente ; une
        dérogation explicite reste possible. Modifiable à tout moment.
      </p>
      <label className="abo-admin-label" htmlFor="places-max">Plafond</label>
      <input
        id="places-max"
        type="number"
        min={1}
        step={1}
        className="abo-admin-input abo-admin-input--short"
        value={places}
        onChange={(e) => setPlaces(e.target.value)}
      />
      <div>
        <button type="button" className="abo-admin-button" disabled={busy} onClick={enregistrerPlaces}>
          Enregistrer le plafond
        </button>
      </div>
      <Message statut={msgPlaces} />

      <hr className="abo-admin-separator" />

      <h3>Liens des étapes d'inscription</h3>
      <p className="abo-admin-intro">
        Liens affichés sur la page de suivi d'une demande <strong>acceptée</strong>
        (prendre sa licence, activer son compte, s'inscrire, passer le test). Le lien
        de <strong>paiement</strong> reste le lien HelloAsso ci-dessus. Ces liens
        sont <strong>stables</strong> : ils ne sont pas réinitialisés au changement
        de saison.
      </p>
      {([
        ["licence_nouvelle", "Licence — nouvelle adhésion"],
        ["licence_renouvellement", "Licence — renouvellement"],
        ["compte_activation", "Inscription — activation du compte"],
        ["inscription", "Inscription — demande d'abonnement"],
        ["test_autonomie", "Test d'autonomie — formulaire"],
      ] as const).map(([cle, label]) => (
        <div key={cle}>
          <label className="abo-admin-label" htmlFor={`lien-${cle}`}>{label}</label>
          <input
            id={`lien-${cle}`}
            type="url"
            className="abo-admin-input"
            value={liens[cle]}
            onChange={(e) => setLiensState((s) => ({ ...s, [cle]: e.target.value }))}
          />
        </div>
      ))}
      <div>
        <button type="button" className="abo-admin-button" disabled={busy} onClick={enregistrerLiens}>
          Enregistrer les liens
        </button>
      </div>
      <Message statut={msgLiens} />

      <hr className="abo-admin-separator" />

      <h3>Dates des vagues</h3>
      <p className="abo-admin-intro">
        Ouverture de la <strong>demande</strong> (heure de Paris). La vague 1
        (abonnés N-1) se fait <strong>directement sur le site du club</strong>. La
        demande s'ouvre à la <strong>vague 2</strong> (élèves en cours, sur licence)
        puis à la <strong>vague 3</strong> (tous). À re-saisir chaque saison. Vide =
        vague non encore ouverte.
      </p>
      <label className="abo-admin-label" htmlFor="vague2">Vague 2 (+ élèves en cours)</label>
      <input
        id="vague2"
        type="datetime-local"
        className="abo-admin-input abo-admin-input--date"
        value={vagues.vague2_debut}
        onChange={(e) => setVaguesState((s) => ({ ...s, vague2_debut: e.target.value }))}
      />
      <label className="abo-admin-label" htmlFor="vague3">Vague 3 (ouverture à tous)</label>
      <input
        id="vague3"
        type="datetime-local"
        className="abo-admin-input abo-admin-input--date"
        value={vagues.vague3_debut}
        onChange={(e) => setVaguesState((s) => ({ ...s, vague3_debut: e.target.value }))}
      />
      <div>
        <button type="button" className="abo-admin-button" disabled={busy} onClick={enregistrerVagues}>
          Enregistrer les dates
        </button>
      </div>
      <Message statut={msgVagues} />

      <hr className="abo-admin-separator" />

      <h3>Synchronisations externes</h3>
      <p className="abo-admin-intro">
        Le scrap des abonnés du site club et l'annuaire des licences sont
        <strong> {synchronisationExterneActive ? "activés" : "en pause"}</strong>.
        Après un changement de saison, ils restent en pause tant que le site et
        l'annuaire n'ont pas basculé sur la nouvelle campagne.
      </p>
      <div>
        <button type="button" className="abo-admin-button" disabled={busy} onClick={basculerSynchronisationExterne}>
          {synchronisationExterneActive
            ? "Mettre en pause les synchronisations"
            : "Réactiver les synchronisations"}
        </button>
      </div>
      <Message statut={msgSynchronisation} />

      <hr className="abo-admin-separator" />

      <h3 className="abo-admin-heading abo-admin-heading--danger">Changer de saison</h3>
      <p className="abo-admin-intro">
        Le lien HelloAsso ne change qu'ici. Cette action <strong>archive</strong> les
        abonnés de la saison qui se termine (N-1), <strong>vide</strong> le scrap, les
        paiements et les élèves en cours, <strong>supprime</strong> les demandes et les
        comptes abonnés publics (les comptes <strong>staff/admin</strong> sont conservés),
        puis enregistre le <strong>nouveau lien</strong>. À faire <strong>avant</strong> le
        premier scrap de la nouvelle saison. Irréversible.
      </p>
      <label className="abo-admin-label" htmlFor="saison">Saison qui se termine (archivée en N-1)</label>
      <input
        id="saison"
        type="text"
        placeholder="2025-2026"
        className="abo-admin-input abo-admin-input--date"
        value={saison}
        onChange={(e) => setSaison(e.target.value)}
      />
      <label className="abo-admin-label" htmlFor="nouveau-lien">Nouveau lien HelloAsso (nouvelle saison)</label>
      <input
        id="nouveau-lien"
        type="url"
        placeholder="https://www.helloasso.com/associations/…"
        className="abo-admin-input"
        value={nouveauLien}
        onChange={(e) => setNouveauLien(e.target.value)}
      />
      <div>
        <button
          type="button"
          className="abo-admin-button abo-admin-button--danger"
          disabled={busy}
          onClick={changerSaison}
        >
          Changer de saison
        </button>
      </div>
      <Message statut={msgSaison} />
    </div>
  );
}
