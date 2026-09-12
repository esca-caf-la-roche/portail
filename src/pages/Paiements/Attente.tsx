import { useState, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useOutletContext } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PaiementsDossiersContextValue } from "./Layout";

type CsvStudent = { first_name: string; last_name: string; email: string };
type WaitingStudents = NonNullable<
  ReturnType<typeof useQuery<typeof api.paiements.getWaitingStudents>>
>;
type WaitingStudent = WaitingStudents[number];

export default function AttentePaiements() {
  const waitingStudents = useQuery(api.paiements.getWaitingStudents);
  const { dossiersTraites: dossiers } = useOutletContext<PaiementsDossiersContextValue>();

  const addStudent = useMutation(api.paiements.addWaitingStudent);
  const addBulk = useMutation(api.paiements.addWaitingStudentsBulk);
  const updateStudent = useMutation(api.paiements.updateWaitingStudent);
  const deleteStudent = useMutation(api.paiements.deleteWaitingStudent);

  // Ajout individuel
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Édition
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFirst, setEditFirst] = useState("");
  const [editLast, setEditLast] = useState("");
  const [editEmail, setEditEmail] = useState("");

  // Import CSV
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvPreview, setCsvPreview] = useState<CsvStudent[]>([]);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const [search, setSearch] = useState("");

  const isLoading = waitingStudents === undefined;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setSubmitError("Veuillez remplir tous les champs.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await addStudent({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim(),
      });
      setFirstName("");
      setLastName("");
      setEmail("");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (s: WaitingStudent) => {
    setEditingId(s.id);
    setEditFirst(s.first_name);
    setEditLast(s.last_name);
    setEditEmail(s.email);
  };
  const cancelEdit = () => setEditingId(null);
  const saveEdit = async (id: string) => {
    if (!editFirst.trim() || !editLast.trim() || !editEmail.trim()) {
      alert("Veuillez remplir tous les champs.");
      return;
    }
    try {
      await updateStudent({
        id: id as Id<"waiting_students">,
        first_name: editFirst.trim(),
        last_name: editLast.trim(),
        email: editEmail.trim(),
      });
      cancelEdit();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };
  const remove = async (id: string) => {
    if (!window.confirm("Retirer cet élève de la liste d'attente ?")) return;
    try {
      await deleteStudent({ id: id as Id<"waiting_students"> });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  // Analyse CSV
  const handleCsvChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setCsvFile(null);
    setCsvPreview([]);
    setCsvError(null);
    if (!file) return;
    setCsvFile(file);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) {
        setCsvError("Le fichier est vide.");
        return;
      }
      try {
        const lines = text.split(/\r?\n/);
        const firstLine = lines[0] ?? "";
        const commaCount = (firstLine.match(/,/g) || []).length;
        const semiCount = (firstLine.match(/;/g) || []).length;
        const delim = semiCount > commaCount ? ";" : ",";

        const parseLine = (line: string) => {
          const result: string[] = [];
          let current = "";
          let inQuotes = false;
          for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') inQuotes = !inQuotes;
            else if (char === delim && !inQuotes) {
              result.push(current.trim());
              current = "";
            } else current += char;
          }
          result.push(current.trim());
          return result;
        };

        const headers = parseLine(firstLine).map((h) =>
          h
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/^["']|["']$/g, "")
            .trim()
        );

        let fIdx = -1;
        let lIdx = -1;
        let eIdx = -1;
        for (let i = 0; i < headers.length; i++) {
          const h = headers[i];
          if (h.includes("prenom") || h.includes("first") || h === "pnom") fIdx = i;
          else if (h.includes("nom") || h.includes("last") || h === "n") lIdx = i;
          else if (h.includes("mail") || h.includes("email") || h === "e-mail")
            eIdx = i;
        }

        const hasHeaders = fIdx !== -1 || lIdx !== -1 || eIdx !== -1;
        const startIdx = hasHeaders ? 1 : 0;
        const parsed: CsvStudent[] = [];
        const clean = (val: string) => val.replace(/^["']|["']$/g, "").trim();

        for (let i = startIdx; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const cols = parseLine(line);
          let fName = "";
          let lName = "";
          let mail = "";
          if (hasHeaders) {
            if (fIdx !== -1) fName = cols[fIdx] ?? "";
            if (lIdx !== -1) lName = cols[lIdx] ?? "";
            if (eIdx !== -1) mail = cols[eIdx] ?? "";
          } else {
            fName = cols[0] ?? "";
            lName = cols[1] ?? "";
            mail = cols[2] ?? "";
          }
          fName = clean(fName);
          lName = clean(lName);
          mail = clean(mail);
          if (fName && lName && mail && mail.includes("@")) {
            parsed.push({ first_name: fName, last_name: lName, email: mail });
          }
        }

        if (parsed.length === 0) {
          setCsvError(
            "Aucune ligne valide. Vérifiez les colonnes Nom, Prénom et E-mail."
          );
        } else {
          setCsvPreview(parsed);
        }
      } catch (err) {
        setCsvError(
          `Erreur de lecture : ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };
    reader.readAsText(file);
  };

  const handleImportCsv = async () => {
    if (csvPreview.length === 0) return;
    setImporting(true);
    setCsvError(null);
    try {
      await addBulk({ students: csvPreview });
      setCsvFile(null);
      setCsvPreview([]);
      alert(`Import réussi de ${csvPreview.length} élève(s).`);
    } catch (err) {
      setCsvError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const cancelCsv = () => {
    setCsvFile(null);
    setCsvPreview([]);
    setCsvError(null);
  };

  const filtered = useMemo(() => {
    const q = search
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim();
    const list = waitingStudents ?? [];
    if (!q) return list;
    return list.filter((s) => {
      const name = `${s.first_name} ${s.last_name}`
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");
      return name.includes(q) || s.email.toLowerCase().includes(q);
    });
  }, [waitingStudents, search]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div className="pay-header">
        <span className="pay-tag">Administration</span>
        <h1>Liste d'attente générale</h1>
        <p className="pay-subtitle">
          Gérez les élèves sur liste d'attente. La détection s'effectue par
          e-mail sur la page de validation.
        </p>
      </div>

      <div className="pay-grid">
        {/* Colonne gauche */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          <section className="pay-section">
            <div className="pay-section-head">
              <h2>Ajouter un élève</h2>
            </div>
            <form className="pay-form" onSubmit={handleSubmit}>
              <div className="pay-field">
                <label>Prénom</label>
                <input
                  className="pay-input"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Ex: Paul"
                />
              </div>
              <div className="pay-field">
                <label>Nom</label>
                <input
                  className="pay-input"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Ex: Bernard"
                />
              </div>
              <div className="pay-field">
                <label>Adresse mail</label>
                <input
                  className="pay-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Ex: paul.bernard@mail.com"
                />
              </div>
              {submitError && <p className="pay-error">{submitError}</p>}
              <button
                className="pay-btn pay-btn-dark"
                type="submit"
                disabled={submitting}
              >
                {submitting ? "Ajout en cours…" : "Ajouter à la liste"}
              </button>
            </form>
          </section>

          <section className="pay-section">
            <div className="pay-section-head">
              <h2>Importer un CSV</h2>
            </div>
            <div className="pay-form">
              {csvError && <p className="pay-error">{csvError}</p>}
              {!csvFile ? (
                <>
                  <p style={{ fontSize: "0.78rem", color: "#666" }}>
                    Colonnes attendues : <strong>Prénom</strong>,{" "}
                    <strong>Nom</strong>, <strong>Email</strong> (ou
                    équivalents).
                  </p>
                  <div className="pay-drop">
                    <input
                      type="file"
                      accept=".csv"
                      onChange={handleCsvChange}
                    />
                    <p style={{ fontWeight: 700, fontSize: "0.85rem" }}>
                      📁 Sélectionner un fichier .csv
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div
                    style={{
                      border: "1px solid rgba(0,0,0,0.2)",
                      padding: "0.5rem",
                      background: "rgba(0,0,0,0.02)",
                    }}
                  >
                    <p
                      style={{
                        fontFamily: "monospace",
                        fontWeight: 700,
                        fontSize: "0.8rem",
                      }}
                    >
                      📄 {csvFile.name}
                    </p>
                    <p
                      style={{
                        fontFamily: "monospace",
                        fontSize: "0.7rem",
                        color: "#999",
                      }}
                    >
                      {(csvFile.size / 1024).toFixed(1)} KB · {csvPreview.length}{" "}
                      élèves détectés
                    </p>
                  </div>
                  {csvPreview.length > 0 && (
                    <div className="pay-csv-preview">
                      {csvPreview.slice(0, 5).map((p, i) => (
                        <div key={i}>
                          {p.first_name} {p.last_name} ({p.email})
                        </div>
                      ))}
                      {csvPreview.length > 5 && (
                        <div style={{ fontStyle: "italic", color: "#999" }}>
                          … et {csvPreview.length - 5} autres
                        </div>
                      )}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      className="pay-btn pay-btn-dark"
                      onClick={handleImportCsv}
                      disabled={importing || csvPreview.length === 0}
                    >
                      {importing ? "Import…" : "Confirmer l'import"}
                    </button>
                    <button className="pay-btn" onClick={cancelCsv}>
                      Annuler
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>

        {/* Colonne droite */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div className="pay-toolbar">
            <input
              className="pay-input"
              style={{ flex: 1, minWidth: "12rem" }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher par nom, prénom ou email…"
            />
            {search && (
              <button className="pay-btn pay-btn-sm" onClick={() => setSearch("")}>
                Reset
              </button>
            )}
          </div>

          <section className="pay-section">
            <div className="pay-section-head">
              <h2>Élèves sur liste d'attente</h2>
              <span className="count">
                {filtered.length} élève{filtered.length > 1 ? "s" : ""}
              </span>
            </div>
            <div className="pay-section-body">
              {isLoading && <p className="pay-muted">Chargement…</p>}
              {!isLoading && filtered.length === 0 && (
                <p className="pay-muted" style={{ textAlign: "center" }}>
                  Aucun élève trouvé sur la liste d'attente.
                </p>
              )}
              {!isLoading &&
                filtered.map((student) => {
                  const isProcessed = (dossiers ?? []).some((d) => {
                    const se = student.email.toLowerCase();
                    return (
                      d.payer_email.toLowerCase() === se ||
                      (d.email && d.email.toLowerCase() === se)
                    );
                  });

                  if (editingId === student.id) {
                    return (
                      <div
                        className="pay-form"
                        key={student.id}
                        style={{ gap: "0.5rem" }}
                      >
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <input
                            className="pay-input"
                            value={editFirst}
                            onChange={(e) => setEditFirst(e.target.value)}
                            placeholder="Prénom"
                          />
                          <input
                            className="pay-input"
                            value={editLast}
                            onChange={(e) => setEditLast(e.target.value)}
                            placeholder="Nom"
                          />
                        </div>
                        <input
                          className="pay-input"
                          value={editEmail}
                          onChange={(e) => setEditEmail(e.target.value)}
                          placeholder="Email"
                        />
                        <div
                          style={{
                            display: "flex",
                            gap: "0.5rem",
                            justifyContent: "flex-end",
                          }}
                        >
                          <button
                            className="pay-btn pay-btn-sm pay-btn-dark"
                            onClick={() => saveEdit(student.id)}
                          >
                            Enregistrer
                          </button>
                          <button
                            className="pay-btn pay-btn-sm"
                            onClick={cancelEdit}
                          >
                            Annuler
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      className={`pay-row${isProcessed ? " processed" : ""}`}
                      key={student.id}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div className="pay-dossier-line">
                          <span className="pay-dossier-name">
                            {student.first_name} {student.last_name}
                          </span>
                          {isProcessed && (
                            <span className="pay-badge pay-badge-approved">
                              Traité
                            </span>
                          )}
                        </div>
                        <p
                          style={{
                            fontFamily: "monospace",
                            fontSize: "0.78rem",
                            color: "#999",
                          }}
                        >
                          {student.email}
                        </p>
                      </div>
                      <div style={{ display: "flex", gap: "0.35rem" }}>
                        <button
                          className="pay-btn pay-btn-sm"
                          onClick={() => startEdit(student)}
                        >
                          Modifier
                        </button>
                        <button
                          className="pay-btn pay-btn-sm pay-btn-danger"
                          onClick={() => remove(student.id)}
                        >
                          Retirer
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
