import { Edit2, Trash2 } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import {
  isMandatoryTile,
  type DashboardTile,
  unknownTileIds,
  withMandatoryTiles,
} from "../../config/tiles";

type ListedUser = FunctionReturnType<typeof api.users.listUsers>[number];

interface UserAccessTableProps {
  users: ListedUser[] | undefined;
  dashboardTiles: DashboardTile[];
  deletingUserId: ListedUser["_id"] | null;
  onEdit: (user: ListedUser) => void;
  onDelete: (user: ListedUser) => void;
}

export default function UserAccessTable({
  users,
  dashboardTiles,
  deletingUserId,
  onEdit,
  onDelete,
}: UserAccessTableProps) {
  if (users === undefined) {
    return (
      <div className="user-table-state" role="status" aria-live="polite">
        Chargement des utilisateurs…
      </div>
    );
  }

  if (users.length === 0) {
    return (
      <div className="user-table-state">
        Aucun utilisateur staff. Utilisez le formulaire ci-dessus pour en
        ajouter un.
      </div>
    );
  }

  return (
    <div className="user-access-table-wrap">
      <table className="user-access-table">
        <thead>
          <tr>
            <th scope="col">Utilisateur</th>
            <th scope="col">Rôle</th>
            <th scope="col">Accès aux modules</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const allowedTiles = withMandatoryTiles(
              user.settings?.allowedTiles || [],
            );
            const unknownTiles = unknownTileIds(allowedTiles);
            const isDeleting = deletingUserId === user._id;

            return (
              <tr key={user._id}>
                <td data-label="Utilisateur">
                  <strong className="user-identity-name">
                    {user.name || "Nom non renseigné"}
                  </strong>
                  <span className="user-identity-email">{user.email}</span>
                </td>
                <td data-label="Rôle">
                  <span
                    className={`user-role-badge${
                      user.settings?.role === "admin" ? " is-admin" : ""
                    }`}
                  >
                    {user.settings?.role === "admin"
                      ? "Administrateur"
                      : "Utilisateur"}
                  </span>
                </td>
                <td data-label="Accès">
                  <div className="user-permission-board">
                    {dashboardTiles.map((tile, index) => {
                      const isAllowed = allowedTiles.includes(tile.id);
                      return (
                        <div
                          className={`user-permission-card${
                            isAllowed ? " is-allowed" : ""
                          }`}
                          key={tile.id}
                        >
                          <span className="user-permission-route" aria-hidden="true">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span>
                            <strong>{tile.label}</strong>
                            <small>
                              {isMandatoryTile(tile.id)
                                ? "Obligatoire"
                                : isAllowed
                                  ? "Autorisé"
                                  : "Non autorisé"}
                            </small>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {unknownTiles.length > 0 && (
                    <div className="user-unknown-inline">
                      <strong>Accès inconnus :</strong>{" "}
                      {unknownTiles.join(", ")}
                    </div>
                  )}
                </td>
                <td data-label="Actions">
                  <div className="user-row-actions">
                    <button
                      type="button"
                      className="user-edit-button"
                      aria-label={`Modifier les accès de ${user.name || user.email}`}
                      onClick={() => onEdit(user)}
                    >
                      <Edit2 aria-hidden="true" size={18} />
                      Modifier
                    </button>
                    <button
                      type="button"
                      className="user-delete-button"
                      aria-label={`Supprimer ${user.name || user.email}`}
                      disabled={deletingUserId !== null}
                      onClick={() => onDelete(user)}
                    >
                      <Trash2 aria-hidden="true" size={18} />
                      {isDeleting ? "Suppression…" : "Supprimer"}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
