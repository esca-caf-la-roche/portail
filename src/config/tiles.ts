export const TILE_OPTIONS = [
  { id: "compta", label: "Comptabilité", description: "Gérez les transactions, prévisionnels et analyses.", defaultColor: "bg-info" },
  { id: "paiements", label: "Paiements Escalade", description: "Suivi des paiements pour les cours d'escalade.", defaultColor: "bg-success" },
  { id: "budget", label: "Budget prévisionnel", description: "Masse salariale et simulation d'augmentations.", defaultColor: "bg-warning" },
  { id: "abonnements", label: "Abonnements Escalade", description: "Nouvelles inscriptions aux créneaux autonomes, demandes, compteur et tests.", defaultColor: "bg-primary" },
  { id: "licences_cours", label: "Licences élèves en cours", description: "Vérifie les élèves en cours sans licence valide pour la saison.", defaultColor: "bg-danger" },
  { id: "contacts_cours", label: "Contacts élèves en cours", description: "Retrouvez les coordonnées des élèves et contactez un groupe de cours.", defaultColor: "bg-info" },
  { id: "remboursements_eleves", label: "Remboursements élèves", description: "Suivez les avances compétition et stage jusqu’au rapprochement HelloAsso.", defaultColor: "bg-warning" },
  { id: "samedis", label: "Samedis après-midi", description: "Planifiez les permanences du samedi et voyez immédiatement qui prend chaque date.", defaultColor: "bg-orange" },
  { id: "planning_salaries_samedis", label: "Planning salariés du samedi", description: "Attribuez les groupes du samedi et synchronisez leurs ressources Google Calendar.", defaultColor: "bg-lime" },
] as const;

export type TileId = (typeof TILE_OPTIONS)[number]["id"];

const KNOWN_TILE_IDS = new Set<string>(TILE_OPTIONS.map(({ id }) => id));

export function isKnownTileId(tileId: string): tileId is TileId {
  return KNOWN_TILE_IDS.has(tileId);
}

export function unknownTileIds(tileIds: readonly string[]): string[] {
  return tileIds.filter((tileId) => !isKnownTileId(tileId));
}

export const TILE_COLOR_OPTIONS = [
  { value: "bg-info", label: "Bleu" },
  { value: "bg-success", label: "Vert" },
  { value: "bg-warning", label: "Jaune" },
  { value: "bg-primary", label: "Violet" },
  { value: "bg-danger", label: "Rouge" },
  { value: "bg-orange", label: "Orange" },
  { value: "bg-pink", label: "Rose" },
  { value: "bg-purple", label: "Pourpre" },
  { value: "bg-lime", label: "Citron vert" },
] as const;

export type TileColorClass = (typeof TILE_COLOR_OPTIONS)[number]["value"];

export type DashboardTileInput = {
  id: string;
  color?: string;
  label?: string;
  description?: string;
};

export type DashboardTile = {
  id: TileId;
  color: TileColorClass;
  label: string;
  description: string;
};

const KNOWN_TILE_COLORS = new Set<string>(
  TILE_COLOR_OPTIONS.map(({ value }) => value),
);

function textOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function isKnownTileColor(color: string | undefined): color is TileColorClass {
  return color !== undefined && KNOWN_TILE_COLORS.has(color);
}

/**
 * Normalise la configuration globale, y compris les enregistrements créés
 * avant la personnalisation des libellés et descriptions.
 */
export function resolveDashboardTiles(
  configuredTiles?: readonly DashboardTileInput[] | null,
): DashboardTile[] {
  const configuredById = new Map<string, DashboardTileInput>();
  const orderedIds: TileId[] = [];

  for (const tile of configuredTiles ?? []) {
    if (!isKnownTileId(tile.id) || configuredById.has(tile.id)) continue;
    configuredById.set(tile.id, tile);
    orderedIds.push(tile.id);
  }

  for (const tile of TILE_OPTIONS) {
    if (!configuredById.has(tile.id)) orderedIds.push(tile.id);
  }

  return orderedIds.map((id) => {
    const tile = TILE_OPTIONS.find((option) => option.id === id)!;
    const configured = configuredById.get(id);
    return {
      id: tile.id,
      color: isKnownTileColor(configured?.color)
        ? configured.color
        : tile.defaultColor,
      label: textOrDefault(configured?.label, tile.label),
      description: textOrDefault(configured?.description, tile.description),
    };
  });
}
