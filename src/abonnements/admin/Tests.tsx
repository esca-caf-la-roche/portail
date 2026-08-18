import { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { aboError } from "../lib/errors";
import { cleJour, formatDateJour, formatJour, formatTranche } from "../lib/tests";

// Vue admin « Tests d'autonomie » : gestion des disponibilités + inscrits.
// Chaque admin propose ses créneaux (jour + plage). La capacité par slot de 20 min
// se cumule au prorata des encadrants présents (calcul côté serveur, tranches de
// 40/60 min). Supprimer un créneau peut déloger des candidats en surplus (LIFO) —
// la mutation renvoie le nombre annulé. Portage de src/pages/admin-tests.js.

// Grille de sélection : slots de 20 min (minutes depuis minuit). 8h00 → 22h40.
const SLOT_MIN = 8 * 60;
const SLOT_MAX = 22 * 60 + 40;

const minToTime = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minToLabel = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h${String(mm).padStart(2, "0")}`;
};
const dureeLabel = (min: number) => {
  const h = Math.floor(min / 60);
  const r = min % 60;
  return h === 0 ? `${r} min` : r === 0 ? `${h} h` : `${h} h ${r}`;
};
const hhmm = (t: string) => (t ?? "").slice(0, 5);
const todayISO = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const borneTemporelle = () => {
  const instant = new Date();
  instant.setMinutes(Math.floor(instant.getMinutes() / 20) * 20, 0, 0);
  return {
    dateDebut: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(instant),
    instantReference: instant.toISOString(),
  };
};

export default function Tests({ licenceInitiale }: { licenceInitiale: string | null }) {
  const [borneCreneaux, setBorneCreneaux] = useState(borneTemporelle);
  useEffect(() => {
    let timeoutId: number;
    const planifierProchainPalier = () => {
      const maintenant = new Date();
      const prochainPalier = new Date(maintenant);
      prochainPalier.setMinutes(
        Math.floor(maintenant.getMinutes() / 20) * 20 + 20,
        0,
        0,
      );
      timeoutId = window.setTimeout(() => {
        setBorneCreneaux(borneTemporelle());
        planifierProchainPalier();
      }, Math.max(1_000, prochainPalier.getTime() - maintenant.getTime()));
    };
    planifierProchainPalier();
    return () => window.clearTimeout(timeoutId);
  }, []);
  const creneaux = useQuery(api.abo.tests.getCreneauxStaff, {
    dateDebut: borneCreneaux.dateDebut,
    instantReference: borneCreneaux.instantReference,
  });
  const inscrits = useQuery(api.abo.tests.testInscritsAdmin);
  const creer = useMutation(api.abo.tests.creerTestCreneau);
  const rejoindre = useMutation(api.abo.tests.rejoindreTestCreneau);
  const supprimer = useMutation(api.abo.tests.supprimerTestCreneau);

  return (
    <div className="abo-admin-section">
      <p className="abo-admin-intro">
        Proposez vos disponibilités : un encadrant teste 2 personnes par tranche
        de 20 min ; la capacité de plusieurs encadrants se cumule. Les candidats
        réservent une tranche de 40 ou 60 min (répartition fine le jour J).
      </p>

      <section className="abo-admin-subsection">
        <h3 className="abo-admin-subheading">Proposer une disponibilité</h3>
        <PickerCreneau creer={creer} />
      </section>

      <hr className="abo-admin-separator" />

      <section>
        <h3 className="abo-admin-subheading">Créneaux de l'équipe</h3>
        <p className="abo-admin-intro">
          Retrouvez les disponibilités de tous les encadrants et rejoignez-les pour
          organiser les tests à plusieurs.
        </p>
        <CreneauxStaff creneaux={creneaux} rejoindre={rejoindre} supprimer={supprimer} />
      </section>

      <hr className="abo-admin-separator" />

      <section>
        <h3 className="abo-admin-subheading">Inscrits par créneau</h3>
        <Inscrits inscrits={inscrits} />
      </section>

      <hr className="abo-admin-separator" />

      <ArchiveTests licenceInitiale={licenceInitiale} />
    </div>
  );
}

type FiltreArchive = "a_traiter" | "traite" | "tous";
type ArchiveTest = NonNullable<
  ReturnType<typeof useQuery<typeof api.abo.testDocuments.listArchives>>
>[number];
type CandidatTest = NonNullable<
  ReturnType<typeof useQuery<typeof api.abo.testDocuments.rechercherCandidatParLicence>>
>;

function ArchiveTests({ licenceInitiale }: { licenceInitiale: string | null }) {
  const [filtre, setFiltre] = useState<FiltreArchive>("a_traiter");
  const [licenceSaisie, setLicenceSaisie] = useState("");
  const [licenceRecherchee, setLicenceRecherchee] = useState<string | null>(null);
  // L'heure est figée à l'ouverture : un rechargement suffit lorsque le créneau
  // commence, sans abonnement Convex périodique.
  const [instantReference] = useState(() => new Date().toISOString());
  const derniereLicenceInitiale = useRef<string | null>(null);
  const archives = useQuery(api.abo.testDocuments.listArchives, { filtre });
  const toutesArchives = useQuery(api.abo.testDocuments.listArchives, { filtre: "tous" });
  const reservations = useQuery(api.abo.testDocuments.listeReservationsPassees, {
    avant: instantReference,
  });
  const candidat = useQuery(
    api.abo.testDocuments.rechercherCandidatParLicence,
    licenceRecherchee ? { licence: licenceRecherchee, avant: instantReference } : "skip",
  );

  useEffect(() => {
    if (!licenceInitiale || licenceInitiale === derniereLicenceInitiale.current) return;
    derniereLicenceInitiale.current = licenceInitiale;
    setLicenceSaisie(licenceInitiale);
    setLicenceRecherchee(licenceInitiale);
  }, [licenceInitiale]);

  function rechercher(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const licence = licenceSaisie.trim();
    setLicenceRecherchee(licence || null);
  }

  return (
    <section className="abo-admin-subsection abo-admin-tests-archive">
      <div>
        <h3 className="abo-admin-subheading">Archives des tests réalisés</h3>
        <p className="abo-admin-intro">
          Déposez le formulaire ou une photo après le test. Une seule pièce est conservée
          par test, puis transmise dans Drive pour traitement.
        </p>
      </div>

      <ListePersonnesAEnregistrer reservations={reservations} toutesArchives={toutesArchives} />

      <section className="abo-admin-tests-step">
      <h4 className="abo-admin-subheading">Rechercher un licencié pour enregistrer son test</h4>
      <p className="abo-admin-meta">Recherchez par numéro de licence, puis importez la photo ou le PDF du test.</p>
      <form className="abo-admin-toolbar abo-admin-tests-licence-search" onSubmit={rechercher}>
        <label className="abo-admin-filter-field" htmlFor="recherche-licence-test">
          <span>Numéro de licence</span>
          <input
            id="recherche-licence-test"
            className="abo-admin-input abo-admin-search"
            type="search"
            inputMode="numeric"
            value={licenceSaisie}
            onChange={(e) => setLicenceSaisie(e.target.value)}
            placeholder="Ex. 123456"
          />
        </label>
        <button type="submit" className="abo-admin-button abo-admin-button--secondary">
          Rechercher
        </button>
      </form>

      {licenceRecherchee && candidat === undefined && <p>Recherche…</p>}
      {licenceRecherchee && candidat === null && (
        <p className="abo-admin-empty">
          Aucun test passé n'est associé à cette licence. Vérifiez le numéro de licence.
        </p>
      )}
      {candidat && !candidat.driveUrl && (
        <RechercheDrive key={candidat.licence} nom={candidat.nom} prenom={candidat.prenom} />
      )}
      {candidat && (
        <DepotTest
          candidat={candidat}
          archiveExistante={
            candidat.archiveId
              ? toutesArchives?.find((archive) => archive.id === candidat.archiveId) ?? null
              : null
          }
        />
      )}
      </section>

      <section className="abo-admin-subsection abo-admin-tests-step">
        <h4 className="abo-admin-subheading">Retrouver un ancien test dans Drive</h4>
        <p className="abo-admin-meta">
          Recherche par nom, prénom ou fragment, selon le nom des fichiers Drive.
        </p>
        <RechercheDrive />
      </section>

      <section className="abo-admin-tests-step">
      <h4 className="abo-admin-subheading">Tests déposés sur Drive</h4>
      <p className="abo-admin-meta">
        Cette file liste les tests d&apos;autonomie déposés sur Drive. Après les avoir validés sur le site du club, marquez-les comme traités ici.
      </p>
      <div className="abo-admin-toolbar abo-admin-tests-filter-tabs" role="group" aria-label="Filtrer les archives">
        {([
          ["a_traiter", "À traiter"],
          ["traite", "Traités"],
          ["tous", "Tous"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="abo-admin-button"
            aria-pressed={filtre === id}
            onClick={() => setFiltre(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <ArchivesListe archives={archives} />
      </section>
    </section>
  );
}

function ListePersonnesAEnregistrer({
  reservations,
  toutesArchives,
}: {
  reservations: CandidatTest[] | undefined;
  toutesArchives: ArchiveTest[] | undefined;
}) {
  return (
    <section className="abo-admin-subsection abo-admin-tests-step">
      <h4 className="abo-admin-subheading">Tests d'autonomie à enregistrer</h4>
      <p className="abo-admin-meta">
        Les candidats apparaissent dès le début de leur créneau et restent affichés après celui-ci.
      </p>
      {reservations === undefined ? (
        <p>Chargement…</p>
      ) : reservations.length === 0 ? (
        <p className="abo-admin-empty">Aucune réservation passée à archiver.</p>
      ) : (
        <ul className="abo-admin-list">
          {reservations.map((reservation) => (
            <li key={reservation.personneId ?? reservation.licence} className="abo-admin-list-row">
              <span>
                <strong>{`${reservation.prenom} ${reservation.nom}`.trim() || "—"}</strong>{" "}
                {!reservation.licenceManquante && (
                  <span className="abo-admin-meta">Licence {reservation.licence}</span>
                )}
              </span>
              <DepotTest
                candidat={reservation}
                archiveExistante={
                  reservation.archiveId
                    ? toutesArchives?.find((archive) => archive.id === reservation.archiveId) ?? null
                    : null
                }
                compact
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RechercheDrive({ nom: nomInitial, prenom: prenomInitial }: { nom?: string; prenom?: string }) {
  const rechercherDansDrive = useAction(api.abo.testDocumentsDrive.rechercherDansDrive);
  const [nom, setNom] = useState(nomInitial ?? "");
  const [prenom, setPrenom] = useState(prenomInitial ?? "");
  const [enCours, setEnCours] = useState(false);
  const [resultats, setResultats] = useState<Array<{ nomFichier: string; driveUrl: string }>>([]);
  const [erreur, setErreur] = useState<string | null>(null);

  async function rechercher() {
    setEnCours(true);
    setErreur(null);
    try {
      const trouves = await rechercherDansDrive({ nom, prenom });
      if (trouves.length === 0) {
        setErreur("Aucun ancien test n'a été trouvé dans Drive pour cette recherche.");
        return;
      }
      setResultats(trouves);
    } catch (err) {
      setErreur(aboError(err).message);
    } finally {
      setEnCours(false);
    }
  }

  return (
    <div className="abo-admin-toolbar abo-admin-tests-drive-search">
      {!nomInitial || !prenomInitial ? (
        <>
          <label className="abo-admin-filter-field">
            <span>Nom</span>
            <input className="abo-admin-input" value={nom} onChange={(e) => setNom(e.target.value)} />
          </label>
          <label className="abo-admin-filter-field">
            <span>Prénom</span>
            <input className="abo-admin-input" value={prenom} onChange={(e) => setPrenom(e.target.value)} />
          </label>
        </>
      ) : null}
      <button type="button" className="abo-admin-button abo-admin-button--secondary" disabled={enCours || (!nom.trim() && !prenom.trim())} onClick={() => void rechercher()}>
        {enCours ? "Recherche dans Drive…" : "Rechercher le test dans Drive"}
      </button>
      {resultats.length > 0 && (
        <ul className="abo-admin-test-results">
          {resultats.map((resultat) => (
            <li key={resultat.driveUrl} className="abo-admin-test-result">
              <span>{resultat.nomFichier}</span>
              <a className="abo-admin-button abo-admin-button--secondary" href={resultat.driveUrl} target="_blank" rel="noreferrer">Ouvrir dans Drive</a>
            </li>
          ))}
        </ul>
      )}
      {erreur && <p className="abo-admin-status abo-admin-status--error" role="status">{erreur}</p>}
    </div>
  );
}

function ArchivesListe({ archives }: { archives: ArchiveTest[] | undefined }) {
  const marquerTraite = useMutation(api.abo.testDocuments.marquerTraite);
  const [enCours, setEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  async function traiter(archiveId: ArchiveTest["id"]) {
    setEnCours(archiveId);
    setErreur(null);
    try {
      await marquerTraite({ archiveId });
    } catch (err) {
      setErreur(aboError(err).message);
    } finally {
      setEnCours(null);
    }
  }

  if (archives === undefined) return <p>Chargement…</p>;
  if (archives.length === 0) return <p className="abo-admin-empty">Aucune archive dans cette file.</p>;
  return (
    <>
      {erreur && <p className="abo-admin-status abo-admin-status--error">Échec : {erreur}</p>}
      <ul className="abo-admin-list">
        {archives.map((archive) => (
          <li key={archive.id} className="abo-admin-card abo-admin-list-row">
            <span>
              <strong>{`${archive.prenom} ${archive.nom}`.trim() || "—"}</strong>{" "}
              <span className="abo-admin-meta">Licence {archive.licence}</span>
            </span>
            <span className="abo-admin-toolbar">
              {archive.driveUrl ? (
                <a className="abo-admin-link-button" href={archive.driveUrl} target="_blank" rel="noreferrer">
                  Ouvrir dans Drive
                </a>
              ) : (
                <span className="abo-admin-meta">Transfert Drive en attente</span>
              )}
              {archive.statut === "a_traiter" && (
                <button
                  type="button"
                  className="abo-admin-link-button"
                  disabled={enCours === archive.id}
                  onClick={() => void traiter(archive.id)}
                >
                  {enCours === archive.id ? "Traitement…" : "Marquer traité"}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function DepotTest({
  candidat,
  archiveExistante,
  compact = false,
}: {
  candidat: CandidatTest;
  archiveExistante: ArchiveTest | null;
  compact?: boolean;
}) {
  const preparerDepot = useMutation(api.abo.testDocuments.preparerDepot);
  const genererUrlUpload = useMutation(api.abo.testDocuments.genererUrlUpload);
  const envoyerVersDrive = useAction(api.abo.testDocumentsDrive.envoyerVersDrive);
  const inputRef = useRef<HTMLInputElement>(null);
  const [fichier, setFichier] = useState<File | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (candidat.licenceManquante) {
    return (
      <p className="abo-admin-status abo-admin-status--error">
        Numéro de licence obligatoire avant de pouvoir importer le test.
      </p>
    );
  }

  if (candidat.archiveId && candidat.driveUrl) {
    return (
      <div className={`abo-admin-test-upload${compact ? " abo-admin-test-upload--compact" : ""}`}>
        <p className="abo-admin-status">
          Un document est déjà archivé pour cette licence. Le dépôt ne peut pas l'écraser.
        </p>
        {candidat.driveUrl || archiveExistante?.driveUrl ? (
          <a className="abo-admin-link-button" href={candidat.driveUrl ?? archiveExistante!.driveUrl} target="_blank" rel="noreferrer">
            Ouvrir l'archive dans Drive
          </a>
        ) : (
          <p className="abo-admin-meta">Retrouvez-le dans la file des archives.</p>
        )}
      </div>
    );
  }

  async function deposer() {
    if (!fichier) {
      setMessage("Choisissez une photo JPEG/PNG ou un PDF avant le dépôt.");
      return;
    }
    setEnCours(true);
    setMessage(null);
    try {
      const archive = await preparerDepot({ licence: candidat.licence });
      const { uploadUrl } = await genererUrlUpload({
        archiveId: archive.archiveId,
        uploadToken: archive.uploadToken,
      });
      const reponse = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": fichier.type },
        body: fichier,
      });
      if (!reponse.ok) throw new Error("L'envoi du fichier a échoué.");
      const { storageId } = (await reponse.json()) as { storageId: string };
      await envoyerVersDrive({
        archiveId: archive.archiveId,
        uploadToken: archive.uploadToken,
        storageId: storageId as Id<"_storage">,
      });
      setFichier(null);
      if (inputRef.current) inputRef.current.value = "";
      setMessage("Document déposé et envoyé dans Drive. Il est maintenant à traiter.");
    } catch (err) {
      setMessage(`Échec : ${aboError(err).message}`);
    } finally {
      setEnCours(false);
    }
  }

  return (
    <div className={`abo-admin-test-upload${compact ? " abo-admin-test-upload--compact" : ""}`}>
      {!compact && (
        <p className="abo-admin-card abo-admin-card-copy">
          <strong>{`${candidat.prenom} ${candidat.nom}`.trim() || "—"}</strong>{" "}
          <span className="abo-admin-meta">Licence {candidat.licence}</span>
        </p>
      )}
      <label className="abo-admin-filter-field">
        <span>Formulaire ou photo du test</span>
        <input
          ref={inputRef}
          className="abo-admin-input"
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          capture="environment"
          onChange={(e) => {
            const prochain = e.target.files?.[0] ?? null;
            if (prochain && !["image/jpeg", "image/png", "application/pdf"].includes(prochain.type)) {
              setFichier(null);
              setMessage("Format non pris en charge : utilisez une photo JPEG/PNG ou un PDF.");
              e.currentTarget.value = "";
              return;
            }
            setFichier(prochain);
            setMessage(null);
          }}
        />
      </label>
      <button type="button" className="abo-admin-button abo-admin-button--primary" disabled={enCours} onClick={() => void deposer()}>
        {enCours ? "Dépôt…" : "Déposer le test"}
      </button>
      {message && <p className={`abo-admin-status${message.startsWith("Échec") ? " abo-admin-status--error" : ""}`} role="status">{message}</p>}
    </div>
  );
}

// ── Sélecteur de créneau (jour + grille de slots 20 min) ─────────────
function PickerCreneau({
  creer,
}: {
  creer: ReturnType<typeof useMutation<typeof api.abo.tests.creerTestCreneau>>;
}) {
  const [jour, setJour] = useState("");
  const [debut, setDebut] = useState<number | null>(null);
  const [fin, setFin] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function cliquer(min: number) {
    // 1er clic = début ; 2e clic (après le début) = fin ; sinon on redémarre.
    if (debut == null || fin != null || min <= debut) {
      setDebut(min);
      setFin(null);
    } else {
      setFin(min);
    }
  }

  async function ajouter() {
    if (debut == null || fin == null) return;
    setBusy(true);
    setMsg("Ajout…");
    try {
      await creer({
        date: jour,
        debut: minToTime(debut),
        fin: minToTime(fin + 20), // le créneau va jusqu'à la fin du dernier slot
      });
      setDebut(null);
      setFin(null);
      setMsg(null);
    } catch (err) {
      setMsg(`Échec : ${aboError(err).message}`);
    } finally {
      setBusy(false);
    }
  }

  const complet = debut != null && fin != null;
  const resume = complet
    ? `${minToLabel(debut!)} → ${minToLabel(fin! + 20)} · ${dureeLabel(fin! + 20 - debut!)}`
    : debut != null
      ? `Début ${minToLabel(debut)} — cliquez l'heure de fin.`
      : "Cliquez l'heure de début.";

  const heures: number[] = [];
  for (let h = Math.floor(SLOT_MIN / 60); h <= Math.floor(SLOT_MAX / 60); h++) {
    heures.push(h);
  }

  return (
    <div>
      <label className="abo-admin-label">
        Jour{" "}
        <input
          type="date"
          min={todayISO()}
          value={jour}
          onChange={(e) => {
            setJour(e.target.value);
            setDebut(null);
            setFin(null);
          }}
          className="abo-admin-input abo-admin-input--date"
        />
      </label>

      {jour && (
        <>
          <div className="abo-admin-slot-grid">
            {heures.map((h) => (
              <div key={h} className="abo-admin-slot-row">
                <span className="abo-admin-slot-hour">
                  {h}h
                </span>
                <div className="abo-admin-slot-buttons">
                  {[0, 20, 40].map((mm) => {
                    const min = h * 60 + mm;
                    if (min < SLOT_MIN || min > SLOT_MAX) {
                      return <span key={mm} className="abo-admin-slot-placeholder" />;
                    }
                    const estBorne = min === debut || min === fin;
                    const dans = debut != null && fin != null && min > debut && min < fin;
                    return (
                      <button
                        key={mm}
                        type="button"
                        onClick={() => cliquer(min)}
                        className={`abo-admin-slot${estBorne ? " abo-admin-slot--selected" : dans ? " abo-admin-slot--range" : ""}`}
                      >
                        {String(mm).padStart(2, "0")}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="abo-admin-status">{resume}</p>
          <button
            type="button"
            className="abo-admin-button abo-admin-button--secondary"
            onClick={ajouter}
            disabled={!complet || busy}
          >
            Ajouter le créneau
          </button>
          {msg && <span className="abo-admin-status">{msg}</span>}
        </>
      )}
    </div>
  );
}

// ── Créneaux de l'équipe (ajout/retrait de l'admin connecté) ──────────
function CreneauxStaff({
  creneaux,
  rejoindre,
  supprimer,
}: {
  creneaux: ReturnType<typeof useQuery<typeof api.abo.tests.getCreneauxStaff>>;
  rejoindre: ReturnType<typeof useMutation<typeof api.abo.tests.rejoindreTestCreneau>>;
  supprimer: ReturnType<typeof useMutation<typeof api.abo.tests.supprimerTestCreneau>>;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function ajouter(creneauId: Id<"abo_test_creneaux">) {
    setBusyId(creneauId);
    setMsg(null);
    try {
      await rejoindre({ creneauId });
      setMsg("Vous avez rejoint ce créneau.");
    } catch (err) {
      setMsg(`Échec : ${aboError(err).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function retirer(id: Id<"abo_test_creneaux">) {
    const ok = window.confirm(
      "Vous retirer de ce créneau ?\n\nSi des candidats sont inscrits au-delà de la nouvelle " +
        "capacité, les derniers inscrits seront automatiquement désinscrits (et notifiés).",
    );
    if (!ok) return;
    setBusyId(id);
    setMsg(null);
    try {
      const n = await supprimer({ creneauId: id });
      setMsg(
        n > 0
          ? `Vous avez quitté ce créneau. ${n} réservation${n > 1 ? "s" : ""} en surplus ${n > 1 ? "ont été annulées" : "a été annulée"} et les personnes notifiées.`
          : "Vous avez quitté ce créneau.",
      );
    } catch (err) {
      setMsg(`Échec : ${aboError(err).message}`);
    } finally {
      setBusyId(null);
    }
  }

  if (creneaux === undefined) return <p>Chargement…</p>;

  return (
    <>
      {msg && (
        <p
          className={`abo-admin-status${msg.startsWith("Échec") ? " abo-admin-status--error" : " abo-admin-status--success"}`}
          role="status"
          aria-live="polite"
        >
          {msg}
        </p>
      )}
      {creneaux.length === 0 ? (
        <p className="abo-admin-empty">Aucun encadrant n'a proposé de créneau pour l'instant.</p>
      ) : (
        <ul className="abo-admin-list abo-admin-staff-slots">
          {creneaux.map((c) => (
            <li
              key={c.creneauId}
              className={`abo-admin-card abo-admin-staff-slot${c.monCreneauId ? " abo-admin-staff-slot--joined" : ""}`}
            >
              <div className="abo-admin-staff-slot-main">
                <p className="abo-admin-staff-slot-time">
                  {formatDateJour(c.date_jour)} ·{" "}
                  <strong>
                    {hhmm(c.heure_debut)}–{hhmm(c.heure_fin)}
                  </strong>
                </p>
                <div className="abo-admin-staff-slot-members">
                  <span className="abo-admin-meta">
                    {c.participants.length} encadrant{c.participants.length > 1 ? "s" : ""}
                  </span>
                  <ul className="abo-admin-staff-names" aria-label="Encadrants présents">
                    {c.participants.map((encadrant, index) => (
                      <li key={`${encadrant.nomAffiche}-${index}`}>
                        <span>{encadrant.nomAffiche}</span>
                        {encadrant.estMoi && (
                          <span className="abo-admin-badge abo-admin-badge--success">
                            Vous participez
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {c.monCreneauId ? (
                <button
                  type="button"
                  onClick={() => void retirer(c.monCreneauId!)}
                  className="abo-admin-button abo-admin-button--danger abo-admin-staff-slot-action"
                  disabled={busyId !== null}
                  aria-label={`${busyId === c.monCreneauId ? "Retrait en cours" : "Me retirer"} du créneau du ${formatDateJour(c.date_jour)}, de ${hhmm(c.heure_debut)} à ${hhmm(c.heure_fin)}`}
                >
                  {busyId === c.monCreneauId ? "Retrait…" : "Me retirer"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void ajouter(c.creneauId)}
                  className="abo-admin-button abo-admin-button--secondary abo-admin-staff-slot-action"
                  disabled={busyId !== null}
                  aria-label={`${busyId === c.creneauId ? "Ajout en cours" : "M'ajouter"} au créneau du ${formatDateJour(c.date_jour)}, de ${hhmm(c.heure_debut)} à ${hhmm(c.heure_fin)}`}
                >
                  {busyId === c.creneauId ? "Ajout…" : "Je m'ajoute"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Inscrits par jour puis par tranche ───────────────────────────────
function etatConfirmationReservation(reservation: object): "provisoire" | "confirmee" {
  return (reservation as { etat_confirmation?: "provisoire" | "confirmee" })
    .etat_confirmation === "confirmee"
    ? "confirmee"
    : "provisoire";
}

function Inscrits({
  inscrits,
}: {
  inscrits: ReturnType<typeof useQuery<typeof api.abo.tests.testInscritsAdmin>>;
}) {
  if (inscrits === undefined) return <p>Chargement…</p>;
  if (inscrits.length === 0) {
    return <p className="abo-admin-empty">Aucun candidat inscrit pour l'instant.</p>;
  }

  // Regroupe par jour, puis par tranche (clé = début).
  const jours = new Map<
    string,
    {
      label: string;
      tranches: Map<string, { fin: string | null; gens: typeof inscrits }>;
    }
  >();
  for (const r of inscrits) {
    const kJour = cleJour(r.tranche_debut);
    if (!jours.has(kJour)) {
      jours.set(kJour, { label: formatJour(r.tranche_debut), tranches: new Map() });
    }
    const j = jours.get(kJour)!;
    if (!j.tranches.has(r.tranche_debut)) {
      j.tranches.set(r.tranche_debut, { fin: r.tranche_fin, gens: [] });
    }
    j.tranches.get(r.tranche_debut)!.gens.push(r);
  }

  return (
    <div className="abo-admin-list">
      {[...jours.values()].map((j) => (
        <div key={j.label}>
          <h4 className="abo-admin-subheading">{j.label}</h4>
          <div className="abo-admin-list">
            {[...j.tranches.entries()].map(([debut, { fin, gens }]) => (
              <div
                key={debut}
                className="abo-admin-card"
              >
                <div className="abo-admin-toolbar">
                  <strong>{formatTranche(debut, fin)}</strong>
                  <span className="abo-admin-meta">
                    {gens.length} inscrit{gens.length > 1 ? "s" : ""}
                  </span>
                </div>
                <ul className="abo-admin-attendee-list">
                  {gens.map((g) => {
                    const confirmation = etatConfirmationReservation(g);
                    return (
                      <li key={g.reservationId}>
                        {`${g.prenom ?? ""} ${g.nom ?? ""}`.trim() || "—"}{" "}
                        <span className="abo-admin-meta">({g.email})</span>
                        {g.licence && <span className="abo-admin-meta"> — licence {g.licence}</span>}
                        <span
                          className={`abo-admin-badge abo-admin-badge--confirmation-${confirmation}`}
                          aria-label={`Réservation ${confirmation === "confirmee" ? "confirmée" : "provisoire"}`}
                        >
                          {confirmation === "confirmee" ? "Confirmé" : "Provisoire"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
