import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Save, Shield } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import EditUserDialog from "./EditUserDialog";
import UserAccessTable from "./UserAccessTable";
import {
  resolveDashboardTiles,
  type DashboardTileInput,
} from "../../config/tiles";

type ListedUser = FunctionReturnType<typeof api.users.listUsers>[number];

function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string" && data) return data;
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

export default function UsersAccessPanel() {
  const users = useQuery(api.users.listUsers);
  const dashboardConfiguration = useQuery(api.users.getDashboardConfiguration);
  const addUser = useMutation(api.users.addUser);
  const removeUser = useMutation(api.users.removeUser);
  const updateUserSettings = useMutation(api.users.updateUserSettings);

  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [isSubmittingUser, setIsSubmittingUser] = useState(false);
  const [addError, setAddError] = useState("");
  const [deletingUserId, setDeletingUserId] =
    useState<ListedUser["_id"] | null>(null);
  const [editingUser, setEditingUser] = useState<ListedUser | null>(null);
  const dashboardTiles = resolveDashboardTiles(
    dashboardConfiguration?.tiles as DashboardTileInput[] | undefined,
  );

  const handleAddUser = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = newUserEmail.trim();
    const name = newUserName.trim();
    if (!email || !name) return;

    setIsSubmittingUser(true);
    setAddError("");
    try {
      await addUser({ email, name });
      setNewUserEmail("");
      setNewUserName("");
    } catch (error) {
      setAddError(errorMessage(error, "Erreur lors de l'ajout."));
    } finally {
      setIsSubmittingUser(false);
    }
  };

  const handleDeleteUser = async (user: ListedUser) => {
    const label = user.name
      ? `${user.name} (${user.email || "email non renseigné"})`
      : user.email || "cet utilisateur";
    if (
      !window.confirm(
        `Supprimer ${label} ? Cette personne ne pourra plus se connecter.`,
      )
    ) {
      return;
    }

    setDeletingUserId(user._id);
    try {
      await removeUser({ userId: user._id });
    } catch (error) {
      window.alert(errorMessage(error, "Erreur lors de la suppression."));
    } finally {
      setDeletingUserId(null);
    }
  };

  return (
    <div className="users-access-panel">
      <section className="card glass-card user-add-card">
        <h2>
          <Shield aria-hidden="true" size={20} /> Ajouter un utilisateur
        </h2>
        <form className="user-add-form" onSubmit={handleAddUser}>
          <div>
            <label className="form-label" htmlFor="new-user-email">
              Email autorisé
            </label>
            <input
              id="new-user-email"
              type="email"
              className="input-field"
              placeholder="nom@exemple.com"
              value={newUserEmail}
              disabled={isSubmittingUser}
              required
              onChange={(event) => setNewUserEmail(event.target.value)}
            />
          </div>
          <div>
            <label className="form-label" htmlFor="new-user-name">
              Nom
            </label>
            <input
              id="new-user-name"
              type="text"
              className="input-field"
              placeholder="Jean Dupont"
              value={newUserName}
              disabled={isSubmittingUser}
              required
              onChange={(event) => setNewUserName(event.target.value)}
            />
          </div>
          <button
            type="submit"
            className="user-add-button"
            disabled={isSubmittingUser}
          >
            <Save aria-hidden="true" size={18} />
            {isSubmittingUser ? "Ajout…" : "Ajouter"}
          </button>
        </form>
        <p className="user-add-note">
          Aucun module n'est autorisé à la création. Attribuez explicitement
          les tuiles nécessaires au rôle réel de la personne.
        </p>
        {addError && (
          <p className="user-edit-error" role="alert" aria-live="assertive">
            {addError}
          </p>
        )}
      </section>

      <section className="card glass-card user-list-card">
        <div className="user-list-heading">
          <div>
            <span className="user-list-kicker">Mur des permissions</span>
            <h2>Utilisateurs existants</h2>
          </div>
          {users !== undefined && (
            <span className="user-count">
              {users.length} utilisateur{users.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <p className="user-list-intro">
          Chaque voie correspond à un module. Le libellé indique explicitement
          si l'accès est accordé.
        </p>
        <UserAccessTable
          users={users}
          dashboardTiles={dashboardTiles}
          deletingUserId={deletingUserId}
          onEdit={setEditingUser}
          onDelete={handleDeleteUser}
        />
      </section>

      <EditUserDialog
        user={editingUser}
        onDismiss={() => setEditingUser(null)}
        onSave={async (draft) => {
          await updateUserSettings(draft);
        }}
      />
    </div>
  );
}
