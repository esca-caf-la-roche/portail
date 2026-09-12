import { useState, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useOutletContext } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PaiementsDossiersContextValue } from "./Layout";

type ApprovedStudents = NonNullable<
  ReturnType<typeof useQuery<typeof api.paiements.getApprovedStudents>>
>;
type ApprovedStudent = ApprovedStudents[number];

function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

export default function ApprobationsPaiements() {
  const approvedStudents = useQuery(api.paiements.getApprovedStudents);
  const groups = useQuery(api.paiements.getGroups);
  const { dossiersTraites: dossiers } = useOutletContext<PaiementsDossiersContextValue>();

  const addStudent = useMutation(api.paiements.addApprovedStudent);
  const updateStudent = useMutation(api.paiements.updateApprovedStudent);
  const deleteStudent = useMutation(api.paiements.deleteApprovedStudent);

  // Formulaire d'ajout
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [groupId, setGroupId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Édition
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFirst, setEditFirst] = useState("");
  const [editLast, setEditLast] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editGroup, setEditGroup] = useState("");

  const approvalGroups = useMemo(
    () => (groups ?? []).filter((g) => g.requires_approval),
    [groups]
  );

  const studentsByGroup = useMemo(() => {
    const map = new Map<string, ApprovedStudent[]>();
    for (const g of approvalGroups) map.set(g._id, []);
    for (const s of approvedStudents ?? []) {
      if (map.has(s.group_id)) map.get(s.group_id)!.push(s);
    }
    return map;
  }, [approvedStudents, approvalGroups]);

  const isLoading =
    approvedStudents === undefined || groups === undefined;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim() || !groupId) {
      setSubmitError("Veuillez remplir le prénom, le nom et le groupe.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await addStudent({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim(),
        group_id: groupId as Id<"groups">,
      });
      setFirstName("");
      setLastName("");
      setEmail("");
      setGroupId("");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (s: ApprovedStudent) => {
    setEditingId(s.id);
    setEditFirst(s.first_name);
    setEditLast(s.last_name);
    setEditEmail(s.email);
    setEditGroup(s.group_id);
  };
  const cancelEdit = () => {
    setEditingId(null);
  };
  const saveEdit = async (id: string) => {
    if (!editFirst.trim() || !editLast.trim() || !editGroup) {
      alert("Veuillez remplir le prénom, le nom et le groupe.");
      return;
    }
    try {
      await updateStudent({
        id: id as Id<"approved_students">,
        first_name: editFirst.trim(),
        last_name: editLast.trim(),
        email: editEmail.trim(),
        group_id: editGroup as Id<"groups">,
      });
      cancelEdit();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };
  const remove = async (id: string) => {
    if (!window.confirm("Retirer cet élève de la liste ?")) return;
    try {
      await deleteStudent({ id: id as Id<"approved_students"> });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div className="pay-header">
        <span className="pay-tag">Administration</span>
        <h1>Élèves des groupes sous approbation</h1>
        <p className="pay-subtitle">
          Gérez la liste des élèves autorisés à s'inscrire dans les groupes
          nécessitant une approbation du moniteur.
        </p>
      </div>

      <div className="pay-grid">
        {/* Colonne gauche : ajout */}
        <section className="pay-section">
          <div className="pay-section-head">
            <h2>Ajouter un élève</h2>
          </div>
          <div className="pay-section-body">
            {approvalGroups.length === 0 ? (
              <p className="pay-muted">
                Aucun groupe "sous approbation" n'est configuré. Activez cette
                option sur un groupe dans la page Config.
              </p>
            ) : (
              <form className="pay-form" onSubmit={handleSubmit}>
                <div className="pay-field">
                  <label>Prénom</label>
                  <input
                    className="pay-input"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Ex: Jean"
                  />
                </div>
                <div className="pay-field">
                  <label>Nom</label>
                  <input
                    className="pay-input"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Ex: Dupont"
                  />
                </div>
                <div className="pay-field">
                  <label>Adresse mail (optionnelle)</label>
                  <input
                    className="pay-input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Ex: jean.dupont@mail.com"
                  />
                </div>
                <div className="pay-field">
                  <label>Groupe concerné</label>
                  <select
                    className="pay-select"
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                  >
                    <option value="">-- Choisir un groupe --</option>
                    {approvalGroups.map((g) => (
                      <option key={g._id} value={g._id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
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
            )}
          </div>
        </section>

        {/* Colonne droite : listes par groupe */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {isLoading && <p className="pay-muted">Chargement des données…</p>}

          {!isLoading && approvalGroups.length === 0 && (
            <section className="pay-section">
              <p className="pay-muted" style={{ textAlign: "center" }}>
                Aucun groupe sous approbation. Activez l'approbation sur vos
                groupes dans la page Config.
              </p>
            </section>
          )}

          {!isLoading &&
            approvalGroups.map((group) => {
              const groupStudents = studentsByGroup.get(group._id) ?? [];
              return (
                <section className="pay-section" key={group._id}>
                  <div className="pay-section-head">
                    <h2>Groupe : {group.name}</h2>
                    <span className="count">
                      {groupStudents.length} élève
                      {groupStudents.length > 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="pay-section-body">
                    {groupStudents.length === 0 ? (
                      <p className="pay-muted">
                        Aucun élève approuvé dans ce groupe.
                      </p>
                    ) : (
                      groupStudents.map((student) => {
                        const isProcessed = (dossiers ?? []).some((d) => {
                          if (!d.group_ids.includes(student.group_id))
                            return false;
                          if (student.email) {
                            const se = student.email.toLowerCase();
                            if (
                              d.payer_email.toLowerCase() === se ||
                              (d.email && d.email.toLowerCase() === se)
                            )
                              return true;
                          }
                          return (
                            normalise(student.first_name) ===
                              normalise(d.first_name) &&
                            normalise(student.last_name) ===
                              normalise(d.last_name)
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
                              <select
                                className="pay-select"
                                value={editGroup}
                                onChange={(e) => setEditGroup(e.target.value)}
                              >
                                {approvalGroups.map((g) => (
                                  <option key={g._id} value={g._id}>
                                    {g.name}
                                  </option>
                                ))}
                              </select>
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
                              <p className="pay-dossier-name">
                                {student.first_name} {student.last_name}
                              </p>
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
                      })
                    )}
                  </div>
                </section>
              );
            })}
        </div>
      </div>
    </div>
  );
}
